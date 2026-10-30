/**
 * 单 IP 全链路测试
 *
 * ## 解决什么问题
 *
 * 优选一次要扫几千个候选、跑几分钟。但日常最高频的问题是**「这一个 IP 到底行不行」**：
 * 换了新 IP、别人给了一个 IP、某个节点突然变 -1 —— 为了一个 IP 重扫一遍完全不划算。
 *
 * 这里把已有的六种探针按「客户端真实建连顺序」串起来，逐阶段给结论：
 *
 * ```
 * TCP 建连 → TLS 握手 → WS 101 → PONG 校验 → 下行测速 → 真实隧道
 * ```
 *
 * 每一阶段都回答一个具体问题，失败时给可读原因，而不是笼统的「连不上」。
 *
 * ## 为什么复用 scan 的探针，而不是另写一套
 *
 * 探针里积累了大量真机结论（TLS 耗时才是 -1 的根因、单流测速会低估 2.4 倍、
 * 必须校验 x-probe-bytes 才能确认是对端探针）。另写一套必然丢掉这些判断，
 * 结果就是「单测说能用、实际导入 -1」。
 */
import * as net from 'node:net'

import {
  measureProbeThroughput,
  probeTlsHandshake,
  probeWs101,
  probeWsPing,
  verifyTunnel,
} from './true-probe'

/** 单个阶段的结论 */
export interface StageResult {
  /** 阶段名（中文，直接给人看） */
  stage: string
  ok: boolean
  /** 耗时（ms）；不适用时为 undefined */
  ms?: number
  /** 成功时的补充信息（ALPN、机房、速度…） */
  detail?: string
  /** 失败原因 */
  error?: string
}

export interface SingleTestOptions {
  ip: string
  port: number
  /** 数据面域名（TLS SNI + HTTP Host） */
  host: string
  /** WS 校验路径 */
  path: string
  /** 单阶段超时 */
  timeoutMs: number
  /** 是否做下行测速（会消耗流量） */
  speed: boolean
  /** 测速请求字节数 */
  speedBytes: number
  /** 隧道校验凭据（任选其一；都不给则跳过该阶段） */
  uuid?: string
  trojanPassword?: string
  verifyTargetHost: string
  verifyTargetPort: number
  /** 每完成一个阶段回调一次（便于边跑边打印） */
  onStage?: (result: StageResult) => void
}

/** TCP 建连探测 */
function probeTcp(ip: string, port: number, timeoutMs: number): Promise<StageResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (result: Omit<StageResult, 'stage' | 'ms'>): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ stage: 'TCP 建连', ms: Date.now() - started, ...result })
    }
    const socket = net.connect({ host: ip, port })
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: '超时' }))
    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', (err: Error) => finish({ ok: false, error: err.message }))
  })
}

/**
 * 跑完整链路。
 *
 * 前一阶段失败就停 —— 后面的阶段依赖它，继续跑只会得到一串「也失败」的噪音。
 */
export async function runSingleTest(options: SingleTestOptions): Promise<StageResult[]> {
  const {
    ip,
    port,
    host,
    path,
    timeoutMs,
    speed,
    speedBytes,
    uuid,
    trojanPassword,
    verifyTargetHost,
    verifyTargetPort,
    onStage,
  } = options

  const results: StageResult[] = []
  const push = (result: StageResult): void => {
    results.push(result)
    onStage?.(result)
  }

  // 1) TCP
  const tcp = await probeTcp(ip, port, timeoutMs)
  push(tcp)
  if (!tcp.ok) return results

  // 2) TLS 握手（决定客户端会不会 -1 的关键指标）
  const tls = await probeTlsHandshake(ip, port, host, timeoutMs)
  const tlsOk = tls.tlsMs >= 0 && !tls.error
  push({
    stage: 'TLS 握手',
    ok: tlsOk,
    ms: tls.tlsMs >= 0 ? tls.tlsMs : undefined,
    detail: tls.alpn ? `ALPN=${tls.alpn}` : undefined,
    error: tlsOk ? undefined : (tls.error ?? '握手失败'),
  })
  if (!tlsOk) return results

  // 3) WebSocket 101
  const ws = await probeWs101(ip, port, host, timeoutMs, path)
  push({
    stage: 'WebSocket 101',
    ok: ws.ok,
    ms: ws.latencyMs,
    detail: ws.colo ? `机房 ${ws.colo}` : undefined,
    error: ws.ok ? undefined : (ws.error ?? `HTTP ${ws.status}`),
  })
  if (!ws.ok) return results

  // 4) PONG 内容校验（排除「101 通过但其实是别的东西」）
  const ping = await probeWsPing(ip, port, host, timeoutMs, path)
  push({
    stage: 'PONG 内容校验',
    ok: ping.ok,
    ms: ping.latencyMs,
    detail: ping.probeColo ? `机房 ${ping.probeColo}` : undefined,
    error: ping.ok ? undefined : (ping.error ?? '未收到 PONG'),
  })

  // 5) 下行测速（可选：耗流量）
  if (speed) {
    const throughput = await measureProbeThroughput({
      ip,
      port,
      host,
      bytes: speedBytes,
      path,
      connections: 8,
      durationMs: 6000,
      timeoutMs: Math.max(timeoutMs, 15000),
      token: uuid,
    })
    push({
      stage: '下行测速',
      ok: throughput.ok,
      detail: throughput.ok ? `${throughput.steadyMBps.toFixed(2)} MB/s（稳态）` : undefined,
      error: throughput.ok ? undefined : (throughput.error ?? '测速失败'),
    })
  }

  // 6) 真实隧道（可选：需要凭据）
  if (uuid || trojanPassword) {
    const tunnel = await verifyTunnel({
      ip,
      port,
      host,
      wsPath: path,
      uuid,
      trojanPassword,
      targetHost: verifyTargetHost,
      targetPort: verifyTargetPort,
      timeoutMs: Math.max(timeoutMs, 8000),
    })
    push({
      stage: '真实隧道',
      ok: tunnel.ok,
      ms: tunnel.latencyMs,
      detail: tunnel.ok ? `访问 ${verifyTargetHost} 收到数据` : undefined,
      error: tunnel.ok ? undefined : `${tunnel.stage ?? '未知阶段'}：${tunnel.error ?? '失败'}`,
    })
  }

  return results
}

/** 一行结论：全部通过 / 卡在第几阶段 */
export function summarizeStages(results: StageResult[]): string {
  const failed = results.find((r) => !r.ok)
  if (!failed) return `全部 ${results.length} 项通过`
  return `卡在「${failed.stage}」：${failed.error ?? '未知原因'}`
}
