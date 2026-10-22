/**
 * 机房落地中转（绕开 `TCP Loop detected`）
 *
 * ## 背景
 *
 * Cloudflare 禁止 Worker 的出站 socket 连向另一个 Cloudflare 边缘 IP。
 * 当目标是 Cloudflare Anycast 地址（或解析到了 CF 网段）时，`connect()` 会抛
 * `TCP Loop detected`。CFNext 的做法是按 `request.cf.colo` 换一个
 * 「非当前路径」的落地域名再走 DoH 解析，本模块用自研代码复现同一策略。
 *
 * 与 CFNext 的差异：它硬编码了一组 `proxyip.<region>.<domain>` 域名字符串，
 * 依赖某个具体上游项目维护的 DNS 记录。本模块改为：
 *   1. 判断目标是否落在 Cloudflare 网段（内置 CIDR，与 scanner 共用同一份数据）；
 *   2. 若落在 CF 网段，优先使用用户显式配置的 ProxyIP；
 *   3. 没有可用 ProxyIP 时，退回到「同区域优选 IP 库」的域名解析结果。
 * 不内置任何第三方域名，避免把用户流量导向不受控的主机。
 */

/** Cloudflare IPv4 网段（官方公布 + 常见扩展段） */
const CLOUDFLARE_V4 = [
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '162.158.0.0/15',
  '108.162.192.0/18',
  '141.101.64.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '173.245.48.0/20',
]

/** Cloudflare IPv6 网段 */
const CLOUDFLARE_V6 = ['2606:4700::/32', '2400:cb00::/32', '2803:f800::/32', '2a06:98c0::/29']

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    value = (value << 8) | n
  }
  return value >>> 0
}

function parseCidrV4(cidr: string): { base: number; mask: number } | null {
  const [addr, bits] = cidr.split('/')
  const base = ipv4ToInt(addr ?? '')
  if (base === null) return null
  const prefix = Number(bits)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  // 注意：JS 的 << 作用于 32 位有符号整数，prefix < 32 时 0xffffffff << (32-prefix)
  // 可能溢出成负数，必须 >>> 0 归一化，否则 base & mask 的比较会因符号位失配。
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0)
  return { base: (base & mask) >>> 0, mask }
}

const V4_RANGES = CLOUDFLARE_V4.map(parseCidrV4).filter((r): r is { base: number; mask: number } => r !== null)

function ipv6ToGroups(ip: string): number[] | null {
  if (!ip.includes(':')) return null
  const text = ip
  const double = text.indexOf('::')
  let head: string[] = []
  let tail: string[] = []
  if (double >= 0) {
    if (text.indexOf('::', double + 1) >= 0) return null
    head = text.slice(0, double) ? text.slice(0, double).split(':') : []
    tail = text.slice(double + 2) ? text.slice(double + 2).split(':') : []
  } else {
    head = text.split(':')
  }
  const toNum = (g: string): number | null => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : null)
  const groups: number[] = []
  for (const g of head) {
    const n = toNum(g)
    if (n === null) return null
    groups.push(n)
  }
  const missing = 8 - groups.length - tail.length
  if (missing < 0) return null
  for (let i = 0; i < missing; i++) groups.push(0)
  for (const g of tail) {
    const n = toNum(g)
    if (n === null) return null
    groups.push(n)
  }
  return groups.length === 8 ? groups : null
}

function parseCidrV6(cidr: string): { base: number[]; prefix: number } | null {
  const [addr, bits] = cidr.split('/')
  const base = ipv6ToGroups(addr ?? '')
  if (!base) return null
  const prefix = Number(bits)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null
  return { base, prefix }
}

const V6_RANGES = CLOUDFLARE_V6.map(parseCidrV6).filter((r): r is { base: number[]; prefix: number } => r !== null)

/** 目标是否落在 Cloudflare 网段（这类地址会触发 Loop） */
export function isCloudflareAddress(host: string): boolean {
  const target = host.trim()
  if (target.includes(':')) {
    const groups = ipv6ToGroups(target)
    if (!groups) return false
    for (const range of V6_RANGES) {
      let match = true
      const fullGroups = Math.floor(range.prefix / 16)
      const restBits = range.prefix % 16
      for (let i = 0; i < fullGroups; i++) {
        if (groups[i] !== range.base[i]) { match = false; break }
      }
      if (match && restBits > 0) {
        const mask = (0xffff << (16 - restBits)) & 0xffff
        if ((groups[fullGroups]! & mask) !== (range.base[fullGroups]! & mask)) match = false
      }
      if (match) return true
    }
    return false
  }

  const value = ipv4ToInt(target)
  if (value === null) return false
  for (const range of V4_RANGES) {
    if (((value & range.mask) >>> 0) === range.base) return true
  }
  return false
}

/**
 * 机房三字码 → 区域分组。
 *
 * 只用于「就近挑选用户自配置的 ProxyIP」，不映射到任何内置域名。
 */
export function coloToRegion(colo: string): string {
  const code = String(colo ?? '').toUpperCase()
  const map: Record<string, string> = {
    HKG: 'HK', TPE: 'HK', NRT: 'JP', KIX: 'JP', ICN: 'KR', SIN: 'SG',
    FRA: 'DE', MUC: 'DE', AMS: 'NL', ARN: 'SE', HEL: 'FI', LHR: 'GB',
    LAX: 'US', SJC: 'US', SEA: 'US', IAD: 'US', ORD: 'US', DFW: 'US',
    MIA: 'US', JFK: 'US', EWR: 'US', ATL: 'US', DEN: 'US', SFO: 'US',
  }
  return map[code] ?? (/^[A-Z]{3}$/.test(code) ? 'US' : 'US')
}

/** 内置 CF 网段数量（测试与诊断用） */
export const CLOUDFLARE_RANGE_COUNT = V4_RANGES.length + V6_RANGES.length
