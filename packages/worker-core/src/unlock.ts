/**
 * 出口体检（`/__unlock_probe`）
 *
 * ## 它到底测的是什么
 *
 * 用 Worker 的**出站**访问几个固定站点，判断「当前这条链路出去之后能到哪些服务」。
 * 结果按**机房（colo）**归属，因为出口由机房决定 —— 同一机房下，
 * 50 个优选 IP 的结果完全一样，逐个 IP 去测只是把同一个请求重复 50 次。
 *
 * ## 为什么不叫「流媒体解锁检测」
 *
 * 因为那是不诚实的说法，有两条硬限制：
 *
 * 1. **Worker 无法自己发起 TLS**。它只是透明转发客户端与目标站之间的字节，
 *    没有 TLS 客户端能力 —— 所以走不了 ProxyIP / 反代那条真实出站路径。
 * 2. 因此这里只能测「直出（`fetch`）」，也就是**没有配置落地代理时**的真实路径。
 *    配了 SOCKS5 落地或反代之后，真实出口变了，这里的结果只能作参考。
 *
 * 另外 Cloudflare 的出口是数据中心 IP，流媒体平台对这类 IP 的风控是结构性的。
 * 2026-10-30 线上实测（真实 Pages 部署）：
 *
 * | 目标 | 结果 | 说明 |
 * |---|---|---|
 * | Netflix 片源页 | 200 | 只是**页面可达**，播放仍会被风控拦掉 |
 * | YouTube | 200 | 真实可达 |
 * | Gemini | 200 | 真实可达 |
 * | ChatGPT / Claude | 1~29ms | **在 CF 网段里，被 CF 自己应答**，与出口无关 |
 *
 * 所以定位只能是「可达性体检」，不是「解锁检测」：
 * 它告诉你这条链路能不能出去、出去之后哪些站点能到，
 * 但**不能**告诉你「能不能播」「能不能登录」。后者只有换出口（链式代理）能解决。
 */

/** 单个目标的判定结果 */
export type UnlockVerdict = 'ok' | 'blocked' | 'region' | 'unknown'

interface TargetSpec {
  id: string
  url: string
  /**
   * - `status`：只看 HTTP 状态码
   * - `trace`：响应体里应有 `loc=XX`（Cloudflare 的 trace 端点），能直接读出地区
   */
  mode: 'status' | 'trace'
}

/**
 * 探测目标。
 *
 * ⚠️ 这些地址是**外部服务**，随时可能改版；任何一项失败都只影响该项的判定，
 * 不会让整个端点失败（见 `probeOne` 的兜底）。
 */
const TARGETS: readonly TargetSpec[] = [
  // ⚠️ 只放**非 Cloudflare 网段**的站点。
  //
  // 2026-10-30 线上实测（真实 Pages 部署，SJC 机房）：
  //   chatgpt  200 / 1ms     ← 1 毫秒，说明请求根本没出去，
  //   claude   404 / 29ms       是 Cloudflare 自己应答的（同网段短路）
  //
  // 这类目标无论怎么测都只会得到「CF 边缘的响应」，与真实出口无关，
  // 放进来就是假数据。所以 ChatGPT / Claude 一律不测 —— 它们能不能用
  // 取决于你有没有配落地代理，而不是这个端点能测出来的东西。
  //
  // Netflix 同理只能测「站点可达」：2026-10-30 实测数据中心出口下
  // 片源页照样返回 200，但播放会被流媒体风控拦掉。所以这里**不再据此
  // 打「已解锁」标签**，只把状态码原样回给调用方做诊断。
  { id: 'netflix', url: 'https://www.netflix.com/title/81215567', mode: 'status' },
  { id: 'youtube', url: 'https://www.youtube.com/premium', mode: 'status' },
  { id: 'gemini', url: 'https://gemini.google.com/', mode: 'status' },
]

/** 单目标超时 */
const TARGET_TIMEOUT_MS = 4000

/** 结果缓存时长：同一机房 10 分钟内只打一次外部请求 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 缓存条数上限（机房数量有限，超过就丢最旧的） */
const CACHE_MAX = 16

interface CacheEntry {
  at: number
  data: UnlockReport
}

const cache = new Map<string, CacheEntry>()

export interface UnlockTargetResult {
  id: string
  verdict: UnlockVerdict
  /** HTTP 状态码；0 表示请求没发出去 / 超时 */
  status: number
  /** 耗时（ms） */
  ms: number
  /** trace 模式解析出的地区码（如 `US`） */
  loc?: string
  /** 失败原因（短码，便于排查；不含 URL） */
  error?: string
}

export interface UnlockReport {
  colo: string
  /** 由 colo 推出的地区码 */
  region: string
  cached: boolean
  /** 生成时间（毫秒） */
  at: number
  targets: UnlockTargetResult[]
}

/**
 * 把 HTTP 状态码翻译成判定。
 *
 * `region` 与 `blocked` 必须分开：前者是「服务在该地区没有上架」，
 * 后者是「这个出口被拒绝」。用户看到的处置方式完全不同。
 */
function verdictOf(status: number, mode: 'status' | 'trace', body: string): UnlockVerdict {
  if (status === 200) return 'ok'
  if (status === 404) return mode === 'status' ? 'region' : 'unknown'
  if (status === 403 || status === 451) return 'blocked'
  if (mode === 'trace' && /\bloc=[A-Z]{2}\b/.test(body)) return 'ok'
  return 'unknown'
}

/** 带超时的单目标探测 */
async function probeOne(spec: TargetSpec): Promise<UnlockTargetResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TARGET_TIMEOUT_MS)
  try {
    const res = await fetch(spec.url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        // 不带 UA 时不少站点直接回 403，会被误判成「被墙」
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    })
    let body = ''
    if (spec.mode === 'trace') {
      // trace 的响应体很小（<1KB），直接读全文
      body = (await res.text()).slice(0, 512)
    }
    const loc = /\bloc=([A-Z]{2})\b/.exec(body)?.[1]
    return {
      id: spec.id,
      status: res.status,
      verdict: verdictOf(res.status, spec.mode, body),
      ms: Date.now() - started,
      ...(loc ? { loc } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: spec.id,
      status: 0,
      verdict: 'unknown',
      ms: Date.now() - started,
      // 只保留短码，避免把内部错误原文回给调用方
      error: /abort/i.test(message) ? 'timeout' : 'fetch-failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 执行一次体检（带缓存）。
 *
 * @param colo 当前边缘机房
 * @param region 由 colo 推出的地区码
 */
export async function runUnlockProbe(colo: string, region: string): Promise<UnlockReport> {
  const key = colo || 'UNK'
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { ...hit.data, cached: true }
  }

  const targets = await Promise.all(TARGETS.map((spec) => probeOne(spec)))
  const report: UnlockReport = { colo: key, region, cached: false, at: now, targets }

  // 简单容量控制：超了就从最旧的开始删
  if (cache.size >= CACHE_MAX) {
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldestKey = k
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }
  cache.set(key, { at: now, data: report })
  return report
}

/** 仅供测试：清空缓存 */
export function clearUnlockCache(): void {
  cache.clear()
}
