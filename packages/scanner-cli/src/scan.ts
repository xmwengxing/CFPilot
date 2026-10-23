/**
 * 三阶真连接扫描器
 *
 * 阶段一：高并发 TCP 握手初筛（只保留能建连且延迟够低的 IP）
 * 阶段二：强制携带用户域名作为 TLS SNI / HTTP Host，验证是否返回 101 Switching Protocols
 * 阶段三：**只对通过 101 校验的 IP** 测量真实下行速度
 *
 * ## 为什么阶段三必须先过阶段二
 *
 * 测速有两种方式，但都只回答「这个 IP 有多快」，不回答「这个 IP 能不能服务你的域名」。
 * 若跳过阶段二直接按速度排序，就会选出「速度很快但导入客户端全是 -1」的 IP。
 * 因此阶段二是**强制前置**，测速只在它筛出的集合里做。
 *
 * ## 两种测速方式的取舍
 *
 * | 方式 | 要求 | 通用性 | 忠实度 |
 * |------|------|--------|--------|
 * | `probe` 走目标项目探针端点 | 目标须提供 `/__edge_probe` 类端点 | 差（只适用 CFPilot） | 高（走代理真实路径） |
 * | `url` 走公开测速地址 | 无 | 好（任何项目） | 中（测的是到 CF 边缘的带宽） |
 *
 * 两种都跑在「已通过 101 校验的 IP」上，所以都不会产出 -1 节点。
 */
import * as net from 'node:net'
import {
  probeWs101,
  measureDownload,
  measureThroughput,
  type WsProbeResult,
  type DownloadResult,
} from './true-probe'
import { parseSpeedUrl, withBytes, schemeForPort, DEFAULT_SPEED_URL } from './speed-url'
import { countryOfColo, normalizeCountryFilter } from './countries'

export interface ScanOptions {
  /** Worker 域名（作为 SNI / Host） */
  host: string
  /** 端口 */
  port: number
  /** 候选 IP 列表 */
  candidates: string[]
  /**
   * 国家 / 地区过滤（可多选，如 ['HK','JP']；空 / 不传 = 全量）。
   *
   * 机房信息来自阶段二的 101 握手响应，因此在 wsOk 之后过滤：
   * 只让匹配地区的候选进入测速，避免把测速额度浪费在不需要的地区。
   * 筛完为空时**忽略该筛选**（不阻断），并提示调大采样数。
   */
  countries?: string[]
  /** 阶段一并发 */
  concurrency?: number
  /** 阶段一超时（ms） */
  tcpTimeoutMs?: number
  /** 阶段一保留的最大延迟（ms），0 表示不限 */
  maxLatencyMs?: number
  /** 进入阶段二的候选数量 */
  probeLimit?: number
  /** 阶段二并发 */
  probeConcurrency?: number
  /** 阶段二超时（ms） */
  probeTimeoutMs?: number
  /** 进入阶段三的候选数量 */
  speedLimit?: number
  /** 阶段三并发 */
  speedConcurrency?: number
  /** 阶段三超时（ms） */
  speedTimeoutMs?: number
  /** 测速字节数 */
  speedBytes?: number
  /** 阶段二校验的 WebSocket 路径（默认 /__edge_probe；对接其它项目时填它的 WS 路径） */
  wsPath?: string
  /** probe 模式的测速路径（默认 /__edge_probe） */
  probePath?: string
  /** 测速方式：probe = 目标项目探针端点；url = 公开测速地址。默认 probe */
  speedMode?: 'probe' | 'url'
  /** url 模式的测速地址（不含协议也行，如 speed.cloudflare.com/__down?bytes=104857600） */
  speedUrl?: string
  /** 测速并发连接数（url 模式）：单连接受 TCP 窗口限制，多连接更接近真实带宽 */
  speedConnections?: number
  /** 测速时长（ms，url 模式） */
  speedDurationMs?: number
  /** 跳过测速，只按延迟排序 */
  skipSpeed?: boolean
  /** 最终返回条数 */
  top?: number
  /** 进度回调 */
  onProgress?: (event: ScanEvent) => void
}

export type ScanEvent =
  | { type: 'stage'; stage: number; name: string; total: number }
  | { type: 'progress'; stage: number; done: number; total: number; message?: string }
  | { type: 'result'; entry: ScanEntry }
  | { type: 'done'; count: number }
  | { type: 'error'; message: string }

export interface ScanEntry {
  ip: string
  port: number
  colo: string
  latency: number
  speed: number
}

export interface ScanSummary {
  entries: ScanEntry[]
  stats: {
    candidates: number
    tcpOk: number
    wsOk: number
    speedOk: number
    elapsedMs: number
    /** 生效的国家筛选（空 = 未筛选或筛选被忽略） */
    countries: string[]
    /** 国家筛选后进入测速的候选数（未筛选时 = wsOk） */
    wsFiltered: number
  }
}

interface TcpResult {
  ip: string
  ok: boolean
  latency: number
}

async function tcpPing(ip: string, port: number, timeoutMs: number): Promise<TcpResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const socket = new net.Socket()
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ ip, ok, latency: Date.now() - started })
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.connect(port, ip)
  })
}

async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return out
}

/** 执行三阶扫描 */
export async function runScan(options: ScanOptions): Promise<ScanSummary> {
  const started = Date.now()
  const concurrency = options.concurrency ?? 300
  const tcpTimeoutMs = options.tcpTimeoutMs ?? 1200
  const maxLatencyMs = options.maxLatencyMs ?? 0
  const probeLimit = options.probeLimit ?? 120
  const probeConcurrency = options.probeConcurrency ?? 24
  const probeTimeoutMs = options.probeTimeoutMs ?? 3000
  const speedLimit = options.speedLimit ?? 30
  const speedConcurrency = options.speedConcurrency ?? 4
  const speedTimeoutMs = options.speedTimeoutMs ?? 12000
  const speedBytes = options.speedBytes ?? 5 * 1024 * 1024
  const top = options.top ?? 15

  const candidates = options.candidates
  const report = options.onProgress ?? (() => {})

  // ---- 阶段一：TCP 握手初筛 ----
  report({ type: 'stage', stage: 1, name: 'TCP 握手初筛', total: candidates.length })
  let done = 0
  const tcpResults = await pool(candidates, concurrency, async (ip) => {
    const result = await tcpPing(ip, options.port, tcpTimeoutMs)
    done++
    if (done % 500 === 0 || done === candidates.length) {
      report({
        type: 'progress',
        stage: 1,
        done,
        total: candidates.length,
        message: `TCP 初筛 ${done}/${candidates.length}`,
      })
    }
    return result
  })

  const tcpOk = tcpResults.filter((r) => r.ok)
  const filtered = maxLatencyMs > 0 ? tcpOk.filter((r) => r.latency <= maxLatencyMs) : tcpOk
  const stage1 = filtered.sort((a, b) => a.latency - b.latency).slice(0, probeLimit)

  // ---- 阶段二：WebSocket 101 真连接校验 ----
  report({ type: 'stage', stage: 2, name: 'WebSocket 101 真连接校验', total: stage1.length })
  let probeDone = 0
  const probeResults = await pool(stage1, probeConcurrency, async (item) => {
    const result: WsProbeResult = await probeWs101(item.ip, options.port, options.host, probeTimeoutMs, options.wsPath ?? '/__edge_probe')
    probeDone++
    report({
      type: 'progress',
      stage: 2,
      done: probeDone,
      total: stage1.length,
      message: `101 校验 ${probeDone}/${stage1.length}${result.ok ? ` ✓ ${result.colo}` : ''}`,
    })
    return { ...item, probe: result }
  })

  const wsOk = probeResults.filter((r) => r.probe.ok)

  // ---- 国家 / 地区过滤（可选，作用于已识别机房的候选）----
  //
  // 为什么放在这里：机房（colo）只有 101 握手响应里才有，TCP 阶段无从得知。
  // 筛完为空说明采样不足或该地区候选太少——此时忽略筛选而不是返回空结果，
  // 与订阅侧 filterByCountries 的回落语义保持一致。
  const countryFilter = normalizeCountryFilter(options.countries ?? [])
  let wsFiltered = wsOk
  let appliedCountries: string[] = []
  if (countryFilter.length > 0 && wsOk.length > 0) {
    const matched = wsOk.filter((r) => countryFilter.includes(countryOfColo(r.probe.colo || '')))
    if (matched.length > 0) {
      wsFiltered = matched
      appliedCountries = countryFilter
      report({
        type: 'progress',
        stage: 2,
        done: wsOk.length,
        total: wsOk.length,
        message: `国家筛选 ${countryFilter.join('/')}：保留 ${matched.length}/${wsOk.length}，进入测速`,
      })
    } else {
      report({
        type: 'progress',
        stage: 2,
        done: wsOk.length,
        total: wsOk.length,
        message: `国家筛选 ${countryFilter.join('/')} 后无候选，已忽略（采样太小？调到 500~1000 再试）`,
      })
    }
  }

  const stage2 = wsFiltered.sort((a, b) => a.latency - b.latency).slice(0, speedLimit)

  // ---- 阶段三：真实下行测速（可用 --no-speed 跳过） ----
  //
  // 两种方式都只作用于**已通过 101 校验**的 stage2，因此不会产出
  // 「速度快但不能服务你的域名」的 -1 节点。
  let speedResults: Array<{
    ip: string
    ok: boolean
    latency: number
    probe: WsProbeResult
    speed?: number
  }>

  const speedMode = options.speedMode ?? 'probe'

  if (options.skipSpeed) {
    report({ type: 'stage', stage: 3, name: '跳过测速（按延迟排序）', total: stage2.length })
    speedResults = stage2.map((r) => ({ ...r }))
  } else if (speedMode === 'url') {
    report({ type: 'stage', stage: 3, name: '真实下行速度测试（公开测速地址）', total: stage2.length })
    const parsedUrl = parseSpeedUrl(options.speedUrl ?? DEFAULT_SPEED_URL, schemeForPort(options.port))
    const requestPath = withBytes(parsedUrl, options.speedBytes ?? 104857600)
    let speedDone = 0
    speedResults = await pool(stage2, speedConcurrency, async (item) => {
      const result = await measureThroughput({
        ip: item.ip,
        port: options.port,
        sniHost: parsedUrl.host,
        requestHost: parsedUrl.host,
        path: requestPath,
        connections: options.speedConnections ?? 3,
        durationMs: options.speedDurationMs ?? 6000,
        timeoutMs: options.speedTimeoutMs ?? 20000,
      })
      speedDone++
      report({
        type: 'progress',
        stage: 3,
        done: speedDone,
        total: stage2.length,
        message: `测速 ${speedDone}/${stage2.length} ${result.peakMBps.toFixed(1)} MB/s`,
      })
      return { ...item, speed: result.ok ? result.peakMBps : 0 }
    })
  } else {
    report({ type: 'stage', stage: 3, name: '真实下行速度测试（项目探针端点）', total: stage2.length })
    let speedDone = 0
    speedResults = await pool(stage2, speedConcurrency, async (item) => {
      const result: DownloadResult = await measureDownload(
        item.ip,
        options.port,
        options.host,
        speedBytes,
        speedTimeoutMs,
        options.probePath ?? '/__edge_probe'
      )
      speedDone++
      report({
        type: 'progress',
        stage: 3,
        done: speedDone,
        total: stage2.length,
        message: `测速 ${speedDone}/${stage2.length} ${result.speedMBps.toFixed(1)} MB/s`,
      })
      return { ...item, speed: result.ok ? result.speedMBps : 0 }
    })
  }

  const entries: ScanEntry[] = speedResults
    .filter((r) => (options.skipSpeed ? true : Boolean(r.speed && r.speed > 0)))
    .map((r) => ({
      ip: r.ip,
      port: options.port,
      colo: r.probe.colo || 'UNK',
      latency: r.latency,
      speed: r.speed ? Number(r.speed.toFixed(2)) : 0,
    }))
    .sort((a, b) => (options.skipSpeed ? a.latency - b.latency : b.speed - a.speed || a.latency - b.latency))
    .slice(0, top)

  for (const entry of entries) {
    report({ type: 'result', entry })
  }

  const summary: ScanSummary = {
    entries,
    stats: {
      candidates: candidates.length,
      tcpOk: tcpOk.length,
      wsOk: wsOk.length,
      speedOk: entries.length,
      elapsedMs: Date.now() - started,
      countries: appliedCountries,
      wsFiltered: wsFiltered.length,
    },
  }
  report({ type: 'done', count: entries.length })
  return summary
}

/**
 * 可直接复制粘贴到同类项目「自定义 IP / 优选 IP」输入框的格式：
 *   `1.2.3.4:443#NRT`  一行一个
 */
export function formatCopyable(entries: ScanEntry[]): string {
  return entries.map((e) => `${e.ip}:${e.port}#${e.colo}`).join('\n')
}

/** 转换为面板回填格式：IP:Port#机房_延迟_速度 */
export function formatEntries(entries: ScanEntry[]): string[] {
  return entries.map((e) => `${e.ip}:${e.port}#${e.colo}_${e.latency}_${e.speed}`)
}
