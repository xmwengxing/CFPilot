/**
 * Phase 7 · 外部数据源 Provider 适配层。
 *
 * ## 为什么需要这一层
 *
 * Phase 2 的采集模型是「GET 一个 HTTPS URL → 拿纯文本清单」，对测绘 API 不成立：
 * 认证位置、HTTP 方法、查询编码、分页、响应结构各家都不同（见
 * `docs/外部测绘源引入评估-2026-11-08.md`）。Provider 直接产出
 * `ParsedCandidate[]`，绕过通用清单解析器，避免把异构响应塞进 `readIpFile` 那条链。
 *
 * ## 当前只注册一家：ripe-stat（零 Key）
 *
 * FOFA 曾短暂接入，但真机验证其免费账户 `remain_api_query=0`、
 * 查询返回 `[820031] F点余额不足`，按用户裁决已整体移除，相关凭据层一并删除。
 * 其他平台（Quake / Hunter / ZoomEye / Censys / Shodan）**一概不接**。
 *
 * 抽象层保留：以后要接新平台只需新增一个 Provider，不动 manager / pool / UI 契约。
 */
import {
  fetchWithRedirects,
  readBodyLimited,
  sanitizeUrl,
  SOURCE_MAX_BYTES,
  SOURCE_TIMEOUT_MS,
  validateSourceUrl,
  type SourceFetchOptions,
} from './fetch'
import { isCloudflareEntryIp } from './pool'
import type { ParsedCandidate } from './normalizer'
import type { SourceConfig, SourceType } from './config'

/** API 型数据源的 id；与 `SourceType` 的 api 子集一一对应。 */
export type ProviderId = 'ripe-stat'
export type ApiSourceType = ProviderId
export const API_SOURCE_TYPES: readonly SourceType[] = ['ripe-stat']

export interface ProviderSpec {
  id: ProviderId
  /** 是否需要凭据（决定 UI 是否显示「未配置」提示） */
  requiresKey: boolean
  /** 同一 provider 两次请求之间的最小间隔，防止触发上游限流 */
  minIntervalMs: number
  defaultQuery: string
  defaultIntervalHours: number
  defaultMaxResults: number
  label: string
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  'ripe-stat': {
    id: 'ripe-stat',
    requiresKey: false,
    minIntervalMs: 2_000,
    defaultQuery: 'AS13335',
    defaultIntervalHours: 24,
    defaultMaxResults: 200,
    label: 'RIPEstat 宣告前缀（零 Key）',
  },
}

export function isProviderId(value: string): value is ProviderId {
  return value === 'ripe-stat'
}

export interface ProviderRequest {
  source: SourceConfig
  timeoutMs?: number
  maxBytes?: number
  /** 测试注入：替换网络层，不改生产路径 */
  fetchImpl?: typeof fetch
}

export interface ProviderResult {
  candidates: ParsedCandidate[]
  /** 不含凭据的诊断信息，可安全写进采集记录 / 日志 */
  note: string
  /** 上游返回的原始条目数（前缀数或命中数） */
  upstreamCount: number
}

/** 带 SSRF 校验 / 重定向复检 / 体积截断的 GET JSON。 */
async function getJson(req: ProviderRequest, rawUrl: string): Promise<unknown> {
  const url = validateSourceUrl(rawUrl)
  const timeoutMs = req.timeoutMs ?? SOURCE_TIMEOUT_MS
  const maxBytes = req.maxBytes ?? SOURCE_MAX_BYTES
  const opts: Required<Pick<SourceFetchOptions, 'timeoutMs'>> & SourceFetchOptions = {
    timeoutMs,
    maxBytes,
    allowHttp: false,
  }
  // SSRF 与逐跳重定向复检对注入的 fetch 同样生效
  const res = await fetchWithRedirects(url, {}, opts, 3, req.fetchImpl ?? fetch)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}（${sanitizeUrl(rawUrl)}）`)
  }
  const text = await readBodyLimited(res, maxBytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`响应不是合法 JSON（${sanitizeUrl(rawUrl)}）`)
  }
}

// ------------------------------------------------------------------
// RIPEstat：AS13335 当前宣告前缀 → 代表 IP
// ------------------------------------------------------------------

/** 从 CIDR 取一个确定性的代表 IP；只接受 /24（v4）与 /48（v6）。 */
export function representativeIp(prefix: string): string | null {
  const [addr, bits] = prefix.trim().split('/')
  if (!addr || !bits) return null
  if (addr.includes(':')) {
    if (bits !== '48') return null
    const groups = addr.split(':').filter((g) => g !== '')
    if (groups.length < 3) return null
    return `${groups[0]}:${groups[1]}:${groups[2]}::1`
  }
  if (bits !== '24') return null
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  // 固定取 .130：避开网络地址 / 广播地址，且同一前缀每次结果一致
  return `${parts[0]}.${parts[1]}.${parts[2]}.130`
}

/** 按父段桶轮转，避免一次取样全挤在同一个 /16 或 /32 里。 */
function spread<T>(items: readonly T[], bucketOf: (v: T) => string, limit: number): T[] {
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const key = bucketOf(item)
    const list = buckets.get(key)
    if (list) list.push(item)
    else buckets.set(key, [item])
  }
  const keys = [...buckets.keys()].sort()
  const out: T[] = []
  for (let round = 0; out.length < limit; round++) {
    let progressed = false
    for (const key of keys) {
      if (out.length >= limit) break
      const value = buckets.get(key)![round]
      if (value !== undefined) {
        out.push(value)
        progressed = true
      }
    }
    if (!progressed) break
  }
  return out
}

async function runRipeStat(req: ProviderRequest): Promise<ProviderResult> {
  const asn = (req.source.query || PROVIDERS['ripe-stat'].defaultQuery).trim()
  if (!/^AS\d{1,10}$/i.test(asn)) {
    throw new Error(`RIPEstat 的 query 必须是 ASN（如 AS13335），收到「${asn}」`)
  }
  const rawUrl = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=${encodeURIComponent(asn)}`
  const data = (await getJson(req, rawUrl)) as {
    status?: string
    data?: { prefixes?: Array<{ prefix?: string }> }
  }
  if (data.status && data.status !== 'ok') {
    throw new Error(`RIPEstat 返回 ${data.status}`)
  }
  const prefixes = (data.data?.prefixes ?? [])
    .map((p) => (typeof p.prefix === 'string' ? p.prefix : ''))
    .filter(Boolean)

  const v4: string[] = []
  const v6: string[] = []
  for (const prefix of prefixes) {
    const ip = representativeIp(prefix)
    if (!ip || !isCloudflareEntryIp(ip)) continue
    if (ip.includes(':')) v6.push(ip)
    else v4.push(ip)
  }
  const max = Math.max(1, Math.min(2000, req.source.maxResults || PROVIDERS['ripe-stat'].defaultMaxResults))
  // IPv6 在项目实测里可用性依赖具体 /48，RIPEstat 给的正是活跃 /48，给 1/4 配额
  const v6Limit = Math.floor(max / 4)
  const picked = [
    ...spread(v4, (ip) => ip.split('.').slice(0, 2).join('.'), max - v6Limit),
    ...spread(v6, (ip) => ip.split(':').slice(0, 2).join(':'), v6Limit),
  ]
  return {
    candidates: picked.map((ip) => ({ ip, port: 443 })),
    note: `${asn} 宣告 ${prefixes.length} 个前缀（v4 ${v4.length} / v6 ${v6.length} 可用），按父段分散取 ${picked.length} 个代表 IP`,
    upstreamCount: prefixes.length,
  }
}

/** 执行一个 API 源。参数非法 / 上游失败都抛错，由 manager 记进采集记录。 */
export async function runProvider(req: ProviderRequest): Promise<ProviderResult> {
  const provider = req.source.type
  if (!isProviderId(provider)) {
    throw new Error(`未知 Provider：${provider}（当前只支持 ripe-stat）`)
  }
  return runRipeStat(req)
}

/** 是否为需要 Provider 的 API 型数据源。 */
export function isApiSource(source: SourceConfig): boolean {
  return API_SOURCE_TYPES.includes(source.type)
}

