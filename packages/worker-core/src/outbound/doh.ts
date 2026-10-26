/**
 * DoH 解析：把目标域名解析成「可用的落地 IP 列表」。
 *
 * ## 为什么需要这一层
 *
 * Worker 运行时**不能主动连回 Cloudflare 自家的 Anycast 地址**
 * （`1.1.1.1` / `cloudflare.com` / `104.16.0.1` 一律被拒，报 `TCP Loop detected`）。
 * 这意味着：
 *
 *   - 目标域名解析到 Cloudflare 网段 → **必然连不通**；
 *   - 目标域名解析到第三方 IP（如 `8.8.8.8`）→ 完全可用。
 *
 * 因此出站不能简单地「把域名丢给 `connect()` 让运行时自己解析」，
 * 必须**先解析出 IP，再判断哪些能用**，并把可用的排在前面。
 *
 * ## 机制来源（与三个成熟项目一致）
 *
 * | 项目 | 机制 |
 * |------|------|
 * | **旧版第三方实现** | `Ft()`：DoH TXT → A → AAAA，逐级回退 |
 * | **edgetunnel** | 「预加载竞速」：预解析目标域名得到候选 IP 列表，并发竞速 |
 * | **BPB** | 优选 IP 池由订阅侧预先算好，随请求传入 |
 *
 * 自研取 **旧版路线**（每次解析 + 缓存），
 * 因为它实现最简单、无预热延迟，且与本项目已有的 `outbound/route.ts` 选路模型天然契合。
 *
 * ## TXT 记录里的「优选 IP 库」是什么
 *
 * 社区约定：在目标域名的 TXT 记录里放一个 IP 列表（edgetunnel 约定用 `@edgetunnel` 作为哨兵）。
 * 例如 `example.com TXT "1.2.3.4,5.6.7.8"`。
 * 解析它得到的 IP **通常不是 Cloudflare 网段** —— 这正是「优选」的含义：
 * 挑一个从用户侧看更快、又不在 CF Anycast 段内的入口。
 *
 * ⚠️ 但不能假定如此：解析结果里**可能混入 CF 网段**，
 * 所以必须交给 `outbound/route.ts` 做降权处理，不能直接信。
 */
import { isIpv4, isIpv6 } from '../protocols/address'

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

/** 一条解析结果（落地 IP + 端口） */
export interface DnsAnswer {
  hostname: string
  port: number
}

/** `resolveEndpointIps` 的可选参数 */
export interface ResolveEndpointOptions {
  /** 单条 DoH 查询超时（ms），默认 DOH_TIMEOUT_MS */
  timeoutMs?: number
  /**
   * 整体截止时间（epoch ms）—— 把 DoH 解析纳入拨号总预算。
   *
   * 没有它时，每个域名最坏要 3 提供商 × 3 记录类型 × 4s = 36s，
   * 拨号层的 5s 超时根本覆盖不到（真机实测挂起数分钟）。
   */
  deadline?: number
  /**
   * 跳过 TXT（社区「优选 IP 库」）查询。
   *
   * 用于**反代入口域名**这类确定没有 TXT 记录的场合：
   * 反代域名无 TXT，逐提供商试错纯属浪费 —— 每个域名白烧 3 次子请求，
   * 14 个域名就是 42 次，直接顶穿 Worker 免费计划 50 次/调用 的上限。
   */
  skipTxt?: boolean
}

/** 判断是否 IPv4 / IPv6 字面量 */
export function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host)
}

/**
 * 解析 `host:port`，缺省端口用 `defaultPort`。
 *
 * 与归档实现一致，但 `host` 命名从 `hostname` 统一为 `host`，
 * 以对齐 `outbound/route.ts` 的字段命名。
 */
export function splitHostPort(text: string, defaultPort: number): { host: string; port: number } {
  const value = text.trim()
  // [IPv6]:port
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed) {
    return { host: bracketed[1]!, port: Number(bracketed[2] ?? defaultPort) }
  }
  // 裸 IPv6（无括号，含多个冒号）→ 整体是主机名
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
    const body = (await response.json()) as {
      Status?: number
      Answer?: Array<{ type: number; data: string }>
    }
    if (!body || body.Status !== 0 || !Array.isArray(body.Answer)) return []
    const wanted = type === 'TXT' ? 16 : type === 'A' ? 1 : 28
    return body.Answer.filter((a) => a.type === wanted).map((a) => String(a.data))
  } catch {
    return []
  }
}

/** 依次尝试所有 DoH 提供商 */
async function queryAll(
  name: string,
  type: 'TXT' | 'A' | 'AAAA',
  opts: ResolveEndpointOptions = {}
): Promise<string[]> {
  for (const provider of DOH_PROVIDERS) {
    // 预算耗尽后不再发起新查询（已在飞的不受控，但至少不新增）
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    const perQuery = opts.timeoutMs ?? DOH_TIMEOUT_MS
    const remaining = opts.deadline !== undefined ? opts.deadline - Date.now() : Number.POSITIVE_INFINITY
    const budget = Math.max(50, Math.min(perQuery, remaining))
    const answers = await dohQuery(provider, name, type, budget)
    if (answers.length > 0) return answers
  }
  return []
}

/**
 * 从一条 TXT 记录里提取 IP 列表。
 *
 * 记录形如 `"1.2.3.4,5.6.7.8"`，可能带转义逗号（`\010`）与转义引号。
 * 遇到 `@edgetunnel` 哨兵即停止（社区约定，之后的记录是给客户端看的）。
 *
 * ## ⚠️ 为什么要求「整条记录都是 IP」
 *
 * 目标域名的 TXT 记录里**绝大多数不是优选 IP 库**，而是 SPF、域名验证、
 * 邮件签名等。实测样例：
 *
 * ```
 * example.com        TXT "v=spf1 -all"
 * example.com        TXT "_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9"
 * www.cloudflare.com TXT "canva-site-verification=oOyaVnHC-OiFoR1BPvetNA"
 * github.com         TXT "MS=6BF03E6AF5CB689E315FB6199603BABF2C88D805"
 * ```
 *
 * 若只做「从记录里挑出形似 IP 的片段」，
 * `v=spf1 ip4:1.2.3.4 -all` 这类 SPF 记录会被误当成优选 IP 库
 * —— 于是所有出站都被导向 1.2.3.4，且**没有任何报错**（最难查的一类故障）。
 *
 * 因此这里采用**严格判定**：整条记录去掉引号后，
 * 必须是「IP 或 host:port」组成的列表，**不能混有其它 token**。
 * 社区优选库的格式恰好满足这一点（TXT 里放的就是纯 IP 列表）。
 */
export function parseTxtIps(txt: string, defaultPort: number): DnsAnswer[] {
  const out: DnsAnswer[] = []
  const text = String(txt)
    .replace(/^"|"$/g, '')
    .replace(/\\010/g, ',')
    .replace(/\\n/g, ',')
    .trim()
  if (!text) return out
  if (text === '@edgetunnel') return out

  const items = text.split(/[,;\s]+/).filter(Boolean)
  if (items.length === 0) return out

  for (const item of items) {
    const piece = item.trim()
    if (!piece) continue
    const { host, port } = splitHostPort(piece, defaultPort)
    // 严格判定：必须**本身就是**一个 IP 字面量。
    // 像 `ip4:1.2.3.4`（SPF 语法）会因 host 不是纯 IP 而被拒绝。
    if (!isIpv4(host) && !isIpv6(host)) return []
    out.push({ hostname: host, port })
  }
  return out
}

/**
 * 解析域名到落地 IP 列表。
 *
 * 优先读 TXT 记录（社区「优选 IP 库」），
 * 回退 A / AAAA。IP 字面量直接返回自身。
 *
 * ⚠️ 返回结果**未按 Cloudflare 网段过滤** ——
 * 过滤与降权由 `outbound/route.ts` 统一处理（它知道 CF 网段表）。
 */
export async function resolveEndpointIps(
  host: string,
  port: number,
  opts: ResolveEndpointOptions = {}
): Promise<DnsAnswer[]> {
  const target = host.trim()
  if (!target) return []
  if (isIpLiteral(target)) return [{ hostname: target, port }]

  const key = `${target}:${port}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ips

  const answers: DnsAnswer[] = []

  // 1) TXT：优选 IP 库（反代入口等无 TXT 的场合可跳过，见 skipTxt）
  if (!opts.skipTxt) {
    const txt = await queryAll(target, 'TXT', opts)
    for (const raw of txt) {
      const parsed = parseTxtIps(raw, port)
      if (parsed.length > 0) {
        answers.push(...parsed)
        break
      }
      // 遇到哨兵说明这个域名的 TXT 里没有优选 IP 库
      const normalized = String(raw).replace(/^"|"$/g, '').replace(/\\010/g, ',').trim()
      if (normalized === '@edgetunnel') break
    }
  }

  // 2) A 记录
  if (answers.length === 0) {
    const a = await queryAll(target, 'A', opts)
    for (const ip of a) {
      if (isIpv4(ip)) answers.push({ hostname: ip, port })
    }
  }

  // 3) AAAA 记录
  if (answers.length === 0) {
    const aaaa = await queryAll(target, 'AAAA', opts)
    for (const ip of aaaa) {
      if (isIpv6(ip)) answers.push({ hostname: ip, port })
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
