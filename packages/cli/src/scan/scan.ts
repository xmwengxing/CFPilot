/**
 * 三阶真连接扫描器
 *
 * 阶段一：TCP 握手初筛（只保留能建连的 IP）
 * 阶段一之二分：**TLS 握手筛选**（只保留握手快的 IP）← 新增，-1 根因修复
 * 阶段二：强制携带用户域名作为 TLS SNI / HTTP Host，验证是否返回 101 Switching Protocols
 * 阶段三：**只对通过 101 校验的 IP** 测量真实下行速度
 *
 * ## 为什么必须有 TLS 握手筛选
 *
 * 电信千兆环境下实测（两个不同网络，结论一致）：
 *
 * | 指标 | 实测范围 | 区分度 |
 * |------|---------|--------|
 * | TCP 建连延迟 | 8~40ms | **几乎没有** |
 * | TLS 握手耗时 | 768ms ~ 3531ms | **相差 4.6 倍** |
 *
 * 两者**相关系数接近 0**：TCP 9ms 的 IP，TLS 握手可能要 3.5 秒。
 *
 * 旧实现只按 TCP 延迟排序，于是选出「TCP 快但 TLS 慢」的 IP ——
 * 客户端建立连接必须做完整 TLS 握手，超过其超时就是 **-1**。
 * 这就是「优选器测出来都有速度、导入客户端一半以上 -1」的根因。
 *
 * 修复后阶段一以 **TLS 握手耗时为主排序键**，TCP 延迟只作次键。
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
  probeWsPing,
  verifyTunnel,
  probeTlsHandshake,
  measureProbeThroughput,
  measureThroughput,
  type WsProbeResult,
  type TlsProbeResult,
} from './true-probe'
import { parseSpeedUrl, withBytes, schemeForPort, DEFAULT_SPEED_URL } from './speed-url'
import { countryOfColo, normalizeCountryFilter } from './countries'
import { describeUnlock, probeUnlock } from './unlock'

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
  /**
   * 每个探测的尝试次数（含首次），默认 2。
   *
   * 真机实测偶发失败率 3~5%（本地 TLS 抖动 / 运营商瞬时丢包），
   * 一次定生死会白丢好 IP。重试取**第一次成功**的结果。
   */
  retries?: number
  /**
   * 阶段一 TLS 握手探测并发。
   * 默认 64 —— TLS 握手是 CPU 密集型操作，并发过高会让本机成为瓶颈。
   */
  tlsConcurrency?: number
  /** 阶段一 TLS 握手超时（ms），默认 4000 */
  tlsTimeoutMs?: number
  /** 阶段一保留的最大延迟（ms），0 表示不限 */
  maxLatencyMs?: number
  /**
   * 进入阶段二的候选数量。
   *
   * 注意：现在阶段一会先按 **TLS 握手耗时**排序再截取，
   * 因此这个值越大越有机会覆盖到「TLS 快」的 IP。
   */
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
  /**
   * 阶段二是否做**响应体内容校验**（默认 true）。
   *
   * CFPilot 数据面的 `/__edge_probe` 支持 PING → `{"pong":true,...}`，
   * 因此可以比单纯 101 握手多验一层：确认数据面真的在响应。
   * 关掉它（`false`）则退回纯 101 校验，用于对接没有该机制的第三方项目。
   */
  verifyPayload?: boolean
  /** probe 模式的测速路径（默认 /__edge_probe） */
  probePath?: string
  /** 测速重复次数（>1 时取中位数并给出抖动） */
  speedRepeat?: number
  /** 是否额外校验真实 wsPath 的 101（默认 true，路径与探针路径相同时自动跳过） */
  verifyWsPath?: boolean
  /** 真实隧道校验用：VLESS UUID / Trojan 口令（任选其一，缺省则跳过该阶段） */
  uuid?: string
  trojanPassword?: string
  /** 真实隧道校验要访问的目标（默认 baidu.com:80） */
  verifyTargetHost?: string
  verifyTargetPort?: number
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
  /**
   * 是否做「出口体检」（调数据面 `/__unlock_probe`）。
   *
   * 按**机房去重**：同一机房的优选 IP 出口相同，只测一条代表。
   * 需要同时提供 `uuid`（端点鉴权用完整 UUID）。
   */
  unlock?: boolean
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

/**
 * 把失败原因归类。
 *
 * ## 为什么要分类而不是只报计数
 *
 * 「101 阶段失败 812 个」没有信息量；「其中 700 个是 HTTP 403、90 个超时、
 * 22 个连接被重置」才能直接指向原因（403 多半是路径/鉴权不对，超时是 IP 不可用）。
 *
 * 归类只做粗粒度匹配：目标是**可读的分布**，不是精确的错误码体系。
 */
export function classifyFailure(error: string | undefined): string {
  const text = String(error ?? '').trim()
  if (!text) return '未知原因'
  if (/timeout|timed out|超时|ETIMEDOUT/i.test(text)) return '超时'
  if (/ECONNREFUSED|connection refused|连接被拒/i.test(text)) return '连接被拒'
  if (/ENETUNREACH|EHOSTUNREACH|unreachable/i.test(text)) return '网络不可达'
  if (/ECONNRESET|socket hang up|连接重置/i.test(text)) return '连接重置'
  if (/certificate|CERT_|SELF_SIGNED|证书/i.test(text)) return '证书问题'
  if (/ALPN/i.test(text)) return 'ALPN 协商失败'
  if (/HTTP\s*\d{3}/i.test(text)) {
    const code = /HTTP\s*(\d{3})/i.exec(text)?.[1]
    return code ? `HTTP ${code}` : 'HTTP 状态异常'
  }
  if (/PONG|pong/i.test(text)) return '内容校验不通过'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return '域名解析失败'
  return '其他'
}

/** 失败原因计数（阶段 → 原因 → 次数） */
export type FailureBreakdown = Record<string, Record<string, number>>

function countFailure(into: FailureBreakdown, stage: string, error: string | undefined): void {
  const bucket = (into[stage] ??= {})
  const key = classifyFailure(error)
  bucket[key] = (bucket[key] ?? 0) + 1
}

export interface ScanEntry {
  ip: string
  port: number
  colo: string
  latency: number
  /** TLS 握手耗时（ms）—— 客户端能否连上主要看这个 */
  tlsMs: number
  speed: number
}

export interface ScanSummary {
  entries: ScanEntry[]
  stats: {
    candidates: number
    tcpOk: number
    /** 完成 TLS 握手的候选数 */
    tlsOk: number
    wsOk: number
    /** 通过响应体内容校验（PING→PONG）的候选数；未开启校验时为 0 */
    verified: number
    speedOk: number
    elapsedMs: number
    /** 生效的国家筛选（空 = 未筛选或筛选被忽略） */
    countries: string[]
    /** 国家筛选后进入测速的候选数（未筛选时 = wsOk） */
    wsFiltered: number
    /** 国家筛选未命中任何候选、已放宽为全量（此时 countries 为空） */
    countryFilterRelaxed?: boolean
    /** 因已攒够目标国家节点而提前结束阶段二 */
    stoppedEarly?: boolean
    /**
     * 各阶段的失败原因分布。
     *
     * 只报总数没有用（「101 失败 812 个」指不出原因），分类后能直接看出
     * 是路径不对（403 多）、IP 不可用（超时多）还是别的问题。
     */
    failures?: FailureBreakdown
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

/**
 * 并发池。
 *
 * @param shouldStop 可选的提前终止判定。返回 true 时不再领取新任务
 *   （已在跑的任务会跑完）。用于「已经拿到足够多的目标结果就收工」。
 */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (shouldStop?.()) return
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return out
}

/**
 * 自适应并发池。
 *
 * ## 为什么需要
 *
 * 并发不是越高越好 —— 高并发会撞上本机/网络侧的瓶颈，
 * 表现为「超时率随并发上升」，反而拿不到更多可用节点。
 *
 * 真机实测（本机开着 TUN 代理、且代理用的就是本项目的订阅节点）：
 *
 *   并发  20  → TCP 成功率 100%
 *   并发  50  → TCP 100%，但 TLS 阶段掉到 4%
 *   并发 100  → TCP 49%
 *   并发 300  → TCP 26%
 *
 * 固定并发在这类环境里会直接崩掉。这里改成**按批评估、自动升降**：
 *
 *   每批 200 个候选跑完后看成功率：
 *     < 40%  → 并发减半（下限 min(8, 请求值)）
 *     > 85%  → 并发翻倍（上限 = 请求值）
 *
 * ⚠️ 下限必须受请求值约束：写死 8 会让「用户指定并发 2 / 4 / 6」的
 * 低并发配置在成功率变差时反而**升到 8** —— 与用户设置相反，
 * 在被限速的网络上会把结果弄得更差。
 *
 * 网络好时自动升回高并发（速度不损失），
 * 网络被限速/被 TUN 干扰时自动退到能跑通的并发度（结果不空）。
 *
 * ⚠️ 与 Go 版 packages/desktop/internal/scan/scan.go 的自适应池语义一致
 * （AGENTS.md §2.2：两端行为必须一致）。
 */
export async function poolAdaptive<T, R extends { ok: boolean }>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  batchSize = 200
): Promise<R[]> {
  const out: R[] = []
  const maxConcurrency = Math.max(1, concurrency)
  // 下限也只能到请求值：用户设 2 时下限不能是 8
  const minConcurrency = Math.min(8, maxConcurrency)
  let current = maxConcurrency

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize)
    const results = await pool(batch, current, worker)
    out.push(...results)

    // 评估本批成功率
    const okCount = results.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
    const rate = results.length > 0 ? okCount / results.length : 1
    if (rate < 0.4) {
      current = Math.max(minConcurrency, Math.min(maxConcurrency, Math.floor(current / 2)))
    } else if (rate > 0.85) {
      current = Math.min(maxConcurrency, current * 2)
    }
  }
  return out
}

/**
 * 判断错误是否属于「超时」。
 *
 * 超时意味着「这个 IP 在当前网络下不可用」，重试一次也是同样结果，
 * 只会让并发槽位多占一个超时周期。偶发错误（连接重置等）才值得重试。
 */
function isTimeoutError(error: string | undefined): boolean {
  if (!error) return false
  return /超时|timeout|timed out|ETIMEDOUT/i.test(error)
}

/**
 * 带重试的执行器（社区通用的「多候选逐个尝试」思路）。
 *
 * ## 为什么需要
 *
 * 真机实测：同一 IP 连续探测，偶发失败率约 3~5%（本地 TLS 抖动、
 * 运营商链路瞬时丢包）。早期实现一次定生死，把这些偶发失败当成
 * 「IP 不可用」，白丢一批好 IP。
 *
 * 社区通用的 `probePreferred` 对域名目标会 `addresses.slice(0, 4)` 逐个试；
 * 我们面对的是「已知 IP 列表」，等价做法是**对同一个 IP 重试几次**，
 * 取第一次成功的结果（延迟取成功那次，不是平均值）。
 *
 * @param attempts 总尝试次数（含首次），≥1
 * @param isOk 判定「本次是否算成功」；默认看 `ok === true`
 * @param shouldRetry 判定「失败后是否还值得再试」；返回 false 则立即停止重试
 */
async function withRetry<T>(
  attempts: number,
  fn: () => Promise<T>,
  isOk: (result: T) => boolean = (r) => (r as { ok?: boolean }).ok === true,
  shouldRetry: (result: T) => boolean = () => true
): Promise<T> {
  const total = Math.max(1, Math.floor(attempts))
  let last: T
  for (let i = 0; i < total; i++) {
    last = await fn()
    if (isOk(last)) return last
    // 本次失败不值得再试（如超时）→ 立刻返回
    if (!shouldRetry(last)) return last
  }
  return last!
}

/** 执行三阶扫描 */
export async function runScan(options: ScanOptions): Promise<ScanSummary> {
  const started = Date.now()
  const concurrency = options.concurrency ?? 300
  const tcpTimeoutMs = options.tcpTimeoutMs ?? 1200
  const retries = options.retries ?? 2
  const tlsConcurrency = options.tlsConcurrency ?? 64
  /**
   * TLS 握手超时。
   *
   * 默认 2000ms（旧值 4000ms）：优选场景下握手超过 2 秒的节点已无实用价值，
   * 而超时后**不再重试**（见 withRetry 的 shouldRetry），
   * 所以单 IP 最坏只占 2 秒而不是 8 秒。
   */
  const tlsTimeoutMs = options.tlsTimeoutMs ?? 2000
  const maxLatencyMs = options.maxLatencyMs ?? 0
  const probeLimit = options.probeLimit ?? 120
  const probeConcurrency = options.probeConcurrency ?? 24
  const probeTimeoutMs = options.probeTimeoutMs ?? 3000
  const speedLimit = options.speedLimit ?? 30
  /**
   * 测速阶段的候选并行数，**默认 1（串行）**。
   *
   * ## 为什么必须串行
   *
   * 阶段三测的是**带宽**，而带宽是整条链路共享的资源。
   * 2026-10-28 真机定位：默认 4 路并行时，每个候选只能分到约 1/4 带宽，
   * 于是无论 IP 好坏，测出来全是 0.1~0.2 MB/s —— 用户看到的就是
   * 「优选出来的 IP 全都只有 0.1~0.9 MB/s」。
   *
   * 并行只适合测「延迟」这类不占带宽的指标（TCP / TLS / 101 阶段就是这么做的）。
   * 串行代价可控：每次测量有时长上限（默认 6s），30 个候选约 3 分钟；
   * 想要更快可以调小 `--speed-limit` 或 `--speed-duration`。
   */
  const speedConcurrency = options.speedConcurrency ?? 1
  const speedTimeoutMs = options.speedTimeoutMs ?? 12000
  const speedBytes = options.speedBytes ?? 5 * 1024 * 1024
  const top = options.top ?? 8
  /**
   * 国家 / 地区筛选（作用于已识别机房的候选）。
   *
   * 机房（colo）只有 WS 101 响应里才有，TCP / TLS 阶段无从得知，
   * 所以筛选只能在阶段二之后做 —— 这带来一个结构性问题：
   * 进入阶段二的候选是「按 TLS 耗时排序后的前 N 个」，
   * 若用户所在网络到 HK / US 延迟最低，这 N 个会被 HK/US 占满，
   * 后面稍微慢几毫秒的 JP / SG 节点早已被截断掉。
   *
   * 因此**带国家筛选时自动扩大阶段二候选池**，
   * 让目标国家有机会进入探测范围。
   */
  const countryFilter = normalizeCountryFilter(options.countries ?? [])
  const hasCountryFilter = countryFilter.length > 0
  /** 阶段二候选池大小：带国家筛选时放大 4 倍（最少 500） */
  const effectiveProbeLimit = hasCountryFilter
    ? Math.max(probeLimit * 4, 500)
    : probeLimit

  const candidates = options.candidates
  const report = options.onProgress ?? (() => {})

  // ---- 阶段一：TCP 握手初筛 ----
  report({ type: 'stage', stage: 1, name: 'TCP 握手初筛', total: candidates.length })
  let done = 0
  const tcpResults = await poolAdaptive(candidates, concurrency, async (ip) => {
    const result = await withRetry(retries, () => tcpPing(ip, options.port, tcpTimeoutMs))
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

  // ---- 阶段一之二分：TLS 握手筛选（-1 根因修复）----
  //
  // 真机实测（电信千兆，两个网络环境）：TCP 延迟集中在 8~40ms（无区分度），
  // 而 TLS 握手耗时 768ms~3531ms（相差 4.6 倍），两者相关系数接近 0。
  // 只按 TCP 排序会选出「TCP 快但 TLS 慢」的 IP —— 客户端做完整 TLS 握手
  // 超过超时就是 -1，这正是「优选有速度、导入一半以上 -1」的根因。
  //
  // 因此这里对 TCP 通过的候选追加 TLS 握手探测，并以**握手耗时**作为
  // 阶段一的主排序键；TCP 延迟只作次键（两者都通过时优先握手快的）。
  //
  // ⚠️ **先粗筛再握手**：TCP 通过的候选可能有几千个，但最终只有
  // effectiveProbeLimit 个能进阶段二。为后面几千名做 CPU 密集的 TLS 握手
  // 纯属浪费（而且假通 IP 会占满并发槽位）。
  // 先按 TCP 延迟升序取前 max(effectiveProbeLimit * 4, 600) 个再做 TLS 握手。
  //
  // ⚠️ 注意：粗筛只用 **TCP 延迟**排序，**不改变最终的排序依据** ——
  // 最终排序仍然是 TLS 握手耗时（唯一有区分度的指标）。
  // TCP 延迟只在这里当「粗筛的便宜代理指标」用。
  const tlsCandidateLimit = Math.max(effectiveProbeLimit * 4, 600)
  const tlsInput = filtered
    .slice()
    .sort((a, b) => a.latency - b.latency)
    .slice(0, tlsCandidateLimit)

  report({ type: 'stage', stage: 1, name: 'TLS 握手筛选', total: tlsInput.length })
  let tlsDone = 0
  const tlsResults = await poolAdaptive(tlsInput, tlsConcurrency, async (item) => {
    // TLS 探测的「成功」判定是 tlsMs > 0（它没有 ok 字段）
    //
    // ⚠️ 超时不重试：TLS 握手超时说明这个 IP 在当前网络下就是不可用，
    // 再试一次也是同样的结果，却要让并发槽位多占 4 秒。
    // 只有「连接被重置」这类偶发错误才值得重试。
    const probe = await withRetry<TlsProbeResult>(
      retries,
      () => probeTlsHandshake(item.ip, options.port, options.host, tlsTimeoutMs),
      (r) => r.tlsMs > 0,
      // 第 4 个参数：上次失败原因是超时就不要再试
      (r) => !isTimeoutError(r.error)
    )
    tlsDone++
    if (tlsDone % 200 === 0 || tlsDone === tlsInput.length) {
      report({
        type: 'progress',
        stage: 1,
        done: tlsDone,
        total: tlsInput.length,
        message: `TLS 握手 ${tlsDone}/${tlsInput.length}${probe.tlsMs > 0 ? ` ${probe.tlsMs}ms` : ' ✗'}`,
      })
    }
    return { ...item, tls: probe }
  })

  const failures: FailureBreakdown = {}
  const tlsOk = tlsResults.filter((r) => r.tls.tlsMs > 0)
  for (const item of tlsResults) {
    if (item.tls.tlsMs > 0) continue
    countFailure(failures, 'tls', item.tls.error)
  }

  // 主排序键：TLS 握手耗时（升序）；次键：TCP 延迟
  const stage1 = tlsOk
    .sort((a, b) => a.tls.tlsMs - b.tls.tlsMs || a.latency - b.latency)
    .slice(0, effectiveProbeLimit)

  // ---- 阶段二：WebSocket 101 + 响应体内容校验 ----
  //
  // 起默认走「严格模式」（`probeWsPing`）：
  // 不只握手，还发送 PING 并校验数据面回的 `{"pong":true,...}`。
  // 这样「101 通但数据面不响应」的 IP 会在这一层被拦掉，
  // 不会带着虚假的希望进入测速、也不会出现在最终结果里。
  //
  // `--no-verify` 可退回纯 101 校验（对接第三方项目时用，
  // 因为它们没有 CFPilot 的 PING 机制）。
  //
  // ⚠️ **内容校验优先走探针端点**（真机实测）：
  // CFPilot 的 `/__edge_probe` 内置 PING/PONG，而 VLESS/Trojan 入站路径
  // 期待的是协议头（`[0,0]`）而非 PING 文本 —— 对它发 PING 会永远等不到响应。
  // 同一批 IP：探针路径 16/20 通过，WS 入站路径 0/20 全部超时。
  //
  // 但**不能把路径写死**：用户显式传 `--probe-path` / `--path` 时必须尊重，
  // 否则「对接第三方项目」（它们的 WS 路径不是 /__edge_probe）永远测不出结果。
  //
  // 优先级：显式 probePath > 显式 wsPath（仅当它看起来像探针端点时）> 默认探针路径
  const strictProbe = options.verifyPayload !== false
  const explicitProbePath = options.probePath?.trim()
  const explicitWsPath = options.wsPath?.trim()
  const strictProbePath =
    explicitProbePath ||
    // 用户的 wsPath 以 /__edge_probe 开头 → 视为探针端点
    (explicitWsPath?.startsWith('/__edge_probe') ? explicitWsPath : '') ||
    '/__edge_probe'
  report({
    type: 'stage',
    stage: 2,
    name: strictProbe ? 'WS 101 + 响应体校验（探针端点）' : 'WebSocket 101 校验',
    total: stage1.length,
  })
  let probeDone = 0
  let verifiedCount = 0
  /**
   * 早期退出：带国家筛选时，攒够够用的目标国家节点就收工。
   *
   * 为什么要提前退：扩大候选池（effectiveProbeLimit）后阶段二最多要探 500 个，
   * 但用户只要 speedLimit 个节点 —— 探完 500 个里的第 20 个时就可以停，
   * 省掉后面几百次 WS 探测（每次 3 秒超时）。
   *
   * 阈值取 speedLimit * 1.5，留出余量应对后续测速淘汰。
   */
  // 真实 wsPath 校验失败的计数（进入结果 stats）
  let pathFailures = 0
  const earlyExitTarget = hasCountryFilter ? Math.ceil(speedLimit * 1.5) : Infinity
  let matchedCount = 0
  let stoppedEarly = false

  const probeResults = await pool(
    stage1,
    probeConcurrency,
    async (item) => {
      const probeFn = strictProbe ? probeWsPing : probeWs101
      const probePath = strictProbe ? strictProbePath : explicitWsPath || '/__edge_probe'
      const result: WsProbeResult = await withRetry(retries, () =>
        probeFn(item.ip, options.port, options.host, probeTimeoutMs, probePath)
      )
      // 额外校验**真实 wsPath** 的 101：阶段二默认打的是探针路径，
      // 路径配错时探针能过、客户端却全 -1。不额外花时间的场景（路径相同）自动跳过。
      let pathOk: boolean | undefined
      if (result.ok && explicitWsPath && explicitWsPath !== probePath && options.verifyWsPath !== false) {
        const pathProbe = await probeWs101(item.ip, options.port, options.host, probeTimeoutMs, explicitWsPath)
        pathOk = pathProbe.ok
        if (!pathOk) pathFailures++
      }
      probeDone++
      if (result.pongVerified) verifiedCount++
      // 统计命中目标国家的数量（早期退出判据）
      if (
        hasCountryFilter &&
        result.ok &&
        countryFilter.includes(countryOfColo(result.colo || ''))
      ) {
        matchedCount++
      }
      report({
        type: 'progress',
        stage: 2,
        done: probeDone,
        total: stage1.length,
        message: strictProbe
          ? `101+PING 校验 ${probeDone}/${stage1.length}${result.ok ? ` ✓ ${result.colo}` : result.pongVerified === false ? ' ✗ 无响应' : ''}`
          : `101 校验 ${probeDone}/${stage1.length}${result.ok ? ` ✓ ${result.colo}` : ''}`,
      })
      return { ...item, probe: result, pathOk }
    },
    () => {
      if (matchedCount >= earlyExitTarget) {
        stoppedEarly = true
        return true
      }
      return false
    }
  )

  // 严格模式下，只保留**通过内容校验**的候选。
  // 非严格模式（第三方项目）退化为只看 101。
  const wsOk = (strictProbe
    ? probeResults.filter((r) => r.probe.ok && r.probe.pongVerified === true)
    : probeResults.filter((r) => r.probe.ok)
  ).filter((r) => (r as { pathOk?: boolean }).pathOk !== false)
  for (const item of probeResults) {
    if (item.probe.ok) continue
    countFailure(failures, 'ws101', item.probe.error)
  }

  // ---- 阶段二点五：真实隧道校验（可选）----
  //
  // 阶段二只证明「这个 IP 能把请求送到我们的数据面」；它证明不了
  // 真实 wsPath / 认证配置 / 数据面出站是否真的可用 —— 这三类都会表现为
  // 「优选结果正常、导入客户端全是 -1」。
  // 只有显式给了 uuid / trojanPassword 时才跑（需要真实凭据）。
  let tunnelOk = wsOk
  let tunnelFailed = 0
  const tunnelCredential = options.uuid || options.trojanPassword
  if (tunnelCredential && options.wsPath) {
    const candidates = wsOk.slice(0, speedLimit)
    const verified = await pool(candidates, 4, async (item) => {
      const result = await verifyTunnel({
        ip: item.ip,
        port: options.port,
        host: options.host,
        wsPath: options.wsPath!,
        uuid: options.uuid,
        trojanPassword: options.trojanPassword,
        targetHost: options.verifyTargetHost,
        targetPort: options.verifyTargetPort,
      })
      if (!result.ok) tunnelFailed++
      report({
        type: 'progress',
        stage: 2,
        done: candidates.length,
        total: candidates.length,
        message: `真实隧道校验 ${result.ok ? '✓' : '✗ ' + (result.error ?? '')}`,
      })
      return { item, ok: result.ok }
    })
    const passed = new Set(verified.filter((v) => v.ok).map((v) => v.item.ip))
    tunnelOk = wsOk.filter((item) => passed.has(item.ip))
    if (tunnelOk.length === 0) tunnelOk = wsOk // 全失败时退回阶段二结果，避免直接空结果
  }

  // ---- 国家 / 地区过滤（可选，作用于已识别机房的候选）----
  //
  // 为什么放在这里：机房（colo）只有 101 握手响应里才有，TCP / TLS 阶段无从得知。
  //
  // ⚠️ 筛不到时的行为：**不再静默忽略筛选**。
  // 旧行为是「筛不到就忽略筛选、返回全部」—— 用户以为只要了 JP，
  // 实际拿到的是全球节点，只在进度行里留一句提示，极易看漏。
  // 现在明确告知「已放宽为全量」，并在结果里标记筛选未生效。
  let wsFiltered = wsOk
  let appliedCountries: string[] = []
  let countryFilterRelaxed = false
  if (hasCountryFilter && wsOk.length > 0) {
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
      countryFilterRelaxed = true
      report({
        type: 'progress',
        stage: 2,
        done: wsOk.length,
        total: wsOk.length,
        message: `⚠️ 国家筛选 ${countryFilter.join('/')} 后无候选 —— 已放宽为全量（${wsOk.length} 条）。可加大 --sample 或换地区重试`,
      })
    }
  }

  // 阶段二的截断同样改为「TLS 握手优先」——101 校验通过的候选里，
  // 握手快的对客户端更友好（延迟 -1 的主因就是握手慢）。
  const stage2 = wsFiltered
    .sort((a, b) => a.tls.tlsMs - b.tls.tlsMs || a.latency - b.latency)
    .slice(0, speedLimit)

  // ---- 阶段三：真实下行测速（可用 --no-speed 跳过） ----
  //
  // 两种方式都只作用于**已通过 101 校验**的 stage2，因此不会产出
  // 「速度快但不能服务你的域名」的 -1 节点。
  let speedResults: Array<{
    ip: string
    ok: boolean
    latency: number
    tls: TlsProbeResult
    probe: WsProbeResult
    speed?: number
    jitter?: number
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
        const repeat = Math.max(1, options.speedRepeat ?? 1)
        const samples: number[] = []
        for (let r = 0; r < repeat; r++) {
          const one = await measureThroughput({
            ip: item.ip,
            port: options.port,
            sniHost: parsedUrl.host,
            requestHost: parsedUrl.host,
            path: requestPath,
            connections: options.speedConnections ?? 8,
            durationMs: options.speedDurationMs ?? 6000,
            timeoutMs: options.speedTimeoutMs ?? 20000,
          })
          if (one.ok) samples.push(one.steadyMBps)
        }
        samples.sort((a, b) => a - b)
        const median = samples.length === 0 ? 0 : samples[Math.floor(samples.length / 2)]!
        const jitter = samples.length < 2 ? 0 : samples[samples.length - 1]! - samples[0]!
      const result = { ok: samples.length > 0, steadyMBps: median }
      speedDone++
      report({
        type: 'progress',
        stage: 3,
        done: speedDone,
        total: stage2.length,
        message: `测速 ${speedDone}/${stage2.length} [${item.probe.colo || 'UNK'}] ${result.steadyMBps.toFixed(1)} MB/s${jitter > 0 ? ` ±${jitter.toFixed(1)}` : ''}`,
      })
      return { ...item, speed: result.ok ? result.steadyMBps : 0, jitter }
    })
  } else {
    report({ type: 'stage', stage: 3, name: '真实下行速度测试（项目探针端点 · 多流稳态）', total: stage2.length })
    let speedDone = 0
    speedResults = await pool(stage2, speedConcurrency, async (item) => {
        const repeat = Math.max(1, options.speedRepeat ?? 1)
        const samples: number[] = []
        for (let r = 0; r < repeat; r++) {
          const one = await measureProbeThroughput({
            ip: item.ip,
            port: options.port,
            host: options.host,
            bytes: speedBytes,
            path: strictProbePath,
            connections: options.speedConnections ?? 8,
            durationMs: options.speedDurationMs ?? 6000,
            timeoutMs: speedTimeoutMs,
            token: options.uuid,
          })
          if (one.ok) samples.push(one.steadyMBps)
        }
        samples.sort((a, b) => a - b)
        const median = samples.length === 0 ? 0 : samples[Math.floor(samples.length / 2)]!
        const jitter = samples.length < 2 ? 0 : samples[samples.length - 1]! - samples[0]!
      const result = { ok: samples.length > 0, steadyMBps: median }
      speedDone++
      report({
        type: 'progress',
        stage: 3,
        done: speedDone,
        total: stage2.length,
        message: `测速 ${speedDone}/${stage2.length} [${item.probe.colo || 'UNK'}] ${result.steadyMBps.toFixed(1)} MB/s${jitter > 0 ? ` ±${jitter.toFixed(1)}` : ''}`,
      })
      return { ...item, speed: result.ok ? result.steadyMBps : 0 }
    })
  }

  const ranked: ScanEntry[] = speedResults
    .filter((r) => (options.skipSpeed ? true : Boolean(r.speed && r.speed > 0)))
    .map((r) => ({
      ip: r.ip,
      port: options.port,
      colo: r.probe.colo || 'UNK',
      latency: r.latency,
      tlsMs: r.tls.tlsMs,
      speed: r.speed ? Number(r.speed.toFixed(2)) : 0,
      speedJitter: r.jitter ? Number(r.jitter.toFixed(2)) : 0,
    }))
    .sort((a, b) =>
      options.skipSpeed
        ? a.tlsMs - b.tlsMs || a.latency - b.latency
        : b.speed - a.speed || a.tlsMs - b.tlsMs || a.latency - b.latency
    )

  // 取前 N 时**按 /16 轮流取**，而不是直接切前 N 名。
  //
  // 为什么：Cloudflare 的好 IP 会集中在少数 /16（实测 104.16–104.19 就占了大半），
  // 直接取前 N 名经常得到「同一个 /16 的 N 个 IP」。这些 IP 走的是同一段路由、
  // 同一个入口，一旦那段拥塞或被 QoS，整批节点同时劣化 —— 用户手上没有备选。
  //
  // 轮流取（每轮从每个 /16 取当前最好的一条）既保住了速度排序，又保证
  // 最终列表覆盖多个网段；同段内部仍然按速度排。
  const entries = pickWithDiversity(ranked, top)

  // ---- 阶段四：出口体检（可选）----
  //
  // 按**机房去重**：结果由出口决定，出口由机房决定，同机房的所有 IP 完全一样。
  // 50 条结果通常只落在 3~8 个机房上，所以这里最多打 8 次请求。
  //
  // 失败不阻断：体检只是附加信息，拿不到就留空标签。
  if (options.unlock && options.uuid && entries.length > 0) {
    const byColo = new Map<string, ScanEntry>()
    for (const entry of entries) {
      const key = entry.colo || 'UNK'
      if (!byColo.has(key)) byColo.set(key, entry)
    }
    const reps = [...byColo.values()]
    report({ type: 'stage', stage: 4, name: '出口体检（按机房去重）', total: reps.length })
    let done = 0
    await pool(reps, 2, async (rep) => {
      const result = await probeUnlock({
        ip: rep.ip,
        port: options.port,
        host: options.host,
        token: options.uuid!,
      })
      done++
      // ⚠️ 结果**不写进备注**：体检只能证明「站点可达」，不能证明「能播放/能登录」。
      // 2026-10-30 线上实测：数据中心出口下 Netflix 片源页照样 200，播放却被拦。
      // 把这种信号写成节点名里的 [NF]，就是在制造「看起来能用、实际不能用」的假象 ——
      // 与这个项目「真连接」的立场相反。所以只在日志里报告，不改节点名。
      report({
        type: 'progress',
        stage: 4,
        done,
        total: reps.length,
        message: `${rep.colo || 'UNK'} ${describeUnlock(result)}`,
      })
      return result
    })
  }

  for (const entry of entries) {
    report({ type: 'result', entry })
  }

  const summary: ScanSummary = {
    entries,
    stats: {
      candidates: candidates.length,
      tcpOk: tcpOk.length,
      tlsOk: tlsOk.length,
      wsOk: wsOk.length,
      verified: verifiedCount,
      speedOk: entries.length,
      elapsedMs: Date.now() - started,
      countries: appliedCountries,
      wsFiltered: wsFiltered.length,
      /** 国家筛选未命中任何候选、已放宽为全量 */
      countryFilterRelaxed,
      /** 因已攒够目标国家节点而提前结束阶段二 */
      stoppedEarly,
      /** 各阶段失败原因分布 */
      failures,
    },
  }
  report({ type: 'done', count: entries.length })
  return summary
}

/**
 * 主机部分（IPv6 必须加方括号）。
 *
 * ## 为什么必须加
 *
 * 数据面 `sub-engine.ts` 的解析器按冒号数量分流：
 *
 *   `[2606:4700::1]:443`  → 方括号形式 → host=2606:4700::1, port=443 ✓
 *   `2606:4700::1:443`    → 冒号数 > 1 → 整个串当成 IPv6 地址
 *                            → host=2606:4700::1:443, port=默认 ✗ IP 错了
 *
 * 即裸 IPv6 带端口会被误解析成「一个更长的 IPv6 地址」，
 * 订阅里就会指向一个不存在的地址。AGENTS.md 铁律 6 也要求解析器
 * 兼容 `[IPv6]:Port#备注` 形式 —— 产出方必须与之一致。
 */
export function formatHost(ip: string): string {
  return ip.includes(':') ? `[${ip}]` : ip
}

/**
 * 可直接复制粘贴到同类项目「自定义 IP / 优选 IP」输入框的格式：
 *   `1.2.3.4:443#NRT`  一行一个
 *   `[2606:4700::1]:443#NRT`（IPv6 带方括号）
 */
export function formatCopyable(entries: ScanEntry[]): string {
  return entries.map((e) => `${formatHost(e.ip)}:${e.port}#${e.colo}`).join('\n')
}

/** 转换为面板回填格式：IP:Port#机房_延迟_速度[_标签] */
export function formatEntries(entries: ScanEntry[]): string[] {
  return entries.map(
    (e) => `${formatHost(e.ip)}:${e.port}#${e.colo}_${e.latency}_${e.speed}`
  )
}

/**
 * 按 /16 轮流取前 N 条，保证结果覆盖多个网段。
 *
 * 例：三个 /16 的候选按速度排好后，顺序为
 *   A1(104.16) B1(104.17) C1(104.18) A2 B2 C2 …
 * 而不是 A1 A2 A3 B1 B2 C1。
 *
 * 不到 N 条时有多少给多少；只有一个网段时行为与直接截取完全一致。
 */
export function pickWithDiversity<T extends { ip: string }>(ranked: readonly T[], top: number): T[] {
  if (top <= 0) return []
  // 按 /16 分桶（保持桶内速度顺序）
  const buckets = new Map<string, T[]>()
  for (const item of ranked) {
    const parts = item.ip.split('.')
    const key = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : item.ip
    const list = buckets.get(key)
    if (list) list.push(item)
    else buckets.set(key, [item])
  }
  if (buckets.size <= 1) return ranked.slice(0, top)

  const groups = [...buckets.values()]
  const out: T[] = []
  for (let round = 0; out.length < top; round++) {
    let pickedAny = false
    for (const group of groups) {
      if (out.length >= top) break
      const item = group[round]
      if (item) {
        out.push(item)
        pickedAny = true
      }
    }
    if (!pickedAny) break
  }
  return out
}
