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
} from './ip-ranges'
import { isPublicAddress } from './net-env'

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
  if (customCidrs.length > 0) {
    return expandCidrs(filterByFamily(customCidrs, family), { sample, seed, neutral })
  }

  const cidrs = await loadCloudflareCidrs(family)
  return expandCidrs(cidrs, { sample, seed, neutral })
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
