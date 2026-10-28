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
  '172.64.0.0/13': 0.4, // 复测 5/12（旧表 0.1 —— 被低估 5 倍）
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

const WEIGHT_TABLE: WeightEntry[] = (() => {
  const out: WeightEntry[] = []
  for (const [cidr, weight] of Object.entries(IPV4_CIDR_WEIGHTS)) {
    const parsed = parseCidr(cidr)
    if (!parsed || parsed.family !== 4) continue
    out.push({ base: parsed.base, prefix: parsed.prefix, weight })
  }
  return out
})()

export function cidrWeight(cidr: string): number {
  const normalized = cidr.trim()
  // 1) 精确匹配优先
  if (normalized in IPV4_CIDR_WEIGHTS) return IPV4_CIDR_WEIGHTS[normalized]!

  // 2) 最长前缀匹配：找表中能覆盖 normalized 的最具体网段
  const parsed = parseCidr(normalized)
  if (!parsed || parsed.family !== 4) return DEFAULT_CIDR_WEIGHT

  let bestPrefix = -1
  let bestWeight = DEFAULT_CIDR_WEIGHT
  for (const entry of WEIGHT_TABLE) {
    // entry 必须能覆盖 parsed：前缀更短（或相等）
    if (entry.prefix > parsed.prefix) continue
    // 对齐检查：都归一到「前 entry.prefix 位」再比。
    // parsed 的前 entry.prefix 位 = parsed.base >> (32 - entry.prefix)
    //   （parsed.base 已按更长的 parsed.prefix 掩过，主机位为 0，直接右移即可）
    // table 的前 entry.prefix 位 = entry.base >> (32 - entry.prefix)
    const parsedNorm = parsed.base >> BigInt(32 - entry.prefix)
    const tableNorm = entry.base >> BigInt(32 - entry.prefix)
    if (parsedNorm !== tableNorm) continue
    if (entry.prefix > bestPrefix) {
      bestPrefix = entry.prefix
      bestWeight = entry.weight
    }
  }
  return bestWeight
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
  /** 采样上限（0 = 不限） */
  sample?: number
  /** 随机种子，保证同一台机器上结果可复现 */
  seed?: number
  /** 是否包含 IPv6 */
  includeIpv6?: boolean
  /** 超时（ms） */
  timeoutMs?: number
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
function splitByWeight(cidr: ParsedCidr): ParsedCidr[] {
  if (cidr.family !== 4) return [cidr]
  const out: ParsedCidr[] = []
  /** 待处理栈：[网段, 已知权重] */
  const stack: Array<{ c: ParsedCidr; known?: number }> = [{ c: cidr }]

  while (stack.length > 0) {
    const item = stack.pop()!
    const c = item.c
    const weight = item.known ?? cidrWeight(c.cidr)
    if (c.prefix >= 32) {
      out.push(c)
      continue
    }
    // 拆成两个等长子网。注意 cidr 字段要同步成子网的字符串形式，
    // 否则 cidrWeight 会一直拿到父网段的串、得出相同的权重。
    const half = 1n << BigInt(32 - c.prefix - 1)
    const mk = (base: bigint): ParsedCidr => {
      const sub: ParsedCidr = { ...c, prefix: c.prefix + 1, size: half, base }
      return { ...sub, cidr: `${bigIntToIpv4(base)}/${c.prefix + 1}` }
    }
    const left = mk(c.base)
    const right = mk(c.base + half)
    const lw = cidrWeight(left.cidr)
    const rw = cidrWeight(right.cidr)
    if (lw === rw) {
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
  const sample = options.sample ?? 20000
  const random = makeRandom(options.seed ?? 0x5eed)
  const parsedRaw = cidrs.map(parseCidr).filter((c): c is ParsedCidr => c !== null)
  if (parsedRaw.length === 0) return []
  // 按权重区拆分：让细粒度权重在跨区网段上也生效
  const parsed = parsedRaw.flatMap(splitByWeight)
  if (parsed.length === 0) return []
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
    const hasOtherFamily = parsed.some((c) => c.family !== family)
    const familyBudget = Math.max(1, Math.round(hasOtherFamily ? sample / 2 : sample))

    // 可用率加权：
    //
    // Cloudflare 的 IPv4 空间大部分是区域/租户专用分配，对普通站点没有配置。
    // 真机实测（101 校验，每段 12 IP）：6 个官方网段 0/12 完全不可用，
    // 而 104.16/13 是 8/12。若按网段大小比例分配预算，一半以上候选会来自
    // 0% 可用的网段 —— 表现为「阶段一过后只剩零星候选、阶段二全军覆没」。
    //
    // 因此预算按「大小 × 可用率权重」分配，把候选集中到真正能用的网段。
    // IPv6 不加权（无实测数据；且 Workers 的 connect() 不支持 IPv6 出站，
    // IPv6 候选主要供客户端侧使用）。
    const effectiveSize = (c: ParsedCidr): bigint => {
      if (c.family !== 4) return c.size
      const weight = cidrWeight(c.cidr)
      if (weight <= 0) return 0n // 权重 0 的网段直接排除
      const scaled = Number(c.size) * weight
      return scaled >= 1 ? BigInt(Math.floor(scaled)) : 0n
    }

    const rawTotal = group.reduce((sum, c) => sum + effectiveSize(c), 0n)
    // 全部网段权重为 0（极端情况）：退化为按原始大小分配，避免返回空列表卡死用户
    const allZero = rawTotal === 0n
    let familyTotal = rawTotal
    let allocOf = effectiveSize
    if (allZero) {
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
      if (c.family !== 4) return minPerCidr
      const w = cidrWeight(c.cidr)
      if (w >= 1) return minPerCidr
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
 * 读取本地 IP 列表文件（每行一个 IP / IP:端口）
 *
 * 兼容面板 ADD 池的写法：`IP:Port#备注`、`[IPv6]:Port#备注`、CSV 整行。
 */
export function readIpFile(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 去掉 CSV 行里的其它列
    if (line.includes(',')) line = line.split(',')[0]!.trim()
    // 去掉 #备注
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash).trim()
    if (!line) continue
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
