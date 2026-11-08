/**
 * 外部清单拉取：SSRF 防护、逐跳重定向校验、条件请求、镜像回退、体积截断。
 *
 * ## 为什么不直接用 `readIpUrl`
 *
 * `readIpUrl`（`scan/ip-ranges.ts`）已经有 2MB / 15s / 流式截断 / 清洗，
 * 但它是「一次性命令」用的：跟着重定向自动跳、无条件请求、无镜像回退、
 * 也不拒绝 `http://127.0.0.1`。数据源是**长期挂在用户机器上的定时拉取**，
 * 一个自定义 URL 就可能打到本机管理口或云元数据接口，所以这里必须补齐防护。
 * 清洗仍然复用 `readIpFile`（见 normalizer.ts），不另造轮子。
 */
import { isIP } from 'node:net'
import { MIRRORS } from '../shared/github-mirrors'
import type { SourceConfig } from './config'

export const SOURCE_MAX_BYTES = 2 * 1024 * 1024
export const SOURCE_TIMEOUT_MS = 15_000
export const SOURCE_MAX_REDIRECTS = 3

export interface SourceFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  /** 只允许测试环境显式打开；生产恒为 HTTPS-only */
  allowHttp?: boolean
}

export interface SourceFetchResult {
  text: string
  /** 实际取成功的 URL（可能是镜像） */
  url: string
  etag: string
  lastModified: string
  notModified: boolean
}

/** 私有 / 保留 / 特殊用途的 IPv4 判定（按首两段足够覆盖全部场景）。 */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  const [a, b] = p
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // 链路本地 / 云元数据
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0.0/24、192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 基准测试段
  if (a === 198 && b === 51 && p[2] === 100) return true // 198.51.100.0/24
  if (a === 203 && b === 0 && p[2] === 113) return true
  if (a !== undefined && a >= 224) return true // 组播 / 保留 / 广播
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  // IPv4-mapped：把后面那段取出来按 v4 规则判。
  // ⚠️ URL 构造器会把 `[::ffff:127.0.0.1]` 归一化成 `::ffff:7f00:1`（十六进制），
  // 点分十进制的正则匹配不到。mapped 地址本来就没有任何正当理由出现在
  // 外部清单源里，一律拒绝比逐个换算更稳妥，也与 Go 侧 To4() 的结论一致。
  if (lower.startsWith('::ffff:')) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true // fe80::/10
  return false
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/**
 * 校验外部数据源 URL。
 *
 * - 默认**只允许 https**（D2 裁决：自定义 URL 默认 HTTPS）；
 * - 拒绝 userinfo（防止 `https://public@127.0.0.1` 这类视觉欺骗）；
 * - 拒绝 localhost / `.localhost` / `.local` / `.internal` / 云元数据域名；
 * - 拒绝 IP 字面量形式的私网 / 链路本地 / CGNAT / 组播 / 保留地址。
 *
 * ⚠️ 已知限制：只校验 URL 里的**字面量**，不预解析 DNS。
 * 若上游域名被攻击者改成指向内网（DNS rebinding），fetch 仍会连过去。
 * 完整防护需要在连接层绑定已校验的 IP，Node 的 fetch 不暴露该钩子；
 * 本功能只从用户自己填写的固定 HTTPS 源拉文本，风险可接受，记录在验收报告里。
 */
export function validateSourceUrl(raw: string, opts: SourceFetchOptions = {}): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`不是合法的链接：${raw}`)
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp === true && url.protocol === 'http:')) {
    throw new Error(`外部数据源只支持 HTTPS，实际是 ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error('外部数据源链接不允许带用户名/密码')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error(`外部数据源不允许指向本机或内网域名：${host}`)
  }
  const family = isIP(host)
  if (family === 4 && isPrivateIPv4(host)) {
    throw new Error(`外部数据源不允许指向私网/保留地址：${host}`)
  }
  if (family === 6 && isPrivateIPv6(host)) {
    throw new Error(`外部数据源不允许指向私网/保留地址：${host}`)
  }
  return url
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/** 手动跟随重定向：每跳都重新做一次 SSRF 校验，且总跳数有上限。 */
export async function fetchWithRedirects(
  url: URL,
  headers: Record<string, string>,
  opts: Required<Pick<SourceFetchOptions, 'timeoutMs'>> & SourceFetchOptions,
  hopsLeft: number,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const res = await fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs),
    headers,
  })
  if (REDIRECT_CODES.has(res.status)) {
    if (hopsLeft <= 0) throw new Error(`重定向超过 ${SOURCE_MAX_REDIRECTS} 跳上限`)
    const loc = res.headers.get('location')
    if (!loc) throw new Error(`HTTP ${res.status} 重定向没有 Location`)
    const next = validateSourceUrl(new URL(loc, url).toString(), opts)
    return fetchWithRedirects(next, headers, opts, hopsLeft - 1, fetchImpl)
  }
  return res
}

/** 双口径截断：先看 content-length，再按实际读到的字节数拦截。 */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`清单过大：声明 ${declared} 字节，上限 ${maxBytes} 字节`)
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`清单过大：超过 ${maxBytes} 字节上限`)
    return text
  }
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* 已结束 */
      }
      throw new Error(`清单过大：超过 ${maxBytes} 字节上限`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/** 按「主 URL → 用户镜像 →（github-raw 才有的）公共镜像」构造候选。 */
export function sourceUrls(source: SourceConfig): string[] {
  const out: string[] = [source.url, ...source.mirrors]
  if (source.type === 'github-raw') {
    for (const m of MIRRORS) {
      out.push(m.prefix + source.url)
      for (const mirror of source.mirrors) out.push(m.prefix + mirror)
    }
  }
  return [...new Set(out)]
}

/**
 * 拉取一个数据源。单个 URL 失败自动试下一个镜像，全部失败才抛错。
 *
 * 304 不算失败：`notModified=true` 且 `text=''`，调用方据此跳过解析与写池。
 */
export async function fetchSourceText(
  source: SourceConfig,
  opts: SourceFetchOptions = {}
): Promise<SourceFetchResult> {
  const timeoutMs = opts.timeoutMs ?? SOURCE_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? SOURCE_MAX_BYTES
  const headers: Record<string, string> = {
    'User-Agent': 'CFPilot-ExternalSources/1.0',
    Accept: 'text/plain, application/json, text/csv, */*',
  }
  if (source.etag) headers['If-None-Match'] = source.etag
  if (source.lastModified) headers['If-Modified-Since'] = source.lastModified

  const errors: string[] = []
  for (const raw of sourceUrls(source)) {
    let url: URL
    try {
      url = validateSourceUrl(raw, opts)
    } catch (err) {
      errors.push(`${sanitizeUrl(raw)}：${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    try {
      const res = await fetchWithRedirects(url, headers, { ...opts, timeoutMs }, SOURCE_MAX_REDIRECTS)
      if (res.status === 304) {
        return { text: '', url: sanitizeUrl(raw), etag: source.etag, lastModified: source.lastModified, notModified: true }
      }
      if (!res.ok) {
        errors.push(`${sanitizeUrl(raw)}：HTTP ${res.status}`)
        continue
      }
      const text = await readBodyLimited(res, maxBytes)
      return {
        text,
        url: sanitizeUrl(raw),
        etag: res.headers.get('etag') ?? source.etag,
        lastModified: res.headers.get('last-modified') ?? source.lastModified,
        notModified: false,
      }
    } catch (err) {
      errors.push(`${sanitizeUrl(raw)}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(errors.length > 0 ? errors.join('；') : '数据源没有可用链接')
}

/** URL 脱敏：去掉 query / fragment，避免令牌类参数进日志与采集记录。 */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '<invalid-url>'
  }
}
