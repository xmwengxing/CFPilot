/**
 * Cloudflare IP 段库与地址采样
 *
 * 优先从 cloudflare.com/ips-v4、/ips-v6 拉取权威列表，
 * 网络不可用时回退到内置的 Free Plan 友好型网段。
 *
 * ## 网段可用率加权
 *
 * Cloudflare 的 IPv4 空间里大部分是区域/租户专用分配，对普通站点没有配置。
 * 真机实测（VLESS over WS 101 校验，每段 12 个 IP，用户域名
 * `cfpilot.shijingtian.de5.net`）：
 *
 * | 网段 | 通过率 |
 * |------|--------|
 * | `104.16.0.0/13` | 8/12（最好） |
 * | `104.24.0.0/14` | 7/12 |
 * | `103.21.244.0/22` | 3/12 |
 * | `103.31.4.0/22` | 3/12 |
 * | `190.93.240.0/20` | 3/12 |
 * | `188.114.96.0/20` | 3/12 |
 * | `141.101.64.0/18` | 2/12 |
 * | `162.158.0.0/15` | 2/12 |
 * | `172.64.0.0/13` | 1/12 |
 * | `173.245.48.0/20` | **0/12** |
 * | `103.22.200.0/22` | **0/12** |
 * | `108.162.192.0/18` | **0/12** |
 * | `197.234.240.0/22` | **0/12** |
 * | `198.41.128.0/17` | **0/12** |
 * | `131.0.72.0/22` | **0/12** |
 *
 * 若按网段**大小**比例分配采样预算，一半以上的候选会来自 0% 可用的网段 ——
 * 真机表现为「阶段一过后只剩零星候选、阶段二全军覆没」。
 *
 * 因此这里给每个网段一个**可用率权重**，采样预算按
 * 「大小 × 权重」分配，把候选集中到真正能用的网段。
 *
 * ⚠️ 权重是启发式，会随 Cloudflare 的分区调整过期。
 * 改这张表前先用实测数据说话（`101 通过率`），别照抄。
 */

/** 内置 IPv4 网段（Cloudflare 官方公布的主要段） */
export const BUILTIN_IPV4_CIDRS: string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]

/**
 * IPv4 网段的可用率权重（0~1）。
 *
 * 未列出的网段用 `DEFAULT_CIDR_WEIGHT`。
 * 采样预算按 `size × weight` 分配，因此：
 *   - 权重 0 的网段**完全不参与采样**（实测 0/12，采了也是浪费）
 *   - 权重高的网段拿到更多候选
 *
 * ⚠️ **粒度问题**：权重是按整段给的，但 Cloudflare 的实际可用性可能细到 /24。
 * 实测：同一个 `103.21.244.0/22` 里 `103.21.244.x` 16/16 全过，
 * 而 `103.21.245.x` 0/14 全挂。因此低权重的网段仍会采到一些废 IP ——
 * 这是「宁可多采不可漏采」的权衡，真正的剔除靠阶段二的 101 + PING 校验。
 *
 * ## 2026-10-28 复测（TUN 关闭、直连、每段随机 12 IP、非超时失败重试一次）
 *
 * | 网段 | 旧表 | 复测 | 失败形态 | colo |
 * |------|------|------|---------|------|
 * | `104.16.0.0/13` | 8/12 | 7/12 | 5×timeout | LAX/AMS |
 * | `104.24.0.0/14` | 7/12 | **11/12** | 1×timeout | AMS |
 * | `188.114.96.0/20` | 3/12 | **9/12** | 3×timeout | AMS/LHR |
 * | `172.64.0.0/13` | 1/12 | **5/12** | 7×timeout | LHR/LAX/AMS/SIN |
 * | `162.158.0.0/15` | 2/12 | 4/12 | 5×timeout | LAX/SJC/AMS |
 * | `103.21.244.0/22` | 3/12 | 4/12 | 8×timeout | LAX |
 * | `103.31.4.0/22` | 3/12 | 3/12 | 9×timeout | DEN |
 * | `190.93.240.0/20` | 3/12 | 2/12 | 10×timeout | LAX |
 * | `173.245.48.0/20` | 0/12 | 1/12 | 10×timeout | LAX |
 * | `141.101.64.0/18` | 2/12 | **0/12** | 11×timeout | — |
 * | `103.22.200.0/22` / `197.234.240.0/22` / `198.41.128.0/17` / `131.0.72.0/22` | 0/12 | 0/12 | **TCP 本身就不通** | — |
 * | `108.162.192.0/18` | 0/12 | 0/12 | TCP 3/3 可连，但 TLS/HTTP 不应答 | — |
 *
 * 结论：
 *   1. 压到 0 的 5 段里 **4 段是 TCP 层不可达**，不是测错；
 *   2. 但 `188.114.96.0/20`（3→9）与 `172.64.0.0/13`（1→5）**确实被低估**，
 *      已按复测结果加权 —— 这就是「误杀有效网段」的真实案例；
 *   3. 权重是启发式且会过期，改表前先用上面这套方法复测。
 */
export const IPV4_CIDR_WEIGHTS: Readonly<Record<string, number>> = {
  '104.16.0.0/13': 0.9, // 复测 7/12（旧表按 8/12 给 1.0）
  '104.24.0.0/14': 0.95, // 复测 11/12，最好的一段（旧表 0.9）
  '188.114.96.0/20': 0.75, // 复测 9/12（旧表 0.3 —— 被低估 3 倍）
  '172.64.0.0/13': 0.55, // 复测 5/12；2026-10-29 用户侧实测该段出过 9.3 MB/s(NRT)，不宜压太低
  '103.21.244.0/22': 0.35, // 复测 4/12
  '103.31.4.0/22': 0.3, // 复测 3/12
  '190.93.240.0/20': 0.25, // 复测 2/12
  '162.158.0.0/16': 0.3, // 复测 4/12（162.158.x 为边缘节点，可用）
  // 162.159.x.x 是 Cloudflare 的管理 / API 网段，真机实测**多数**返回
  // HTTP 403（反爬风控），但**并非全部**——用户实测 162.159.237.59 可用
  // （2.8 MB/s），本地复测同样通过（SJC）。
  //
  // 因此**不能压到 0**（会错杀可用 IP），给一个很低的权重：
  // 仍能采到少量候选，但不让大量 403 IP 占据阶段二额度。
  //
  // ⚠️ 教训：权重粒度为 /16，但实际可用性可能细到单个 IP。
  // 实测样本只有 9 个就下「完全不可用」的结论过于草率。
  '162.159.0.0/16': 0.05,
  '141.101.64.0/18': 0.05, // 复测 0/12（旧表 0.2 —— 高估了；样本小，留一点探针）
  '173.245.48.0/20': 0.05, // 复测 1/12（旧表 0 —— 至少还能出个把可用 IP）
  // 实测 0/12 且 **TCP 层不可达** —— 不采样
  '103.22.200.0/22': 0,
  '197.234.240.0/22': 0,
  '198.41.128.0/17': 0,
  '131.0.72.0/22': 0,
  // TCP 可连但 TLS/HTTP 不应答（区域 / 租户专用分配，对普通站点没有配置）
  '108.162.192.0/18': 0,
}

/** 未列入权重表的网段的默认权重（保守：给一个中等偏低的值） */
export const DEFAULT_CIDR_WEIGHT = 0.2

/**
 * Cloudflare IPv6 网段的可用率权重（0~1），**按 /48 粒度**。
 *
 * ## 为什么 v6 必须自成一张表、且默认 0
 *
 * 2026-11-03 实测（本机原生 IPv6，SNI = 自己的数据面域名，端口 443）：
 *
 * | 采样方式 | 结果 |
 * |---|---|
 * | 在**公布聚合段**（`ips-v6` 的 /32、/29）里随机取 /48 | **0/18 全超时** |
 * | 在**已知活跃 /48** 内随机取 /64、随机 IID | TCP 6/6、TLS 4/4、**WS101 8/8** |
 *
 * 结论：**IPv6 的可用性粒度是 /48，且只有少数 /48 真的在用** ——
 * 公布段是「分配」不是「在用」，在里面盲采等于把预算全烧掉。
 * 所以未列入本表的 v6 网段默认权重 **0（不参与采样）**，
 * 与 IPv4 的 `DEFAULT_CIDR_WEIGHT = 0.2`（宁可多采）**取值相反**，这是有意的。
 *
 * ## 证据强度
 *
 * - **1**：WS101 真连接校验通过（最强证据，可直接当候选用）
 * - **0**：实测不可用 —— 要么 TCP 层不通，要么 TCP/TLS 全通但 WS101 回 403
 *
 * ⚠️ 只有**两档，没有中间档**。曾经给「仅 TCP 通」的段留了 0.5，
 * 结果复测发现其中 4 段 WS101 **12/12 全 403** —— 中间档只会让预算
 * 流向注定出不了结果的段。判据只认 WS101，不认 TCP。
 *
 * ⚠️ 同 IPv4 权重表一样，这张表是**启发式且会漂移**（CF 会调整分区）。
 * **改表前必须复测**，复现方法：
 * ```
 * cfpilot scan --host <你的数据面域名> --family v6 --sample 300 --json --no-callback
 * ```
 * 看 `passRateByFamily.v6` 与各 /48 的机房分布；WS101 通过率才是判据，
 * **不能只看 TCP**（本表里 `2400:cb00:2049` 就是 TCP/TLS 全通但 WS101 回 403）。
 *
 * ## 机房分布（同一 /48 内地址等价，差异在 /48 之间）
 *
 * `2606:4700:3035` / `3030` → AMS；`2606:4700:10` / `20` → FRA；`2a06:98c1:3100` → SIN。
 * 所以 v6 侧的「网段分散」应当按 48 位前缀做（对应 IPv4 的前两段）。
 */
export const IPV6_PREFIX_WEIGHTS: Readonly<Record<string, number>> = {
  // ---- WS101 实测通过（1.0）----
  '2606:4700:3035::/48': 1, // 自己域名 AAAA 所在段，WS101 → AMS
  '2606:4700:3037::/48': 1, // 自己域名 AAAA 所在段，WS101 → AMS
  '2606:4700:3030::/48': 1, // 随机 IID ×2 → AMS
  '2606:4700:10::/48': 1, // 随机 IID ×2 → FRA
  '2606:4700:20::/48': 1, // 随机 IID ×2 → FRA
  '2a06:98c1:3100::/48': 1, // 随机 IID ×2 → SIN（只实测到 48 位前缀这一级，其余未验，不夸大）
  '2606:4700::/48': 1, // cloudflare.com AAAA 所在段；2026-11-03 扫描实测 WS101 → SJC
  '2606:4700:1::/48': 1, // 2026-11-03 扫描实测 WS101 → SJC
  // ---- 实测不可用（0）----
  '2400:cb00:2048::/48': 0, // 随机 /64 ×4 全超时（TCP 层就不通）
  '2400:cb00:2049::/48': 0, // TCP/TLS 全通但 WS101 回 403 —— 「活跃 ≠ 可用」的实例
  // 以下 4 段 2026-11-03 复测：TCP/TLS 全通，WS101 **12/12 全部 403**。
  // 它们在一次扫描里吃掉了 42/120 的阶段二名额却一条都出不来，
  // 必须降到 0，把预算让给真正可用的段。
  '2606:4700:50::/48': 0,
  '2606:4700:58::/48': 0,
  '2803:f800:50::/48': 0,
  '2a06:98c1:50::/48': 0,
}

/**
 * 把 IPv6 网段归一成 `h1:h2:h3::/48` 形式。
 *
 * 与 `network-profile.ts` 的 `networkBucket()` **逐字节一致** —— 观测就是用
 * `networkBucket` 写进档案的，两边格式差一个 `0` 就永远查不到历史
 * （v6 观测学不到的坑就是这么来的）。
 *
 * ⚠️ 所以表里写 `2606:4700::/48` 还是 `2606:4700:0::/48` 都可以，
 * 导出的清单会统一归一成后者。
 */
export function ipv6Prefix48(cidr: string): string {
  const parsed = parseCidr(cidr)
  if (!parsed || parsed.family !== 6) return ''
  const groups = [112n, 96n, 80n].map((shift) => ((parsed.base >> shift) & 65535n).toString(16))
  return `${groups[0]}:${groups[1]}:${groups[2]}::/48`
}

/** 未列入 IPv6 权重表的网段的默认权重：**不采样**（见 IPV6_PREFIX_WEIGHTS 注释）。 */
export const DEFAULT_IPV6_CIDR_WEIGHT = 0

/** 实测活跃的 IPv6 /48（权重 > 0，已归一成 networkBucket 形式），供预检金丝雀与「只在活跃段内采样」使用。 */
export const IPV6_ACTIVE_PREFIXES: readonly string[] = Object.entries(IPV6_PREFIX_WEIGHTS)
  .filter(([, w]) => w > 0)
  .map(([cidr]) => ipv6Prefix48(cidr))

/** 实测不可用的 IPv6 前缀（权重 = 0，已归一成 networkBucket 形式）。 */
export const IPV6_DEAD_PREFIXES: readonly string[] = Object.entries(IPV6_PREFIX_WEIGHTS)
  .filter(([, w]) => w <= 0)
  .map(([cidr]) => ipv6Prefix48(cidr))


/**
 * 取某个网段的可用率权重。
 *
 * ## 为什么不能只做精确匹配
 *
 * 官方返回的网段是 `162.158.0.0/15`（覆盖 162.158 与 162.159 两个 /16），
 * 但两者的可用性天差地别：`162.158.x` 是边缘节点（部分可用），
 * `162.159.x` 是管理 / API 网段（真机实测大量 HTTP 403）。
 *
 * 因此这里用**最长前缀匹配**：把候选网段与表中每一项比对，
 * 取前缀长度最长（最具体）且能覆盖候选的那个权重。
 */
/**
 * 权重表的预解析结果（模块加载时构建一次）。
 *
 * 旧实现每次调用 cidrWeight 都重新 parseCidr 整张表 ——
 * 表里有几十条网段，而 expandCidrs 会对每个网段调用一次，
 * 相当于重复解析几千次常量。
 */
interface WeightEntry {
  base: bigint
  prefix: number
  weight: number
}

/** 把一张「CIDR → 权重」表预解析成可做最长前缀匹配的结构。 */
function buildWeightEntries(src: Readonly<Record<string, number>>, family: 4 | 6): WeightEntry[] {
  const out: WeightEntry[] = []
  for (const [cidr, weight] of Object.entries(src)) {
    const parsed = parseCidr(cidr)
    if (!parsed || parsed.family !== family) continue
    out.push({ base: parsed.base, prefix: parsed.prefix, weight })
  }
  return out
}

const WEIGHT_TABLE_V4: WeightEntry[] = buildWeightEntries(IPV4_CIDR_WEIGHTS, 4)
const WEIGHT_TABLE_V6: WeightEntry[] = buildWeightEntries(IPV6_PREFIX_WEIGHTS, 6)

/**
 * 最长前缀匹配：在表里找「能覆盖 parsed 的最具体网段」的权重。
 *
 * ## 为什么必须按位宽右移
 *
 * 归一化到「前 entry.prefix 位」再比较：
 * `parsed.base >> (bits - entry.prefix)`。
 * ⚠️ `bits` 对 IPv4 是 32、对 IPv6 是 **128** ——
 * 旧实现写死 32，喂 IPv6 网段会右移错位、匹配到完全无关的条目。
 */
function lpmWeight(table: readonly WeightEntry[], parsed: ParsedCidr, bits: number, fallback: number): number {
  let bestPrefix = -1
  let bestWeight = fallback
  for (const entry of table) {
    // entry 必须能覆盖 parsed：前缀更短（或相等）
    if (entry.prefix > parsed.prefix) continue
    const parsedNorm = parsed.base >> BigInt(bits - entry.prefix)
    const tableNorm = entry.base >> BigInt(bits - entry.prefix)
    if (parsedNorm !== tableNorm) continue
    if (entry.prefix > bestPrefix) {
      bestPrefix = entry.prefix
      bestWeight = entry.weight
    }
  }
  return bestWeight
}

/**
 * 取某个网段的可用率权重。
 *
 * IPv4 查 `IPV4_CIDR_WEIGHTS`（默认 0.2），IPv6 查 `IPV6_PREFIX_WEIGHTS`（默认 **0**）。
 * 两族默认值不同是刻意的：IPv4 是「宁可多采」，IPv6 是「没实测过的一律不采」
 * —— 因为在公布段里盲采实测 0/18（见 IPV6_PREFIX_WEIGHTS 注释）。
 */
export function cidrWeight(cidr: string): number {
  const normalized = cidr.trim()
  const parsed = parseCidr(normalized)
  if (!parsed) return DEFAULT_CIDR_WEIGHT

  if (parsed.family === 6) {
    // 1) 精确匹配优先
    const exact = IPV6_PREFIX_WEIGHTS[normalized]
    if (exact !== undefined) return exact
    // 2) 最长前缀匹配（如 /48 条目覆盖同段内的 /64）
    return lpmWeight(WEIGHT_TABLE_V6, parsed, 128, DEFAULT_IPV6_CIDR_WEIGHT)
  }

  // 1) 精确匹配优先
  if (normalized in IPV4_CIDR_WEIGHTS) return IPV4_CIDR_WEIGHTS[normalized]!
  // 2) 最长前缀匹配
  return lpmWeight(WEIGHT_TABLE_V4, parsed, 32, DEFAULT_CIDR_WEIGHT)
}

/**
 * 生成本次调用专用的权重函数：把**运行期发现的活跃前缀**（目标域名 AAAA 展开而来）
 * 合并进静态表。
 *
 * 为什么需要它：静态表会漂移，而用户自己域名的 AAAA **永远指向当下真正在用的 /48**。
 * 把它并进来，即使静态表过期，v6 采样也还能找到可用段。
 */
export function makeWeightFn(extra?: Readonly<Record<string, number>>): (cidr: string) => number {
  const entries = extra ? buildWeightEntries(extra, 6) : []
  if (entries.length === 0) return cidrWeight
  const merged = [...entries, ...WEIGHT_TABLE_V6]
  const extraMap = extra!
  return (cidr: string): number => {
    const parsed = parseCidr(cidr.trim())
    if (!parsed) return DEFAULT_CIDR_WEIGHT
    if (parsed.family !== 6) return cidrWeight(cidr)
    const exact = extraMap[cidr.trim()]
    if (exact !== undefined) return exact
    return lpmWeight(merged, parsed, 128, DEFAULT_IPV6_CIDR_WEIGHT)
  }
}


/** 内置 IPv6 网段 */
export const BUILTIN_IPV6_CIDRS: string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]

export interface IpRangeOptions {
  /** 中性采样：忽略权重，按网段大小等比采样（只保留权重 0 的不可达段） */
  neutral?: boolean
  /** 采样上限（0 = 不限） */
  sample?: number
  /** 随机种子，保证同一台机器上结果可复现 */
  seed?: number
  /** 是否包含 IPv6 */
  includeIpv6?: boolean
  /** 超时（ms） */
  timeoutMs?: number
  /**
   * 运行期发现的**活跃 IPv6 前缀**（由目标域名的 AAAA 展开而来，键为 /48 CIDR）。
   *
   * 会与静态表 `IPV6_PREFIX_WEIGHTS` 合并，见 `makeWeightFn`。
   * 静态表会漂移，而用户自己域名的 AAAA 永远指向当下真正在用的段 ——
   * 有它兜底，静态表过期也不会让 v6 采样变成 0 候选。
   */
  extraWeights?: Readonly<Record<string, number>>
}

/** 拉取 Cloudflare 官方网段 */
export async function fetchCloudflareCidrs(timeoutMs = 8000): Promise<{ ipv4: string[]; ipv6: string[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [v4, v6] = await Promise.all([
      fetch('https://www.cloudflare.com/ips-v4', { signal: controller.signal }),
      fetch('https://www.cloudflare.com/ips-v6', { signal: controller.signal }),
    ])
    const parse = (text: string): string[] =>
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('/'))
    return {
      ipv4: v4.ok ? parse(await v4.text()) : BUILTIN_IPV4_CIDRS,
      ipv6: v6.ok ? parse(await v6.text()) : BUILTIN_IPV6_CIDRS,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 简单可复现的伪随机数生成器（mulberry32） */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ParsedCidr {
  family: 4 | 6
  base: bigint
  prefix: number
  size: bigint
  /** 原始 CIDR 字符串（用于查可用率权重表） */
  cidr: string
}

/** 解析 CIDR */
export function parseCidr(cidr: string): ParsedCidr | null {
  const [addr, prefixText] = cidr.trim().split('/')
  if (!addr) return null
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix)) return null

  if (addr.includes(':')) {
    if (prefix < 0 || prefix > 128) return null
    const base = ipv6ToBigInt(addr)
    if (base === null) return null
    const hostBits = 128 - prefix
    const size = 1n << BigInt(hostBits)
    const mask = hostBits === 0 ? 0n : ((1n << BigInt(hostBits)) - 1n)
    return { family: 6, base: base & ~mask, prefix, size, cidr: cidr.trim() }
  }

  if (prefix < 0 || prefix > 32) return null
  const value = ipv4ToBigInt(addr)
  if (value === null) return null
  const hostBits = 32 - prefix
  const size = 1n << BigInt(hostBits)
  const mask = hostBits === 0 ? 0n : ((1n << BigInt(hostBits)) - 1n)
  return { family: 4, base: value & ~mask, prefix, size, cidr: cidr.trim() }
}

function ipv4ToBigInt(addr: string): bigint | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function ipv6ToBigInt(addr: string): bigint | null {
  try {
    const parts = addr.split('::')
    if (parts.length > 2) return null
    const head = parts[0] ? parts[0].split(':') : []
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : []
    const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    if (groups.length !== 8) return null
    let value = 0n
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      value = (value << 16n) | BigInt(parseInt(group, 16))
    }
    return value
  } catch {
    return null
  }
}

function bigIntToIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join('.')
}

function bigIntToIpv6(value: bigint): string {
  const groups: string[] = []
  for (let i = 7; i >= 0; i--) {
    groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16))
  }
  // 压缩最长的一段连续零
  let bestStart = -1
  let bestLen = 0
  let start = -1
  let len = 0
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === '0') {
      if (start < 0) start = i
      len++
      if (len > bestLen) {
        bestLen = len
        bestStart = start
      }
    } else {
      start = -1
      len = 0
    }
  }
  if (bestLen < 2) return groups.join(':')
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLen).join(':')
  return `${head}::${tail}`
}

/**
 * 把网段按「权重区」拆分成子网段。
 *
 * ## 为什么需要
 *
 * 官方返回的网段是 `162.158.0.0/15`，它**横跨两个权重区**：
 *   - `162.158.x.x`：边缘节点，权重 0.2
 *   - `162.159.x.x`：管理 / API 网段，权重 0（大量 HTTP 403）
 *
 * 若按整个 /15 给一个权重再均匀采样，两个区会各拿一半候选 ——
 * 细粒度权重表完全失效（真机：用户可用的 `162.159.237.59` 被错杀，
 * 而大量 403 IP 又混进候选）。
 *
 * 因此这里把网段拆到「权重一致的最小前缀」：逐级细分（/15 → /16 → /24 …），
 * 直到每个子块的 `cidrWeight` 相同，或无法再细（/32）。
 *
 * 只对 IPv4 生效（权重表只覆盖 IPv4）。
 */
function splitByWeight(cidr: ParsedCidr, weightFn: (c: string) => number = cidrWeight): ParsedCidr[] {
  const bits = cidr.family === 4 ? 32 : 128
  const maxPrefix = cidr.family === 4 ? 32 : 48
  const format = (base: bigint): string => (cidr.family === 4 ? bigIntToIpv4(base) : bigIntToIpv6(base))

  /** v6：子树里是否有表内前缀（用于剪枝，避免从 /32 盲拆到 /48 生出 65536 个叶子）。 */
  const v6HasEntryInside = (c: ParsedCidr): boolean => {
    for (const entry of WEIGHT_TABLE_V6) {
      if (entry.prefix < c.prefix) continue // 更短的是祖先，不算「内部」
      if (entry.base >= c.base && entry.base < c.base + c.size) return true
    }
    return false
  }

  const out: ParsedCidr[] = []
  /** 待处理栈：[网段, 已知权重] */
  const stack: Array<{ c: ParsedCidr; known?: number }> = [{ c: cidr }]

  while (stack.length > 0) {
    const item = stack.pop()!
    const c = item.c
    const weight = item.known ?? weightFn(c.cidr)
    if (c.prefix >= maxPrefix) {
      out.push(c)
      continue
    }
    if (cidr.family === 6) {
      // 自己就是活跃前缀（或被更短的活跃前缀覆盖）→ 到此为止
      if (weight > 0) {
        out.push(c)
        continue
      }
      // 子树里没有已知活跃段 → 再怎么拆也全是 0，直接停
      if (!v6HasEntryInside(c)) {
        out.push(c)
        continue
      }
    }
    // 拆成两个等长子网。注意 cidr 字段要同步成子网的字符串形式，
    // 否则 weightFn 会一直拿到父网段的串、得出相同的权重。
    const half = 1n << BigInt(bits - c.prefix - 1)
    const mk = (base: bigint): ParsedCidr => {
      const sub: ParsedCidr = { ...c, prefix: c.prefix + 1, size: half, base }
      return { ...sub, cidr: `${format(base)}/${c.prefix + 1}` }
    }
    const left = mk(c.base)
    const right = mk(c.base + half)
    const lw = weightFn(left.cidr)
    const rw = weightFn(right.cidr)
    // ⚠️ 「两半权重相同就停」只对 IPv4 成立。
    //
    // IPv6 的兜底权重是 0，而 /33 这一级表里根本没有条目（表全是 /48），
    // 于是两半都是 0 → 第一层就判停 → 整个 /32 被当成权重 0 丢掉，
    // 活跃 /48 一个都出不来。v6 改由上面的「权重 > 0 / 子树无表内前缀 /
    // 到 /48」三条规则控制停止。
    if (cidr.family === 4 && lw === rw) {
      // 两半权重相同：无需继续拆
      out.push(c)
      continue
    }
    // 权重不同：分别入栈（带上各自的权重，避免重复计算）
    stack.push({ c: left, known: lw }, { c: right, known: rw })
  }

  // 按 base 排序，保证输出顺序稳定（可复现）
  return out.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0))
}

/**
 * 把网段展开为候选 IP 列表。
 * 大网段按比例均匀采样，避免一次枚举几百万个地址。
 *
 * ## `--sample` 曾经完全失效（2026-10 修复）
 *
 * 两个 bug 叠加，用户传 `--sample 300` 实际拿到 1400+ 个候选：
 *
 * 1. **每网段写死 64 下限**：`Math.max(64, ratio)`，22 个网段 × 64 = 1400+。
 * 2. **比例分母被 IPv6 撑爆**：`totalSize` 把 IPv6 /32（2^96 个地址）
 *    算进分母，IPv4 网段的比例全部被稀释成 0，只能吃 64 下限。
 *
 * 现在的算法：
 *   - 采样预算**按地址族分别分配**（v4 / v6 各自的比例分母只用本族总量），
 *     混合两族时各拿一半预算——`--sample 300` 就是总共约 300 个候选；
 *   - 每网段下限随采样规模可变：sample ≤ 1000（明确要小样本）时下限 1，
 *     严格按比例分摊；sample > 1000（默认 20000）时下限 64，
 *     避免小权重网段只出一两个 IP、覆盖不均；
 *   - 想要的个数 ≥ 网段大小时退化为全量枚举（step 永不为 0）；
 *   - 最后按预算收口：每网段保底 1 个会让总数略超，从计数最大的网段
 *     依次减 1 压回预算内（网段数超过预算时如实保留每网段 1 个）。
 *
 * ## 网段拆分
 *
 * 进入采样前先把网段按权重区拆开（见 `splitByWeight`），
 * 否则 `162.158.0.0/15` 这种跨权重区的网段会让细粒度权重失效。
 */
export function expandCidrs(cidrs: string[], options: IpRangeOptions = {}): string[] {
  const neutral = options.neutral === true
  let sample = options.sample ?? 20000
  const random = makeRandom(options.seed ?? 0x5eed)
  const parsedRaw = cidrs.map(parseCidr).filter((c): c is ParsedCidr => c !== null)
  if (parsedRaw.length === 0) return []
  // 本次调用专用的权重函数：把运行期发现的活跃 v6 前缀（AAAA 展开）并进静态表
  const weightFn = makeWeightFn(options.extraWeights)
  // 按权重区拆分：让细粒度权重在跨区网段上也生效
  const parsed = parsedRaw.flatMap((c) => splitByWeight(c, weightFn))
  if (parsed.length === 0) return []
  // ⚠️ 「不限制」对 IPv6 不成立：活跃段是 /48 = 2^80 个地址，全量枚举必撑爆内存
  //   （自适应采样那边就因此 OOM 过）。混入 v6 时降级为默认采样数，走有界采样。
  if (sample <= 0 && parsed.some((c) => c.family === 6)) sample = 20000
  if (sample <= 0) {
    // 不限制：全量枚举
    const all: string[] = []
    for (const cidr of parsed) {
      for (let i = 0n; i < cidr.size; i++) {
        const value = cidr.base + i
        all.push(cidr.family === 4 ? bigIntToIpv4(value) : bigIntToIpv6(value))
      }
    }
    return all
  }

  const minPerCidr = sample <= 1000 ? 1 : 64
  const out: string[] = []

  // 按地址族分组：比例分母只用本族总量，避免 IPv6 /32 把 IPv4 比例稀释成 0
  for (const family of [4, 6] as const) {
    const group = parsed.filter((c) => c.family === family)
    if (group.length === 0) continue
    // 混合两族时各拿一半预算，保证总数≈sample；单族时拿全量
    // 注意：必须先算布尔值再走三元——`sample / bool ? a : b` 会因 / 优先级高于 ?: 而恒为真
    //
    // ⚠️ 判「有没有另一族」必须看**权重非 0 的**条目：
    // IPv6 权重表默认 0，公布段里的死 /48 会留在 parsed 里，
    // 若按「存在即算」，v4 的预算会被一堆产不出候选的死段白白分走一半。
    const hasOtherFamily = parsed.some((c) => c.family !== family && weightFn(c.cidr) > 0)
    const familyBudget = Math.max(1, Math.round(hasOtherFamily ? sample / 2 : sample))

    // 可用率加权：
    //
    // Cloudflare 的 IPv4 空间大部分是区域/租户专用分配，对普通站点没有配置。
    // 真机实测（101 校验，每段 12 IP）：6 个官方网段 0/12 完全不可用，
    // 而 104.16/13 是 8/12。若按网段大小比例分配预算，一半以上候选会来自
    // 0% 可用的网段 —— 表现为「阶段一过后只剩零星候选、阶段二全军覆没」。
    //
    // 因此预算按「大小 × 可用率权重」分配，把候选集中到真正能用的网段。
    // 两族都走同一套权重逻辑（v6 查 IPV6_PREFIX_WEIGHTS，默认 0），
    // 差别只在默认值：v4 默认 0.2（宁可多采），v6 默认 0（没实测过的一律不采）。
    const effectiveSize = (c: ParsedCidr): bigint => {
      const raw = weightFn(c.cidr)
      // 中性采样：权重表只用来区分「完全不可达（0）」与「其它（1）」
      const weight = neutral ? (raw > 0 ? 1 : 0) : raw
      if (weight <= 0) return 0n // 权重 0 的网段直接排除
      const scaled = Number(c.size) * weight
      return scaled >= 1 ? BigInt(Math.floor(scaled)) : 0n
    }

    const rawTotal = group.reduce((sum, c) => sum + effectiveSize(c), 0n)
    // 全部网段权重为 0（极端情况）
    const allZero = rawTotal === 0n
    let familyTotal = rawTotal
    let allocOf = effectiveSize
    if (allZero) {
      // ⚠️ IPv6 在这里必须**直接跳过**，不能像 IPv4 那样退化为「按原始大小分配」。
      //
      // IPv4 的兜底是防止返回空列表卡死用户（它的默认权重非 0，
      // allZero 意味着「表里全判死」这种极端情况）。
      // 而 IPv6 的默认权重**本来就是 0**，allZero 只说明「没有已知可用段」，
      // 此时按大小分配只会把预算全部烧在实测 0/18 的死地址上 ——
      // 正是本功能要修的那个问题。
      if (family === 6) continue
      familyTotal = group.reduce((sum, c) => sum + c.size, 0n)
      allocOf = (c: ParsedCidr): bigint => c.size
    }
    if (familyTotal === 0n) continue

    // 第一步：按比例算出每个网段「想要的个数」。
    //
    // 下限 `minPerCidr` 也要随权重缩放 —— 否则 0.05 权重的网段会被抬到
    // 与 1.0 权重相同的保底数（真机：162.159 拿到 64 个，与 104.16 一样多），
    // 加权就白做了。缩放后保底 1 个（低权重网段至少留个探针）。
    const minForCidr = (c: ParsedCidr): number => {
      if (neutral) return minPerCidr
      const w = weightFn(c.cidr)
      if (w >= 1) return minPerCidr
      if (w <= 0) return 0 // 权重 0 不占保底名额（下面 usablePlans 也会剔除它）
      return Math.max(1, Math.round(minPerCidr * w))
    }

    const plans = group.map((cidr) => {
      const ratio = Number((allocOf(cidr) * BigInt(familyBudget)) / familyTotal)
      const wanted = Math.max(minForCidr(cidr), Math.min(20000, ratio))
      return { cidr, count: Math.min(Number(cidr.size), wanted) }
    })

    // 第二步：权重为 0 的网段（实测 0% 可用）彻底剔除，不占用 minPerCidr 名额。
    // allZero 时（所有网段权重都是 0）退化为全量参与，避免返回空列表卡死用户。
    const usablePlans = allZero
      ? plans
      : plans.filter((p) => effectiveSize(p.cidr) > 0n)

    // 下限（每网段至少 1 个）会让总数略微超出预算，
    // 从计数最大的网段每次减 1，直到总数回到预算内。
    // 每个网段至少保留 1 个——网段数本身就超过预算时（如 --sample 5 配 15 个网段）
    // 无法再压，此时如实超出，保证每个网段都有代表。
    let familySum = usablePlans.reduce((sum, p) => sum + p.count, 0)
    while (familySum > familyBudget) {
      let target: { cidr: ParsedCidr; count: number } | null = null
      for (const plan of usablePlans) {
        if (plan.count > 1 && (!target || plan.count > target.count)) target = plan
      }
      if (!target) break
      target.count -= 1
      familySum -= 1
    }

    // 第三步：按计划生成 IP
    for (const { cidr, count } of usablePlans) {
      if (count <= 0) continue
      if (count >= Number(cidr.size)) {
        // 全量枚举（想要的个数不少于网段大小）
        for (let i = 0n; i < cidr.size; i++) {
          const value = cidr.base + i
          out.push(family === 4 ? bigIntToIpv4(value) : bigIntToIpv6(value))
        }
        continue
      }
      const step = Math.floor(Number(cidr.size) / count)
      for (let i = 0; i < count; i++) {
        // ⚠️ 每个桶独立抖动，不能在循环外只摇一次。
        //
        // 旧实现：`offset = random() * step` 在循环外只算一次，
        // 于是同一网段采出的所有 IP 是**固定步长的等差数列**。
        // 当 step 是 256 的倍数时（/16 取 64 个 → step=1024），
        // **全部样本的末位相同**；offset 末位若落在 .0 / .255，
        // 整个网段的样本全部是网络地址或广播地址 → 100% 浪费。
        //
        // 现在每个桶各自在 [i*step, (i+1)*step) 区间内随机取点，
        // 末位分布均匀，且避开 .0 / .255。
        const jitter = Math.floor(random() * step)
        let offsetValue = BigInt(i * step + jitter)
        if (offsetValue >= cidr.size) offsetValue = cidr.size - 1n

        let value = cidr.base + offsetValue
        if (cidr.family === 4) {
          // 跳过网络地址（.0）与广播地址（.255）
          const lastOctet = value & 0xffn
          if (lastOctet === 0n) value += 1n
          else if (lastOctet === 255n) value -= 1n
          // 越界回退（只可能发生在 /31 /32 这种极小网段）
          if (value < cidr.base || value >= cidr.base + cidr.size) {
            value = cidr.base + offsetValue
          }
        }
        out.push(cidr.family === 4 ? bigIntToIpv4(value) : bigIntToIpv6(value))
      }
    }
  }

  return out
}

/**
 * 这一列是不是一个 IP 字面量（IPv4 / `IPv4:port` / 裸 IPv6 / `[IPv6]:port`）。
 *
 * 用于 CSV 里**认列**：不能只看第一列，也不能用「像不像主机」来猜 ——
 * 表头的 `No`、`Amazon.com` 都会被误判。
 */
function looksLikeIpLiteral(rawValue: string): boolean {
  if (!rawValue) return false
  // 先剥掉 `#备注`：CSV 单元格里也可能带备注（`[2606:4700::1]:443#LAX`），
  // 不剥会判定失败 → 整行被当成表头跳过，候选静默少一条。
  const value = (rawValue.split('#')[0] ?? '').trim()
  if (!value) return false
  if (value.startsWith('[')) return /^\[[0-9a-fA-F:.]+\](?::\d{1,5})?$/.test(value)
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/.test(value)) {
    const host = value.split(':')[0]!
    return host.split('.').every((octet) => Number(octet) <= 255)
  }
  // 裸 IPv6：至少两个冒号（域名与 `IPv4:port` 都只有 0 或 1 个）
  if (value.includes(':') && value.split(':').length > 2) {
    return /^[0-9a-fA-F:.]+$/.test(value)
  }
  return false
}

/**
 * 读取本地 IP 列表文件（每行一个 IP / IP:端口）
 *
 * 兼容面板 ADD 池的写法：`IP:Port#备注`、`[IPv6]:Port#备注`、CSV 整行。
 *
 * ## CSV 按「哪一列像 IP」取，不假设列序
 *
 * 早前固定取第一列 —— 遇到 `No,Proxy IP,Port,...` 这种带序号的表会把**序号当 IP**，
 * 表头行也会被当成候选（白测一次、还让候选数对不上）。
 *
 * 现在的规则，按顺序：
 *   1. 逐列找第一个 IP 字面量 → 用它；
 *   2. 找不到但**有列含空格** → 表头 / 说明行，整行跳过；
 *   3. 否则回退第一列 —— 保住 `example.com,8080` 这种「主机,端口」写法。
 */
export function readIpFile(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes(',')) {
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      const hit = cols.find((c) => looksLikeIpLiteral(c))
      if (hit) line = hit
      // 没有 IP 列时再分三种：
      //   · 有列含空格 → 表头 / 说明行（`No,Proxy IP,Port,...`）
      //   · 第一列带点 → `example.com,8080` 这种「主机,端口」，取第一列
      //   · 其余（`IP,Port` 这类无点无空格的表头）→ 跳过
      else if (cols.some((c) => c.includes(' '))) continue
      else if ((cols[0] ?? '').includes('.')) line = cols[0]!
      else continue
    }
    if (!line) continue
    // 去掉 #备注
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash).trim()
    if (!line) continue
    // 主机名与 IP 都不含空白：到这里还带空格的一定是说明行 / 粘错的文本
    // （先剥备注再判，`1.2.3.4:443#SJC 12ms` 这种带空格备注不会被误伤）
    if (/\s/.test(line)) continue
    // [IPv6]:端口#备注 → IPv6
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(line)
    if (bracket) {
      out.push(bracket[1]!)
      continue
    }
    if (line.includes(':') && line.split(':').length > 2) {
      // IPv6
      out.push(line)
      continue
    }
    if (line.includes(':')) {
      const [host] = line.split(':')
      if (host) out.push(host)
      continue
    }
    out.push(line)
  }
  return out
}

/** 远程清单的**硬上限**：2MB 足够装下几万条 IP，再大基本是给错了链接 */
export const IP_URL_MAX_BYTES = 2 * 1024 * 1024
/** 远程清单拉取超时 */
export const IP_URL_TIMEOUT_MS = 15_000

/**
 * 从远程链接拉取 IP 清单。
 *
 * ## 三条边界
 *
 * 1. **只收 http/https** —— 避免 `file://` 之类的本地读取被当成「导入」；
 * 2. **流式读取 + 硬截断**：先看 `content-length`，实际读的时候再按字节计数拦截。
 *    只看 content-length 不够（可以缺省或撒谎），一次性 `res.text()` 又会让
 *    一个错链接把几 GB 读进内存；
 * 3. **清洗复用 `readIpFile`** —— 远程清单的格式与本地文件完全一样
 *    （CSV / 每行一个 / 带备注），两套解析必然漂移。
 */
export async function readIpUrl(
  rawUrl: string,
  timeoutMs = IP_URL_TIMEOUT_MS,
  maxBytes = IP_URL_MAX_BYTES
): Promise<string[]> {
  const trimmed = rawUrl.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`不是合法的链接：${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http/https 链接，实际是 ${url.protocol}`)
  }

  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`拉取失败：${msg}`)
  }
  if (!res.ok) throw new Error(`拉取失败 HTTP ${res.status} ${res.statusText}`.trim())

  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `清单过大：声明 ${(declared / 1024 / 1024).toFixed(1)} MB，上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MB`
    )
  }

  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  const reader = res.body?.getReader()
  if (reader) {
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
        throw new Error(`清单过大：超过 ${(maxBytes / 1024 / 1024).toFixed(1)} MB 上限`)
      }
      text += decoder.decode(value, { stream: true })
    }
  }
  text += decoder.decode()

  const list = readIpFile(text)
  if (list.length === 0) {
    throw new Error(`链接内容里没有可识别的 IP：${trimmed}`)
  }
  return list
}
