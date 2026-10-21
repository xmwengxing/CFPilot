/**
 * Cloudflare IP 段库与地址采样
 *
 * 优先从 cloudflare.com/ips-v4、/ips-v6 拉取权威列表，
 * 网络不可用时回退到内置的 Free Plan 友好型网段。
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
    return { family: 6, base: base & ~mask, prefix, size }
  }

  if (prefix < 0 || prefix > 32) return null
  const value = ipv4ToBigInt(addr)
  if (value === null) return null
  const hostBits = 32 - prefix
  const size = 1n << BigInt(hostBits)
  const mask = hostBits === 0 ? 0n : ((1n << BigInt(hostBits)) - 1n)
  return { family: 4, base: value & ~mask, prefix, size }
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
 * 把网段展开为候选 IP 列表。
 * 大网段按比例均匀采样，避免一次枚举几百万个地址。
 */
export function expandCidrs(cidrs: string[], options: IpRangeOptions = {}): string[] {
  const sample = options.sample ?? 20000
  const random = makeRandom(options.seed ?? 0x5eed)
  const parsed = cidrs.map(parseCidr).filter((c): c is ParsedCidr => c !== null)
  if (parsed.length === 0) return []

  const totalSize = parsed.reduce((sum, c) => sum + c.size, 0n)
  const out: string[] = []

  for (const cidr of parsed) {
    if (sample <= 0 || cidr.size <= 2000n) {
      // 小网段全量枚举
      for (let i = 0n; i < cidr.size; i++) {
        const value = cidr.base + i
        out.push(cidr.family === 4 ? bigIntToIpv4(value) : bigIntToIpv6(value))
      }
      continue
    }
    const ratio = Number(totalSize === 0n ? 1n : (cidr.size * BigInt(sample)) / totalSize)
    const count = Math.max(64, Math.min(20000, ratio))
    const step = Number(cidr.size / BigInt(count))
    const offset = Math.floor(random() * step)
    for (let i = 0; i < count; i++) {
      const offsetValue = BigInt(offset + Math.floor(i * step))
      if (offsetValue >= cidr.size) break
      const value = cidr.base + offsetValue
      out.push(cidr.family === 4 ? bigIntToIpv4(value) : bigIntToIpv6(value))
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
