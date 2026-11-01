/**
 * 候选 IP 生成与清洗（cli.ts 与本地桥接服务共用）
 *
 * 规则：
 *   1. 自定义网段优先；未提供时拉取 Cloudflare 官方网段，网络不可用则回退内置网段。
 *   2. 统一交给 expandCidrs() 做可复现采样（相同 seed → 相同结果）。
 *   3. 本模块会被打包进单文件 CLI 产物，不要在这里写 shebang。
 */
import {
  BUILTIN_IPV4_CIDRS,
  BUILTIN_IPV6_CIDRS,
  expandCidrs,
  fetchCloudflareCidrs,
  readIpFile,
  cidrWeight,
  parseCidr,
  IPV4_CIDR_WEIGHTS,
} from './ip-ranges'
import { isPublicAddress } from './net-env'
import { sampleExploreExploit, type AdaptiveSamplingOptions, type ProfileStoreDocument, type SamplingCandidate } from './network-profile'

/** 地址族：仅 IPv4 / 仅 IPv6 / 两者都要 */
export type IpFamily = 'v4' | 'v6' | 'both'

/** 默认采样上限（与 CLI --sample 默认值一致） */
export const DEFAULT_CANDIDATE_SAMPLE = 20000
/**
 * 历史固定种子（仅用于复现旧结果，**不再是默认值**）。
 *
 * ⚠️ 2026-10-28 修复：它曾经是 `--seed` 的默认值，导致**每次运行采到的候选
 * 完全一样**（`--sample` 不变时），抽到劣质路由段就永远测不出好 IP。
 * 现在默认改为 `randomSeed()`（见 `resolveCandidates`），
 * 只有显式 `--seed 24301` 才会回到这份历史样本。
 */
export const DEFAULT_CANDIDATE_SEED = 24301
/**
 * 本地桥接服务未指定采样数时的默认值。
 *
 * 从 3000 提到 6556：加权采样后有效候选密度提高，
 * 但 TLS 握手快慢与 TCP 延迟几乎无关，仍需要较大样本才能覆盖到
 * 「握手快」的 IP。6556 是真机验证过的值（选出的 IP TLS 124~352ms、
 * 下行 1.4~7.3 MB/s）。
 *
 * 历史：从 300 提到 3000：阶段一新增 TLS 握手筛选后，
 * 采样量直接决定能否碰到「握手快」的 IP —— 实测 TCP 9ms 的 IP
 * TLS 握手可能要 3.5 秒，两者几乎无关，300 个候选里往往一个都快不了。
 */
export const DEFAULT_BRIDGE_SAMPLE = 6556

export interface CandidateOptions {
  /** 自适应显式启用：提供档案后才改变采样行为。 */
  profile?: ProfileStoreDocument
  /** 自适应采样参数；limit 默认使用 sample。 */
  adaptiveSampling?: Omit<AdaptiveSamplingOptions, 'limit'>
  /** 采样上限，0 = 不限制；默认 20000 */
  sample?: number
  /** 自定义网段：可以是单个网段、逗号/换行分隔的字符串，或网段数组 */
  cidr?: string | string[]
  /**
   * 随机种子。
   *
   * **不传 = 每次跑都换一批候选**（默认行为，见 `randomSeed`）；
   * 传了就固定，相同种子结果可复现（排查问题 / 对比报告时用）。
   */
  seed?: number
  /** 中性采样：忽略权重（只保留权重 0 的不可达段） */
  neutral?: boolean
  /** 地址族，默认 both */
  family?: IpFamily
}

/** 把 --cidr / body.cidr 的多种写法归一成网段数组 */
function normalizeCidrInput(cidr: string | string[] | undefined): string[] {
  if (cidr === undefined) return []
  const list = Array.isArray(cidr) ? cidr : [cidr]
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[\n,]+/)) {
      const value = part.trim()
      if (value) out.push(value)
    }
  }
  return out
}

function isIpv6Cidr(cidr: string): boolean {
  return cidr.includes(':')
}

/** 按地址族过滤网段字符串 */
function filterByFamily(cidrs: string[], family: IpFamily): string[] {
  if (family === 'both') return cidrs
  const wantIpv6 = family === 'v6'
  return cidrs.filter((cidr) => isIpv6Cidr(cidr) === wantIpv6)
}

/** 拉取 Cloudflare 官方网段，失败时逐族回退内置网段 */
async function loadCloudflareCidrs(family: IpFamily): Promise<string[]> {
  let ipv4 = BUILTIN_IPV4_CIDRS
  let ipv6 = BUILTIN_IPV6_CIDRS
  try {
    const ranges = await fetchCloudflareCidrs()
    if (ranges.ipv4.length > 0) ipv4 = ranges.ipv4
    if (ranges.ipv6.length > 0) ipv6 = ranges.ipv6
  } catch {
    // 离线 / 超时 / 被墙：静默回退内置网段，不阻断扫描
  }
  if (family === 'v4') return [...ipv4]
  if (family === 'v6') return [...ipv6]
  return [...ipv4, ...ipv6]
}

/**
 * 生成候选 IP 列表（不涉及本地文件读取）。
 *
 * 与 CLI 的 --ip-file 分支互补：文件读取留在 cli.ts，这里只负责网段 → IP。
 *
 * ## 默认种子必须每次不同（2026-10-28 修复）
 *
 * 早前 `seed` 默认写死 `DEFAULT_CANDIDATE_SEED = 24301`，
 * 于是**只要 `--sample` 不变，每次跑出来的候选列表 100% 一模一样**：
 * 若那批 IP 恰好落在当地运营商的劣质路由段上，重跑一百次也是同一批慢 IP，
 * 用户只会得出「优选出来的都慢」的结论 —— 实际是样本池僵死。
 *
 * 现在不传 `seed` 就用「时间 ^ 随机数」生成新种子；传了就照旧可复现。
 */
export async function resolveCandidates(opts: CandidateOptions = {}): Promise<string[]> {
  const sample = opts.sample ?? DEFAULT_CANDIDATE_SAMPLE
  const seed = opts.seed ?? randomSeed()
  const family = opts.family ?? 'both'
  const neutral = opts.neutral === true

  const customCidrs = normalizeCidrInput(opts.cidr)
  const cidrs = customCidrs.length > 0 ? filterByFamily(customCidrs, family) : await loadCloudflareCidrs(family)
  // 默认分支保持原有种子、权重和预算语义。
  if (!opts.profile) return expandCidrs(cidrs, { sample, seed, neutral })
  const random = seededRandom(seed)
  const adaptive: AdaptiveSamplingOptions = { limit: sample > 0 ? sample : DEFAULT_CANDIDATE_SAMPLE, random, ...opts.adaptiveSampling }
  const candidates = adaptivePool(cidrs, adaptive.limit, adaptive.includeZeroWeight === true, neutral, random, opts.profile, {
    explorationRate: adaptive.explorationRate,
    now: adaptive.now,
    halfLifeMs: adaptive.halfLifeMs,
    profileId: adaptive.profileId,
  })
  return sampleExploreExploit(candidates, opts.profile, adaptive).map((item) => item.ip)
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 网段分配的先验参数。
 *
 * 对应「全局先验成功率 70%，折算成 8 个虚拟样本」：
 * 平滑公式 P = (S + 5.6) / (N + 8)。
 *
 * 样本少时权重靠近先验，样本多时真实数据占主导。
 */
const LEARN_PRIOR_ALPHA = 5.6
const LEARN_PRIOR_BETA = 2.4
const LEARN_PRIOR_TOTAL = LEARN_PRIOR_ALPHA + LEARN_PRIOR_BETA

interface SegmentObservation {
  attempts: number
  successes: number
  decay: number
}

/** 汇总落在该网段内的历史观测（按 /24 桶、同一网络档案）。 */
function segmentObservation(
  segment: { family: 4 | 6; start: bigint; end: bigint },
  store: ProfileStoreDocument | undefined,
  profileId: string,
  now: number,
  halfLifeMs: number,
): SegmentObservation | undefined {
  if (!store || segment.family !== 4 || !profileId) return undefined
  // 同一前缀可能有多个阶段的观测，取「尝试最多」的那一段作为代表
  // （阶段优先 ws > tls > tcp，因为协议验证更能代表「这个 IP 能不能用」）。
  const best = new Map<string, { stage: string; attempts: number }>()
  for (const observation of Object.values(store.observations)) {
    if (observation.profileId !== profileId) continue
    const parsed = parseCidr(observation.prefix)
    if (!parsed || parsed.family !== 4) continue
    if (parsed.base < segment.start || parsed.base + parsed.size > segment.end) continue
    const current = best.get(observation.prefix)
    const rank = (stage: string): number => (stage === 'ws' ? 3 : stage === 'tls' ? 2 : 1)
    if (!current || observation.attempts > current.attempts || (observation.attempts === current.attempts && rank(observation.stage) > rank(current.stage))) {
      best.set(observation.prefix, { stage: observation.stage, attempts: observation.attempts })
    }
  }
  if (best.size === 0) return undefined
  let attempts = 0
  let successes = 0
  let updated = 0
  for (const observation of Object.values(store.observations)) {
    if (observation.profileId !== profileId) continue
    const picked = best.get(observation.prefix)
    if (!picked || picked.stage !== observation.stage) continue
    const parsed = parseCidr(observation.prefix)
    if (!parsed || parsed.family !== 4) continue
    if (parsed.base < segment.start || parsed.base + parsed.size > segment.end) continue
    attempts += observation.attempts
    successes += observation.successes
    if (observation.updatedAt > updated) updated = observation.updatedAt
  }
  if (attempts <= 0) return undefined
  const age = Math.max(0, now - updated)
  const decay = 2 ** (-age / Math.max(1, halfLifeMs))
  return { attempts, successes, decay }
}

/**
 * 网段的有效权重：静态权重与学习到的成功率做 Beta 平滑。
 *
 * 与桌面版（internal/scan/adaptive_sampling.go 的 DynamicPrefixWeight）一致：
 *   W = (static × prior + successes × decay) / (prior + attempts × decay)
 *
 * 零静态权重的网段**保持 0**：它只参与探索，不参与利用，
 * 否则「某个网段在这个网络里一直失败」的结论会被历史慢慢磨平。
 */
function effectiveSegmentWeight(staticWeight: number, observation?: SegmentObservation): number {
  if (staticWeight <= 0) return 0
  if (!observation) return staticWeight
  const numerator = staticWeight * LEARN_PRIOR_TOTAL + observation.successes * observation.decay
  const denominator = LEARN_PRIOR_TOTAL + observation.attempts * observation.decay
  if (denominator <= 0) return staticWeight
  return Math.max(0.02, Math.min(1, numerator / denominator))
}

/**
 * 自适应池：按「网段大小 × 学习到的权重」分配预算，并保留固定比例的探索。
 *
 * 与桌面版（internal/scan/adaptive_sampling.go）语义一致：
 *   - 零静态权重的网段**只**在探索预算里出现；
 *   - 学习到的成功率影响**网段分配**（不只是结果重排）；
 *   - 固定探索比例保证历史结论不会永久锁死采样池。
 */
function adaptivePool(
  cidrs: string[],
  limit: number,
  includeZero: boolean,
  neutral: boolean,
  random: () => number,
  store?: ProfileStoreDocument,
  options?: { explorationRate?: number; now?: number; halfLifeMs?: number; profileId?: string },
): SamplingCandidate[] {
  type Interval = { family: 4 | 6; start: bigint; end: bigint }
  const ranges = cidrs.map(parseCidr).filter((item): item is NonNullable<ReturnType<typeof parseCidr>> => item !== null)
    .map((item): Interval => ({ family: item.family, start: item.base, end: item.base + item.size }))
    .sort((a, b) => a.family - b.family || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged: Interval[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && previous.family === range.family && range.start <= previous.end) previous.end = previous.end > range.end ? previous.end : range.end
    else merged.push({ ...range })
  }
  const format = (value: bigint, family: 4 | 6): string => family === 4
    ? [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join('.')
    : Array.from({ length: 8 }, (_, index) => ((value >> BigInt(112 - index * 16)) & 65535n).toString(16)).join(':')
  const boundaries = Object.keys(IPV4_CIDR_WEIGHTS).map(parseCidr).filter((item): item is NonNullable<ReturnType<typeof parseCidr>> => item !== null).flatMap((item) => [item.base, item.base + item.size])
  const now = options?.now ?? Date.now()
  const halfLife = options?.halfLifeMs ?? 7 * 24 * 60 * 60 * 1000
  const segments: Array<Interval & { staticWeight: number; weight: number; used: Set<bigint> }> = []
  for (const range of merged) {
    const cuts = [...new Set([range.start, ...(range.family === 4 ? boundaries.filter((point) => point > range.start && point < range.end) : []), range.end])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    for (let index = 0; index < cuts.length - 1; index++) {
      const start = cuts[index]!, end = cuts[index + 1]!
      const staticWeight = range.family === 4 ? cidrWeight(`${format(start, 4)}/32`) : 1
      if (staticWeight === 0 && !includeZero) continue
      const observation = segmentObservation({ family: range.family, start, end }, store, options?.profileId ?? '', now, halfLife)
      const weight = neutral && staticWeight > 0 ? 1 : effectiveSegmentWeight(staticWeight, observation)
      segments.push({ family: range.family, start, end, staticWeight, weight, used: new Set() })
    }
  }
  if (segments.length === 0) return []

  const target = Math.max(0, Math.min(DEFAULT_CANDIDATE_SAMPLE * 4, Math.ceil(limit) * 4))
  const explorationRate = Math.min(1, Math.max(0, options?.explorationRate ?? 0.2))
  const exploreBudget = Math.min(target, Math.round(target * explorationRate))
  const exploitBudget = target - exploreBudget

  const out: SamplingCandidate[] = []
  const drawFrom = (segment: (typeof segments)[number], count: number): void => {
    const size = segment.end - segment.start
    if (size <= 0n) return
    let taken = 0
    // 桶内地址有限（一个 /24 只有 256 个），抽满后必须停下：
    // 否则「offset 已在 used 里」的回绕会永远转下去。
    for (let attempt = 0; attempt < count * 8 && taken < count; attempt++) {
      if (BigInt(segment.used.size) >= size) break
      let value = 0n
      for (let word = 0; word < (segment.family === 4 ? 1 : 4); word++) value = (value << 32n) | BigInt(Math.floor(random() * 4294967296))
      let offset = value % size
      // 回绕查找空闲地址，最多转一圈。
      for (let probe = 0n; probe < size && segment.used.has(offset); probe++) {
        offset = (offset + 1n) % size
      }
      if (segment.used.has(offset)) break
      segment.used.add(offset)
      out.push({ ip: format(segment.start + offset, segment.family), staticWeight: segment.staticWeight })
      taken++
    }
  }

  // 探索预算：按地址空间均匀覆盖（零权重网段只在这里出现）。
  const totalSize = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0n)
  if (exploreBudget > 0 && totalSize > 0n) {
    for (const segment of segments) {
      const share = Number(((segment.end - segment.start) * BigInt(exploreBudget)) / totalSize)
      if (share > 0) drawFrom(segment, share)
    }
  }

  // 利用预算：按「网段大小 × 学习到的权重」分配。
  const totalWeight = segments.reduce((sum, segment) => sum + Number(segment.end - segment.start) * segment.weight, 0)
  if (exploitBudget > 0 && totalWeight > 0) {
    for (const segment of segments) {
      if (segment.weight <= 0) continue
      const share = Math.floor((Number(segment.end - segment.start) * segment.weight * exploitBudget) / totalWeight)
      if (share > 0) drawFrom(segment, share)
    }
  }
  return out
}

/** 动态随机种子：让每次运行的采样子集都不同 */
export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0
}

/**
 * 清洗外部传入的 IP 列表（面板手动优选 / 请求显式 candidates）。
 *
 * 兼容裸 IP、IP:Port、IP:Port#备注、[IPv6]:Port#备注、CSV 行；
 * 保留原始顺序并去重。
 *
 * ## 私网/保留地址过滤
 *
 * 与社区通用 `isPublicAddress` 一致：把 `127.0.0.1` / `192.168.x` / `10.x` /
 * `100.64.x`（CGNAT）/ `198.18.x`（fake-ip）/ 组播等**非公网地址**剔除。
 *
 * 为什么：这些地址连上去会以不同方式失败（拒绝 / 超时 / 连到自己的路由器），
 * 白白浪费一次探测；用户粘贴的列表尤其容易混进它们。
 */
export function normalizeCandidateList(input: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(input) || input.length === 0) return []
  const lines = input.filter((item): item is string => typeof item === 'string')
  if (lines.length === 0) return []

  const seen = new Set<string>()
  const out: string[] = []
  for (const ip of readIpFile(lines.join('\n'))) {
    if (seen.has(ip)) continue
    seen.add(ip)
    // 只对**字面量 IP** 做公网校验：域名不在此处解析（会在探测时由
    // TLS connect 的目标地址决定），无脑过滤会把用户显式给的域名也删掉。
    // 判定：纯数字加点 = IPv4；含冒号 = IPv6；其余 = 域名。
    const isIpv4Literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
    const isIpv6Literal = ip.includes(':')
    if (isIpv4Literal || isIpv6Literal) {
      if (!isPublicAddress(ip)) continue
    }
    out.push(ip)
  }
  return out
}
