/**
 * DoH 解析 + 机房落地 IP 中转
 *
 * ## 为什么需要这一层
 *
 * 自研数据面在真机上恒定抛 `TCP Loop detected`：同一个 `connect()` 在 HTTP 上下文正常、
 * 在 WebSocket 消息上下文失败，且已排除目标形态（IP / 域名 / 端口 / ProxyIP）。
 *
 * 精读 CFNext 数据面后定位到差异：它的出站函数 `Bt()` 在直连失败前会先做两件事——
 *   1. 用 DoH 查目标域名的 TXT 记录，解析出「edgetunnel」优选落地 IP 列表；
 *   2. 若目标是 Cloudflare IP，按 `request.cf.colo` 查机房映射表，
 *      改用 `proxyip.<region>.<domain>` 这类**非当前 Anycast 路径**的落地地址。
 * 它的底层连接函数 `Pt()` 与我们的 `connectWithTimeout()` 几乎一致，
 * 所以差异不在拨号本身，而在**拨号之前的目标选择**。
 *
 * 本模块用自研代码复现这套机制，不依赖任何第三方数据面。
 */

/** DoH 提供商（按优先级，任一可用即可） */
const DOH_PROVIDERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query',
]

/** 单条查询超时（ms） */
const DOH_TIMEOUT_MS = 4000

/** 解析结果缓存时长（ms） */
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  at: number
  ips: DnsAnswer[]
}

const cache = new Map<string, CacheEntry>()

export interface DnsAnswer {
  hostname: string
  port: number
}

/** 判断是否 IPv4 / IPv6 字面量 */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host)
}

/** 解析 `host:port`，缺省端口可指定 */
export function splitHostPort(text: string, defaultPort: number): { host: string; port: number } {
  const value = text.trim()
  // [IPv6]:port
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed) {
    return { host: bracketed[1]!, port: Number(bracketed[2] ?? defaultPort) }
  }
  // IPv6 无括号（含多个冒号）→ 整体是主机名
  if (value.includes(':') && value.split(':').length > 2) {
    return { host: value, port: defaultPort }
  }
  const at = value.lastIndexOf(':')
  if (at < 0) return { host: value, port: defaultPort }
  const host = value.slice(0, at)
  const port = Number(value.slice(at + 1))
  if (!host) return { host: value, port: defaultPort }
  return { host, port: Number.isInteger(port) && port > 0 ? port : defaultPort }
}

/** 带超时的 DoH JSON 查询 */
async function dohQuery(
  provider: string,
  name: string,
  type: 'TXT' | 'A' | 'AAAA',
  timeoutMs = DOH_TIMEOUT_MS
): Promise<string[]> {
  try {
    const url = `${provider}?name=${encodeURIComponent(name)}&type=${type}`
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> }
    if (!body || body.Status !== 0 || !Array.isArray(body.Answer)) return []
    const wanted = type === 'TXT' ? 16 : type === 'A' ? 1 : 28
    return body.Answer.filter((a) => a.type === wanted).map((a) => String(a.data))
  } catch {
    return []
  }
}

/** 依次尝试所有 DoH 提供商 */
async function queryAll(name: string, type: 'TXT' | 'A' | 'AAAA'): Promise<string[]> {
  for (const provider of DOH_PROVIDERS) {
    const answers = await dohQuery(provider, name, type)
    if (answers.length > 0) return answers
  }
  return []
}

/**
 * 解析域名到落地 IP 列表。
 *
 * 优先读 TXT 记录（edgetunnel 风格的优选 IP 库），
 * 回退 A / AAAA。IP 字面量直接返回自身。
 */
export async function resolveEndpointIps(
  host: string,
  port: number
): Promise<DnsAnswer[]> {
  const target = host.trim()
  if (!target) return []
  if (isIpLiteral(target)) return [{ hostname: target, port }]

  const key = `${target}:${port}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ips

  const answers: DnsAnswer[] = []

  // 1) TXT：优选 IP 库
  const txt = await queryAll(target, 'TXT')
  for (const raw of txt) {
    // TXT 记录形如 "\"1.2.3.4,5.6.7.8\"" 或含转义八进制
    const text = String(raw).replace(/^"|"$/g, '').replace(/\\010/g, ',').replace(/\n/g, ',').trim()
    if (!text) continue
    // 遇到上游哨兵值就停止（与 edgetunnel 约定一致）
    if (`@edgetunnel` === text) break
    for (const item of text.split(/[,;\s]+/)) {
      const piece = item.trim()
      if (!piece) continue
      const { host, port: p } = splitHostPort(piece, port)
      if (isIpLiteral(host)) answers.push({ hostname: host, port: p })
    }
    if (answers.length > 0) break
  }

  // 2) A 记录
  if (answers.length === 0) {
    const a = await queryAll(target, 'A')
    for (const ip of a) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) answers.push({ hostname: ip, port })
    }
  }

  // 3) AAAA 记录
  if (answers.length === 0) {
    const aaaa = await queryAll(target, 'AAAA')
    for (const ip of aaaa) {
      if (ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip)) answers.push({ hostname: ip, port })
    }
  }

  const deduped: DnsAnswer[] = []
  const seen = new Set<string>()
  for (const item of answers) {
    const k = `${item.hostname}:${item.port}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(item)
  }

  if (deduped.length > 0) cache.set(key, { at: Date.now(), ips: deduped })
  return deduped
}

/** 清空解析缓存（测试用） */
export function clearDnsCache(): void {
  cache.clear()
}
