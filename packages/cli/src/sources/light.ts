/**
 * Phase 3 · 轻量校验：只做 TCP 三次握手 + TLS 握手，跑到 TLS 即停。
 *
 * ## 边界（计划 §4 Phase 3）
 *
 * 不发 WS 升级、不做 PING/PONG、不测速、不回填。校验结果只写进池里的
 * `lightCheck`，`status` 仍是 `pending` —— `active` 只能由 Phase 4 完整优选写入。
 *
 * ## 四道成本闸门
 *
 * 外部清单一次可能给上千个 IP，不能让同步把用户机器拖垮：
 *   - 单次最多校验 `LIGHT_MAX_PER_SYNC` 个（默认 100）
 *   - 并发上限 `LIGHT_CONCURRENCY`（默认 8）
 *   - 单连接超时 `LIGHT_CONNECT_TIMEOUT_MS`（默认 2s）
 *   - 整轮总时长 `LIGHT_TOTAL_TIMEOUT_MS`（默认 30s），到点直接收工
 *
 * 已经入池且 `lightCheck` 未过期的候选直接跳过，避免每次同步重复测同一批地址。
 *
 * ## 为什么失败也写进池
 *
 * 轻量校验失败的候选仍保留（带上 `tcpOk/tlsOk=false`），Phase 4 取样时会过滤。
 * 物理删掉的话，下一轮采集又会把它捡回来再测一遍，白烧一轮连接预算。
 */
import { Socket } from 'node:net'
import { loadConfig } from '../menu/store'
import { probeTlsHandshake } from '../scan/true-probe'
import {
  normalizeCandidateKey,
  parsePool,
  readPoolRaw,
  type CandidateInput,
  type ExternalPool,
  type LightCheck,
} from './pool'

export const LIGHT_MAX_PER_SYNC = 100
export const LIGHT_CONCURRENCY = 8
export const LIGHT_CONNECT_TIMEOUT_MS = 2_000
export const LIGHT_TOTAL_TIMEOUT_MS = 30_000
/** lightCheck 有效期：7 天内不重复校验 */
export const LIGHT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000

export interface LightCheckOptions {
  /** SNI。缺省取本地配置的数据面域名，再兜底 cloudflare.com */
  sni?: string
  maxPerSync?: number
  concurrency?: number
  connectTimeoutMs?: number
  totalTimeoutMs?: number
  now?: number
  /** 测试注入：替换 TCP 探测 */
  tcpProbe?: (ip: string, port: number, timeoutMs: number) => Promise<boolean>
  /** 测试注入：替换 TLS 探测 */
  tlsProbe?: (ip: string, port: number, host: string, timeoutMs: number) => Promise<{ ok: boolean; tlsMs: number }>
}

/** 只做三次握手的 TCP 探测（TLS 用的是 true-probe 的 probeTlsHandshake）。 */
export function tcpProbeOnce(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('error', () => done(false))
    socket.once('connect', () => done(true))
    try {
      socket.connect(port, ip)
    } catch {
      done(false)
    }
  })
}

async function defaultTlsProbe(
  ip: string,
  port: number,
  host: string,
  timeoutMs: number
): Promise<{ ok: boolean; tlsMs: number }> {
  const r = await probeTlsHandshake(ip, port, host, timeoutMs)
  // ⚠️ 别只看 tlsMs：失败时 true-probe 返回的也是正的耗时，靠 error 字段区分
  return { ok: !r.error, tlsMs: r.tlsMs }
}

function needsCheck(key: string, now: number, existing: ExternalPool): boolean {
  const found = existing.candidates.find((c) => c.key === key)
  if (!found || !found.lightCheck) return true
  return now - found.lightCheck.at > LIGHT_REFRESH_MS
}

/**
 * 对本轮即将入池的候选做 TCP/TLS 轻量校验，返回补好 `lightCheck` 的输入。
 *
 * 该函数**只在锁外**被调用（manager.ts 的 `lightCheck` 钩子），不写任何文件；
 * 真正落盘由 manager 统一在目录锁内完成。
 */
export async function lightCheckCandidates(
  inputs: CandidateInput[],
  options: LightCheckOptions = {}
): Promise<CandidateInput[]> {
  const now = options.now ?? Date.now()
  const max = options.maxPerSync ?? LIGHT_MAX_PER_SYNC
  const concurrency = Math.max(1, options.concurrency ?? LIGHT_CONCURRENCY)
  const connectTimeout = options.connectTimeoutMs ?? LIGHT_CONNECT_TIMEOUT_MS
  const totalTimeout = options.totalTimeoutMs ?? LIGHT_TOTAL_TIMEOUT_MS
  const sni = options.sni || loadConfig().dataHost || 'cloudflare.com'
  const tcpProbe = options.tcpProbe ?? tcpProbeOnce
  const tlsProbe = options.tlsProbe ?? defaultTlsProbe

  const pool = parsePool(readPoolRaw())
  const out = inputs.map((i) => ({ ...i }))
  // 只挑「新发现 / lightCheck 已过期」的候选，且整轮有硬上限
  const pending: number[] = []
  for (let i = 0; i < out.length && pending.length < max; i++) {
    const input = out[i]!
    const key = normalizeCandidateKey(input.ip, input.port ?? 443)
    if (!key) continue // 非法 IP 交给 upsertCandidates 统一拒绝
    if (needsCheck(key, now, pool)) pending.push(i)
  }

  const deadline = Date.now() + totalTimeout
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline) return
      const idx = cursor++
      if (idx >= pending.length) return
      const input = out[pending[idx]!]!
      const port = input.port ?? 443
      const tcpOk = await tcpProbe(input.ip, port, connectTimeout)
      let tlsOk = false
      let tlsMs = 0
      if (tcpOk) {
        const tls = await tlsProbe(input.ip, port, sni, connectTimeout)
        tlsOk = tls.ok
        tlsMs = tls.tlsMs
      }
      const check: LightCheck = {
        tcpOk,
        tlsOk,
        // 字段顺序必须与 Go struct 一致：tlsMs 排在 at 之前
        ...(tlsOk && tlsMs > 0 ? { tlsMs } : {}),
        at: now,
      }
      input.lightCheck = check
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  return out
}
