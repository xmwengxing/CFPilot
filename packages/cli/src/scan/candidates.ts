/**
 * 候选 IP 生成与清洗（cli.ts 与本地桥接服务共用）
 *
 * 规则：
 *   1. 自定义网段优先；未提供时拉取 Cloudflare 官方网段，网络不可用则回退内置网段。
 *   2. 统一交给 expandCidrs() 做可复现采样（相同 seed → 相同结果）。
 *   3. 本模块会被打包进单文件 CLI 产物，不要在这里写 shebang。
 */
import { resolve6 } from 'node:dns/promises'
import net from 'node:net'
import {
  BUILTIN_IPV4_CIDRS,
  BUILTIN_IPV6_CIDRS,
  IPV6_ACTIVE_PREFIXES,
  expandCidrs,
  fetchCloudflareCidrs,
  ipv6Prefix48,
  readIpFile,
} from './ip-ranges'
import { isPublicAddress } from './net-env'
import { adaptivePool } from './candidates_adaptive'
import { networkBucket, type AdaptiveSamplingOptions, type ProfileStoreDocument } from './network-profile'
import { detectIPv6Env, type IPv6EnvResult } from './ipv6-env'

/** 地址族：仅 IPv4 / 仅 IPv6 / 两者都要（**已解析完**的取值） */
export type IpFamily = 'v4' | 'v6' | 'both'
/**
 * 用户可选的地址族。
 *
 * `auto` = 先做 IPv6 环境预检，通了才让 v6 参与，不通就当纯 IPv4 ——
 * 这是默认值，因为「本机没有可用 IPv6」是常态，不该让用户先撞见
 * 一半候选全超时才明白怎么回事。
 */
export type FamilyChoice = IpFamily | 'auto'

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
  /** 地址族，默认 `auto`（按本机 IPv6 环境预检结果自动决定） */
  family?: FamilyChoice
  /**
   * 用于发现活跃 IPv6 前缀的域名（数据面域名、控制面域名等）。
   *
   * 这些域名的 AAAA 记录**永远指向当下真正在用的 /48**，
   * 比任何静态表都可靠 —— 静态表会漂移，用户自己的域名不会骗人。
   */
  extraHosts?: readonly string[]
  /** 预检与 AAAA 发现的注入点（单测用）；不传则走真实网络实现 */
  env?: {
    detect?: typeof detectIPv6Env
    discover?: typeof discoverIPv6Prefixes
  }
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
 * 从一批域名的 AAAA 记录里发现**活跃的 IPv6 /48**。
 *
 * ## 为什么这是最可靠的 v6 候选来源
 *
 * 2026-11-03 实测：Cloudflare 公布的 IPv6 聚合段里随机抽 /48 **0/18 全超时**，
 * 而「已知活跃 /48 内随机 IID」TCP 6/6、TLS 4/4、WS101 8/8 ——
 * 可用性是「48 位前缀」粒度，且只有少数这样的段真的在用。
 *
 * 用户自己域名的 AAAA 记录**永远指向当下真正在用的那些 /48**，
 * 且不依赖任何静态表、不会过期，所以排在静态表之前作为 L0 来源。
 *
 * 解析失败 / 超时 / 域名没有 AAAA 一律静默跳过 ——
 * 这只是补充来源，不是主流程。
 */
export async function discoverIPv6Prefixes(hosts: readonly string[], timeoutMs = 6000): Promise<string[]> {
  const out = new Set<string>()
  for (const raw of hosts) {
    const host = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    // 空、或本身就是 IP 字面量（没有 AAAA 可查）
    if (!host || net.isIP(host)) continue
    try {
      const addresses = await withTimeout(resolve6(host), timeoutMs)
      for (const address of addresses) {
        const bucket = networkBucket(address)
        if (bucket) out.add(bucket)
      }
    } catch {
      /* 解析失败 / 超时 / 无 AAAA：都不阻断 */
    }
  }
  return [...out].sort()
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 一次候选解析的完整结论（供 CLI `--json` 与界面展示）。 */
export interface CandidatePlan {
  candidates: string[]
  /** **解析后**的地址族（`auto` 已经被解析成 v4 或 both） */
  family: IpFamily
  /** IPv6 环境预检结论；未涉及 v6 时为 null */
  ipv6Env: IPv6EnvResult | null
  /** 本次参与 v6 采样的活跃 /48（静态表 ∪ AAAA 发现），已归一成 networkBucket 形式 */
  v6Prefixes: string[]
  /** 其中由 AAAA 运行期发现的 */
  v6Discovered: string[]
  /** 分族候选数 */
  counts: { v4: number; v6: number }
  /** 一句话结论，供 CLI 打印与界面提示 */
  note: string
}

function weightsOf(prefixes: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const cidr of prefixes) out[cidr] = 1
  return out
}

/** 取最多 3 个金丝雀地址（必须来自活跃前缀，否则 100% 超时会误判环境）。 */
function pickCanary(pool: readonly string[], extraWeights: Record<string, number>, seed: number): string[] {
  try {
    return expandCidrs([...pool], { sample: 3, seed, extraWeights }).slice(0, 3)
  } catch {
    return []
  }
}

/**
 * 生成候选列表的**完整结论**（预检 + 分族预算 + 候选）。
 *
 * ## 与 resolveCandidates 的关系
 *
 * 本函数是权威实现，`resolveCandidates()` 只是取 `.candidates` 的薄封装 ——
 * 两条路径必然一致，不会出现「CLI 打印的预检结论」与「实际采样行为」对不上。
 *
 * ## 默认种子必须每次不同（2026-10-28 修复）
 *
 * 早前 `seed` 默认写死 `DEFAULT_CANDIDATE_SEED = 24301`，
 * 于是**只要 `--sample` 不变，每次跑出来的候选列表 100% 一模一样**：
 * 若那批 IP 恰好落在当地运营商的劣质路由段上，重跑一百次也是同一批慢 IP，
 * 用户只会得出「优选出来的都慢」的结论 —— 实际是样本池僵死。
 *
 * 现在不传 `seed` 就用「时间 ^ 随机数」生成新种子；传了就照旧可复现。
 *
 * ## auto 的解析规则
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `v4` | 直接纯 v4，**零预检开销** |
 * | `v6` / `both` | 照做，预检只用来提示，不阻断（用户明确要求了） |
 * | `auto` + 显式给了 v6 网段 | 尊重用户 → both，预检失败只警告 |
 * | `auto` + 预检通过 | both |
 * | `auto` + 预检不通过 / 没有活跃前缀 | **纯 v4**，且**不写任何负向观测** |
 */
export async function resolveCandidatePlan(opts: CandidateOptions = {}): Promise<CandidatePlan> {
  const sample = opts.sample ?? DEFAULT_CANDIDATE_SAMPLE
  const seed = opts.seed ?? randomSeed()
  const choice = opts.family ?? 'auto'
  const neutral = opts.neutral === true
  const customCidrs = normalizeCidrInput(opts.cidr)
  const explicitV6 = customCidrs.some(isIpv6Cidr)

  let env: IPv6EnvResult | null = null
  let discovered: string[] = []
  let resolved: IpFamily = choice === 'auto' ? 'both' : choice
  /** 是否尝试过 v6（用于区分「用户就要纯 v4」与「v6 被预检拦下」） */
  let attemptedV6 = choice !== 'v4'
  let noteOverride: string | null = null

  // 显式网段全是 IPv4 → v6 根本无从采样，直接定为 v4 并**跳过预检**。
  // 这不只是省时间：预检会拉一次路由表 + 打一轮金丝雀 TCP，
  // 而结论必然是「v4 独自采样」，纯属浪费。
  if (customCidrs.length > 0 && !explicitV6 && choice !== 'v6') {
    resolved = 'v4'
    attemptedV6 = false
    noteOverride = '按 IPv4 采样（显式指定的网段均为 IPv4，未做 IPv6 预检）'
  }

  if (attemptedV6) {
    const detect = opts.env?.detect ?? detectIPv6Env
    const discover = opts.env?.discover ?? discoverIPv6Prefixes
    discovered = await discover(opts.extraHosts ?? [])
    const pool = [...new Set([...IPV6_ACTIVE_PREFIXES, ...discovered])]
    if (pool.length === 0) {
      // 一个已知可用的活跃段都没有（静态表被清空 + AAAA 也查不到）
      if (choice === 'auto') resolved = 'v4'
    } else {
      const extraWeights = weightsOf(discovered)
      env = await detect({ canary: pickCanary(pool, extraWeights, seed) })
      if (choice === 'auto') {
        resolved = env.status === 'ok' ? 'both' : 'v4'
        // 显式给了 v6 网段 → 尊重用户，预检结论只作提示
        if (explicitV6) resolved = 'both'
      }
    }
  }

  // 解析成 v4 时**整个把 v6 网段滤掉**：否则它们仍会留在待采样列表里，
  // 被 hasOtherFamily 判成「有另一族」而把 v4 的预算分走一半。
  const cidrs = customCidrs.length > 0 ? filterByFamily(customCidrs, resolved) : await loadCloudflareCidrs(resolved)
  const extraWeights = weightsOf(discovered)

  const random = seededRandom(seed)
  let candidates: string[]
  if (!opts.profile) {
    candidates = expandCidrs(cidrs, { sample, seed, neutral, extraWeights })
  } else {
    const adaptive: AdaptiveSamplingOptions = {
      limit: sample > 0 ? sample : DEFAULT_CANDIDATE_SAMPLE,
      random,
      ...opts.adaptiveSampling,
    }
    candidates = adaptivePool(
      cidrs,
      adaptive.limit,
      adaptive.includeZeroWeight === true,
      neutral,
      random,
      opts.profile,
      {
        explorationRate: adaptive.explorationRate,
        now: adaptive.now,
        halfLifeMs: adaptive.halfLifeMs,
        profileId: adaptive.profileId,
        profileIds: adaptive.profileIds,
        extraWeights,
      }
    ).map((item) => item.ip)
  }

  const counts = {
    v4: candidates.filter((ip) => !ip.includes(':')).length,
    v6: candidates.filter((ip) => ip.includes(':')).length,
  }
  const v6Prefixes = resolved === 'v4' ? [] : [...new Set([...IPV6_ACTIVE_PREFIXES, ...discovered])]

  return {
    candidates,
    family: resolved,
    ipv6Env: env,
    v6Prefixes,
    v6Discovered: discovered,
    counts,
    note: noteOverride ?? buildNote(choice, resolved, env, discovered),
  }
}

function buildNote(
  choice: FamilyChoice,
  resolved: IpFamily,
  env: IPv6EnvResult | null,
  discovered: readonly string[]
): string {
  if (choice === 'v4') return '按 IPv4 采样（用户指定）'
  if (resolved === 'v4') {
    if (env && env.status !== 'ok') return env.message
    if (env === null) return '未发现任何可用的活跃 IPv6 前缀，已只用 IPv4 采样'
    return '按 IPv4 采样'
  }
  const found = discovered.length > 0 ? `，其中 ${discovered.length} 个由域名 AAAA 发现` : ''
  const envPart = env ? `（${env.message}）` : ''
  return `IPv6 参与采样：活跃前缀 ${IPV6_ACTIVE_PREFIXES.length + discovered.length} 个${found}${envPart}`
}

/**
 * 生成候选 IP 列表（不涉及本地文件读取）。
 *
 * 与 CLI 的 --ip-file 分支互补：文件读取留在 cli.ts，这里只负责网段 → IP。
 * 完整结论（预检 / 分族 / 计数）见 `resolveCandidatePlan`。
 */
export async function resolveCandidates(opts: CandidateOptions = {}): Promise<string[]> {
  const plan = await resolveCandidatePlan(opts)
  return plan.candidates
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
