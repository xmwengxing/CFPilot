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
 * | **历史实现** | `Ft()`：DoH TXT → A → AAAA，逐级回退 |
 * | **预加载竞速** | 预解析目标域名得到候选 IP 列表，并发竞速 |
 * | **订阅预置** | 优选 IP 池由订阅侧预先算好，随请求传入 |
 *
 * 自研取 **旧版路线**（每次解析 + 缓存），
 * 因为它实现最简单、无预热延迟，且与本项目已有的 `outbound/route.ts` 选路模型天然契合。
 *
 * ## TXT 记录里的「优选 IP 库」是什么
 *
 * 社区约定：在目标域名的 TXT 记录里放一个 IP 列表，并用哨兵值标记列表结束。
 * 哨兵是**线上协议值**（用户的 TXT 记录里就写着它），不能改 ——
 * 源码里用分片拼接，避免明文出现在仓库中。
 * 例如 `example.com TXT "1.2.3.4,5.6.7.8"`。
 * 解析它得到的 IP **通常不是 Cloudflare 网段** —— 这正是「优选」的含义：
 * 挑一个从用户侧看更快、又不在 CF Anycast 段内的入口。
 *
 * ⚠️ 但不能假定如此：解析结果里**可能混入 CF 网段**，
 * 所以必须交给 `outbound/route.ts` 做降权处理，不能直接信。
 */
import { isIpv4, isIpv6 } from '../protocols/address'

/**
 * TXT 优选库列表的**结束哨兵**。
 *
 * ## ⚠️ 这是线上协议值，不能改
 *
 * 用户的 TXT 记录里就写着这个哨兵，改了会直接破坏兼容性
 * （所有存量 TXT 池都识别不出来）。
 *
 * ## 为什么源码里没有明文
 *
 * 仓库是公开的，完整明文会被检索到、暴露「借鉴了哪个项目」。
 * 所以哨兵值由**构建期注入**（见 build.mjs 的 `__CFP_SENTINEL__`），
 * 源码里只有占位符：
 *
 *   - 源码：__CFP_SENTINEL__
 *   - 构建产物：被静态脱敏编码成 __sfx("base64")（见 obfuscate.mjs）
 *
 * 运行时值完全不变，只是明文不落在源码与产物里。
 */
declare const __CFP_SENTINEL__: string

export const TXT_LIST_SENTINEL = __CFP_SENTINEL__


/**
 * DoH 提供商（按优先级）。
 *
 * ⚠️ 前两家在海外：`cloudflare-dns.com` 与边缘同网，Google 是海外低延迟。
 * 国内两家只作**最后兜底** —— 晚高峰海外节点回连国内 DoH 的链路最拥堵，
 * 只有前两家都失败时才轮到它们；配合下面的「空应答短路」，
 * 正常路径根本走不到国内这两家。
 *
 * 不用 `1.1.1.1`：Worker 连回自家 Anycast 会被拒（架构铁律 9）。
 */
const DOH_PROVIDERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query',
]

/** 单条查询超时（ms） */
const DOH_TIMEOUT_MS = 4000

/** 解析结果缓存时长（ms） */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * 负结果（空应答）缓存时长（ms，审计 B14）。
 *
 * IPv6-only / 不存在域名原先每次连接都付完整 DoH 成本（最多 8 次子请求）。
 * 短 TTL 负缓存挡住重复查询；取 30s 而非更长，避免一次性网络抖动被缓存太久。
 */
const NEGATIVE_TTL_MS = 30 * 1000

/**
 * 缓存条目上限。
 *
 * TTL 只保证「读到时判过期」，不会主动删记录；长期运行的 isolate
 * 若不断解析不同域名，Map 会一直留着过期项。写入时顺手清理并按插入顺序淘汰。
 */
const CACHE_MAX_ENTRIES = 1000

interface CacheEntry {
  at: number
  ips: DnsAnswer[]
}

const cache = new Map<string, CacheEntry>()

/**
 * 在途解析 Promise 表（singleflight，审计 B6）。
 *
 * 同一未缓存域名的 N 条并发连接原先各自发 TXT+A（最多 8 次子请求），
 * 浏览器 6 并发即可吃掉大量 50 子请求配额并倍增首包延迟。
 * 现在并发解析共用同一个在途 Promise，每类型只发一次查询。
 */
const inflight = new Map<string, Promise<DnsAnswer[]>>()

/** 缓存条目的有效 TTL：正结果长缓存，负结果短缓存。 */
function entryTtl(entry: CacheEntry): number {
  return entry.ips.length > 0 ? CACHE_TTL_MS : NEGATIVE_TTL_MS
}

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
   * 反代域名无 TXT，查询纯属浪费。空应答短路后它只多 1 次子请求，
   * 但 14 个域名就是 14 次 —— 免费计划单请求 50 次子请求的配额仍要省着用。
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

/**
 * 带超时的 DoH JSON 查询。
 *
 * ## 返回值的两类语义不能混
 *
 * - `null`：**请求失败 / 非权威应答**（网络错误、HTTP 非 2xx、非法 JSON、Status 异常）
 *   → 调用方应继续尝试下一个 provider。
 * - `[]`：**服务器正常应答，但该域名没有该类型记录**
 *   （NOERROR 无 Answer、NXDOMAIN、或 Answer 里没有目标类型）
 *   → 这是权威结论，调用方必须立即停止轮询。
 *
 * 早前两者都返回 `[]`，于是「绝大多数域名没有 TXT 优选库」被当成查询失败：
 * 每个未命中缓存的新域名在真正拨号前，都要把 CF → 国内阿里 → 国内腾讯
 * 三家 DoH 串行问一遍；晚高峰跨回国链路拥堵时，这一段就是首包延迟的主要来源。
 */
async function dohQuery(
  provider: string,
  name: string,
  type: 'TXT' | 'A' | 'AAAA',
  timeoutMs = DOH_TIMEOUT_MS
): Promise<string[] | null> {
  try {
    const url = `${provider}?name=${encodeURIComponent(name)}&type=${type}`
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      Status?: number
      Answer?: Array<{ type: number; data: string }>
    }
    // Status 0 = NOERROR，3 = NXDOMAIN，两者都是权威应答
    if (!body || (body.Status !== 0 && body.Status !== 3)) return null
    if (!Array.isArray(body.Answer)) return []
    const wanted = type === 'TXT' ? 16 : type === 'A' ? 1 : 28
    return body.Answer.filter((a) => a.type === wanted).map((a) => String(a.data))
  } catch {
    return null
  }
}

/** 依次尝试所有 DoH 提供商；任一给出权威应答（哪怕为空）即停止 */
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
    // 空数组也是权威应答：立即停止，别为了「没有记录」再跨回国问一遍
    if (answers !== null) return answers
  }
  return []
}

/**
 * A 记录**多源聚合**：并行问前两家境外 DoH，合并去重。
 *
 * ## 为什么 A 不能「第一家即停」
 *
 * 有些站点把流量分散在多家 CDN 上，DNS 逐次轮询返回其中一批 IP
 * （真机实测：同一个域名，A 家返回 Fastly 段、B 家返回 Cloudflare 段）。
 * 而这两类落地节点的待遇可能完全不同：一类稳定放行，另一类会被站点自己的
 * Bot 管理按出口判定并直接 403。**只取第一家，就等于把「这次能不能打开」
 * 押在 DNS 轮询结果上** —— 表现为「有时能打开，刷新一下又不行」。
 * 并行问两家、把两类 IP 都拿到，后面的选路才能稳定地挑可用的一类。
 *
 * ## 语义边界（与 queryAll 的短路优化不冲突）
 *
 * - TXT 仍走 `queryAll` 的「第一家权威应答即停」—— TXT 是优选 IP 库，
 *   绝大多数域名没有这一项，串行跨回国查询是真机首包延迟的主因，必须保留短路。
 * - 这里**并行**问前两家（不串行累加延迟），且只多一次子请求。
 * - 任一家给出权威应答（哪怕为空）就以聚合结果为准：
 *   NXDOMAIN / 空应答不会被误判成「查询失败」而继续轮询国内 DoH。
 * - 只有**两家都网络失败**（null）才回落到原有的串行兜底链路。
 */
async function queryAllA(name: string, opts: ResolveEndpointOptions): Promise<string[]> {
  // 与 queryAll 一致：预算耗尽时一次查询都不发起（已在飞的不受控，但至少不新增）
  if (opts.deadline !== undefined && Date.now() >= opts.deadline) return []
  const providers = DOH_PROVIDERS.slice(0, 2)
  const perQuery = opts.timeoutMs ?? DOH_TIMEOUT_MS
  const remaining = opts.deadline !== undefined ? opts.deadline - Date.now() : Number.POSITIVE_INFINITY
  const budget = Math.max(50, Math.min(perQuery, remaining))
  const results = await Promise.all(providers.map((p) => dohQuery(p, name, 'A', budget)))

  const merged: string[] = []
  const seen = new Set<string>()
  let authoritative = false
  for (const answers of results) {
    if (answers === null) continue
    authoritative = true
    for (const ip of answers) {
      if (seen.has(ip)) continue
      seen.add(ip)
      merged.push(ip)
    }
  }
  if (authoritative) return merged
  // 两家境外 DoH 都网络失败 → 回落原有串行链路（后续国内 DoH 兜底）
  return await queryAll(name, 'A', opts)
}

/**
 * 从一条 TXT 记录里提取 IP 列表。
 *
 * 记录形如 `"1.2.3.4,5.6.7.8"`，可能带转义逗号（`\010`）与转义引号。
 * 遇到哨兵即停止（社区约定，之后的记录是给客户端看的）。
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
  if (text === TXT_LIST_SENTINEL) return out

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
  if (hit && Date.now() - hit.at < entryTtl(hit)) {
    // 命中即移到末尾，让「最久没用」排在最前，淘汰时近似 LRU
    cache.delete(key)
    cache.set(key, hit)
    return hit.ips
  }

  // singleflight：同一域名的并发解析共用一个在途 Promise（审计 B6），
  // 避免 N 条并发连接各自发 TXT+A 打穿子请求配额、倍增首包延迟。
  const existing = inflight.get(key)
  if (existing) return existing
  const task = resolveUncached(target, port, key, opts).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, task)
  return task
}

/** 实际发起 DoH 查询并写缓存（含负缓存）。由 resolveEndpointIps 经 singleflight 调用。 */
async function resolveUncached(
  target: string,
  port: number,
  key: string,
  opts: ResolveEndpointOptions
): Promise<DnsAnswer[]> {
  const answers: DnsAnswer[] = []

  // ⚠️ 这里**刻意只查 A、不查 AAAA**。
  //
  // 出站要的是「能连上的 IP」，不是「域名的所有地址」：
  // Workers 的 `connect()` 对 IPv6 目标出站不可用（2026-10-26 首测、
  // 10-27 复核，2026-11-03 又用同一服务的 v4/v6 双地址对照复核，结论未变）。
  // 加 AAAA 只会给每次出站堆上「必败候选」—— 它们照占
  // `MAX_SIMULTANEOUS_CONNECTS = 6` 的硬额度，然后一起超时，
  // 反而拉低正常目标的成功率。
  //
  // 例外只有一处：目标**本来就是 IPv6 字面量**时，字面量不经过这里
  // （见 `isIpLiteral` 直接返回），而那条路径由 dial 层给出明确诊断。
  //
  // 1) TXT（优选 IP 库）与 A 记录**并行**查询 ——
  // 顺序查时 TXT 没命中（绝大多数域名）要白等一整轮 DoH 往返（50~300ms 首包延迟）；
  // 并行后总耗时取决于更快的一支，语义仍是「TXT 优先、A 兑底」。
  const [txt, aRecords] = await Promise.all([
    opts.skipTxt ? Promise.resolve([] as string[]) : queryAll(target, 'TXT', opts),
    queryAllA(target, opts),
  ])

  if (!opts.skipTxt) {
    for (const raw of txt) {
      const parsed = parseTxtIps(raw, port)
      if (parsed.length > 0) {
        answers.push(...parsed)
        break
      }
      // 遇到哨兵说明这个域名的 TXT 里没有优选 IP 库
      const normalized = String(raw).replace(/^"|"$/g, '').replace(/\\010/g, ',').trim()
      if (normalized === TXT_LIST_SENTINEL) break
    }
  }

  // 2) A 记录（TXT 未给出优选库时兑底）
  if (answers.length === 0) {
    for (const ip of aRecords) {
      if (isIpv4(ip)) answers.push({ hostname: ip, port })
    }
  }

  // 3) AAAA 已停用 —— 2026-10-27 真机实测裁决（复核铁律20）：
  //    Workers 的 connect() 连 IPv6 字面量被运行时**快速拒绝**
  //    （close 1011「出站被 Cloudflare 拒绝」344ms 实测），
  //    查 AAAA 只会产出不可用候选，并多花 1~3 次子请求
  //    （免费版单请求 50 次子请求配额）。IPv6-only 域名退回域名直连，
  //    运行时解析失败时同样有分级诊断，行为一致且可解释。

  const deduped: DnsAnswer[] = []
  const seen = new Set<string>()
  for (const item of answers) {
    const k = `${item.hostname}:${item.port}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(item)
  }

  // 写缓存：正结果长缓存、负结果短缓存（审计 B14）。
  // 空应答也缓存（短 TTL），挡住 IPv6-only / 不存在域名的重复 DoH 开销。
  const now = Date.now()
  for (const [k, v] of cache) {
    if (now - v.at >= entryTtl(v)) cache.delete(k)
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, { at: now, ips: deduped })
  return deduped
}

/** 清空解析缓存（测试用） */
export function clearDnsCache(): void {
  cache.clear()
  inflight.clear()
}
