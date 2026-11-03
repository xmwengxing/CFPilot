/**
 * 出站目标地址策略（SSRF 兜底）。
 *
 * ## 它拦什么、为什么拦
 *
 * 数据面允许客户端通过隧道访问任意目标。Workers 运行时本身到不了
 * `127.0.0.1` / `10.x` / `169.254.169.254` 这类地址，**真正的问题不是安全兜底**，
 * 而是：
 *
 *   1. 白等一次超时（默认 5s）之后才失败，用户只看到 -1，不知道为什么；
 *   2. 占掉「单请求 6 条并发出站」里的一个槽位，其它候选被挤掉；
 *   3. 元数据 / 环回 / 内网探测的请求形态对平台安全审计极不友好。
 *
 * 所以这里的目标是「**快速失败 + 明确原因**」，而不是假装运行时能被绕开。
 *
 * ## 为什么是黑名单，且只管直连
 *
 * - 用**黑名单**而不是「必须公网」白名单：白名单会误杀 `203.0.113.x`
 *   这类文档 / 测试地址（现有拨号用例正好在用）。
  * - 只拦**直连 / 优选 IP** 目标，**不拦代理与反代入口**：
 *   「用落地代理回家里的 NAS」是合法用法 —— 那时 `192.168.x` 是正确目的地，
 *   拦截它等于让用户的功能直接不可用。
 * - 只判字面量 IP 与内网域名，**不预解析域名**：每次出站都做 DNS 会显著拖慢
 *   正常路径（见 `dial.ts` 对反代入口按需解析的注释），收益远小于代价。
 *
 * 边界因此很明确：域名解析到内网地址（例如 `nas.example.com` → `192.168.1.5`）
 * 不在拦截范围内，仍会交给运行时去连（并通常以超时告终）。
 */
import { parseIpv6 } from '../protocols/address'

/** 被拦截的目标类别 */
export type BlockedTargetKind =
  /** 环回（127.0.0.0/8、::1、localhost） */
  | 'loopback'
  /** 私网（10/8、172.16/12、192.168/16） */
  | 'private'
  /** 链路本地（169.254/16、fe80::/10）—— 含云厂商元数据地址 */
  | 'link-local'
  /** 运营商级 NAT（100.64/10） */
  | 'cgnat'
  /** IPv6 唯一本地地址（fc00::/7） */
  | 'ula'
  /** 未指定地址（0.0.0.0/8、::） */
  | 'unspecified'
  /** 组播（224/4、ff00::/8） */
  | 'multicast'
  /** 保留地址（240/4） */
  | 'reserved'
  /** IPv6 字面量目标 —— 直连通道的能力上限，不是内网安全问题 */
  | 'ipv6-direct-unsupported'
  /** 固定的内网域名后缀（.local / .internal / localhost） */
  | 'internal-name'

export interface BlockedTarget {
  kind: BlockedTargetKind
  /** 面向用户的原因（中文，短句） */
  reason: string
}

/** 错误信息前缀 —— `classifyDialFailure` 据此归类为 `policy` */
export const TARGET_BLOCKED_PREFIX = '目标地址被策略拦截'

/**
 * IPv6 字面量目标在**直连通道**上的失败原因。
 *
 * ## 为什么这是「能力上限」而不是安全策略
 *
 * Workers 的 `connect()` 对 IPv6 目标出站不可用 —— 这条在生产环境实测过两轮
 * （2026-10-26 首测、2026-10-27 复核），2026-11-03 又用同一服务的
 * v4 / v6 双地址做了对照：v4 拿到目标的真实响应，v6 只拿到反代兜底的 400。
 *
 * 与之配套的两条链路也不通，所以**没有「再等等就好」的余地**：
 *   - 反代入口是**按 SNI 转发**的，SNI 必须是域名，字面量根本带不过去；
 *   - ProxyIP 走的是「把目标域名当 SNI 复用既有连接」，同样需要域名。
 *
 * 因此不提前失败的代价是：白等一次建连超时，然后收到一条与真实原因
 * 无关的失败文案，用户完全看不出问题在哪。
 *
 * **配了落地代理（SOCKS5 / HTTP / HTTPS）的路径不受此限制** ——
 * 字面量交给代理服务器去连是合法用法，且那条链路的 IPv6 打包刚修过。
 */
export const IPV6_DIRECT_UNSUPPORTED: BlockedTarget = {
  kind: 'ipv6-direct-unsupported',
  reason: '直连与反代通道不支持 IPv6 目标，可改用落地代理转发',
}

/** 目标被策略拦截 */
export class TargetBlockedError extends Error {
  readonly kind: BlockedTargetKind

  constructor(host: string, blocked: BlockedTarget) {
    super(`${TARGET_BLOCKED_PREFIX}：${host}（${blocked.reason}）`)
    this.name = 'TargetBlockedError'
    this.kind = blocked.kind
  }
}

/** 判断一个异常是否来自目标地址策略 */
export function isTargetBlockedError(err: unknown): boolean {
  if (err instanceof TargetBlockedError) return true
  const message = err instanceof Error ? err.message : String(err)
  // 竞速失败会把每个候选的错误摘进聚合文案，所以用 includes 而不是 startsWith
  if (message.includes(TARGET_BLOCKED_PREFIX)) return true
  // raceDial 同时把最后一个原始异常放在 cause 里
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined
  return cause !== undefined && cause !== err && isTargetBlockedError(cause)
}

/** IPv4 → 32 位无符号整数 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

/** IPv4 网段表：[基址, 前缀长度, 类别, 原因] */
const IPV4_RULES: ReadonlyArray<readonly [string, number, BlockedTargetKind, string]> = [
  ['0.0.0.0', 8, 'unspecified', '未指定地址'],
  ['10.0.0.0', 8, 'private', '私有网段'],
  ['100.64.0.0', 10, 'cgnat', '运营商级 NAT 网段'],
  ['127.0.0.0', 8, 'loopback', '环回地址'],
  ['169.254.0.0', 16, 'link-local', '链路本地 / 云元数据地址'],
  ['172.16.0.0', 12, 'private', '私有网段'],
  ['192.168.0.0', 16, 'private', '私有网段'],
  ['224.0.0.0', 4, 'multicast', '组播地址'],
  ['240.0.0.0', 4, 'reserved', '保留地址'],
]

function checkIpv4(ip: string): BlockedTarget | null {
  const value = ipv4ToInt(ip)
  if (value === null) return null
  for (const [base, prefix, kind, reason] of IPV4_RULES) {
    const baseValue = ipv4ToInt(base)
    if (baseValue === null) continue
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    if ((value & mask) === (baseValue & mask)) return { kind, reason }
  }
  return null
}

/**
 * 把 8 个 16 位分组拼回点分 IPv4（用于 IPv4-mapped / NAT64 内嵌地址）。
 * 只在 `groups[6..7]` 确实承载 v4 时调用。
 */
function groupsToIpv4(groups: number[]): string {
  const hi = groups[6] ?? 0
  const lo = groups[7] ?? 0
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`
}

function checkIpv6(ip: string): BlockedTarget | null {
  const clean = (ip.split('%')[0] ?? '').toLowerCase()
  if (!clean.includes(':')) return null

  // 统一归一化成 8 个分组再判 —— 文本形态有无数种写法
  // （`::` 压缩、大小写、十六进制尾巴、内嵌点分 IPv4），
  // 按字符串判必然被变形绕过；按分组判只有一种写法。
  //
  // 解析不了就放行：这里的目标是「快速失败 + 明确原因」，
  // 不是安全边界（运行时本就连不到内网，见文件头注释）。
  const groups = parseIpv6(clean)
  if (!groups) return null

  const headZero = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0

  // IPv4 映射地址：`::ffff:1.2.3.4` 与**十六进制写法** `::ffff:7f00:1`。
  //
  // ⚠️ 旧实现只认点分尾巴，于是 `::ffff:7f00:1`（=127.0.0.1）、
  // `::ffff:a9fe:a9fe`（=169.254.169.254 云元数据）全部放行 ——
  // 换个写法就绕过去了。按分组判没有这个问题。
  if (headZero && groups[5] === 0xffff) {
    const inner = checkIpv4(groupsToIpv4(groups))
    return inner ?? null
  }

  // 未指定 / 环回：前 7 组全 0，最后一组是 0 或 1
  if (headZero && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
    return groups[7] === 1
      ? { kind: 'loopback', reason: '环回地址' }
      : { kind: 'unspecified', reason: '未指定地址' }
  }

  // 早期 IPv4 兼容地址 `::a.b.c.d`（已废弃，但形态仍在）：同样按内嵌 v4 判
  if (headZero && groups[5] === 0) {
    const inner = checkIpv4(groupsToIpv4(groups))
    return inner ?? null
  }

  // NAT64 知名前缀 `64:ff9b::/96`：内嵌的 IPv4 可能是私网 / 环回
  //（`64:ff9b::10.0.0.1`、`64:ff9b::7f00:1` 都能直达内网语义）
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const inner = checkIpv4(groupsToIpv4(groups))
    if (inner) return inner
  }

  const head = groups[0] ?? 0
  if ((head & 0xfe00) === 0xfc00) return { kind: 'ula', reason: 'IPv6 唯一本地地址' }
  if ((head & 0xffc0) === 0xfe80) return { kind: 'link-local', reason: 'IPv6 链路本地地址' }
  if ((head & 0xff00) === 0xff00) return { kind: 'multicast', reason: 'IPv6 组播地址' }
  return null
}

/** 固定的内网域名后缀（不做 DNS 解析，只看形态） */
const INTERNAL_SUFFIXES = ['.local', '.internal'] as const

/**
 * 判定目标是否应被拦截。命中返回原因，否则返回 `null`。
 *
 * 只处理字面量 IP 与固定的内网域名后缀；普通域名一律放行（不预解析）。
 */
export function blockedTarget(hostname: string): BlockedTarget | null {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return null

  if (host.includes(':')) return checkIpv6(host)
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return checkIpv4(host)

  // RFC 6761：`*.localhost` 一律解析到环回
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { kind: 'loopback', reason: '环回主机名' }
  }
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host.endsWith(suffix)) return { kind: 'internal-name', reason: '内网域名后缀' }
  }
  return null
}
