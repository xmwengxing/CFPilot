/**
 * 目标地址编解码
 *
 * 地址类型编号：
 *   VLESS  1=IPv4, 2=域名, 3=IPv6
 *   Trojan 1=IPv4, 3=域名, 4=IPv6
 *
 * 统一约定：`readAddress(bytes, offset, addressType, vlessStyle)` 中
 * `bytes[offset]` 是地址类型字节，其后紧跟地址内容；
 * 返回的 `next` 是整个地址字段（含类型字节）结束后的下标。
 */
import type { ByteStream } from './stream'

export type AddressType = 'ipv4' | 'domain' | 'ipv6'

export interface TargetAddress {
  hostname: string
  port: number
  addressType: AddressType
}

/** 复用的解码器：每个入站连接都要解一次域名，避免每次构造新实例 */
const TEXT_DECODER = new TextDecoder()

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

export function isIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host)
  if (!m) return false
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i])
    if (!Number.isInteger(part) || part < 0 || part > 255) return false
  }
  return true
}

export function isIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  // 基础合法性检查：仅允许十六进制、冒号、点分十进制
  if (!/^[0-9a-fA-F:.]+$/.test(host)) return false
  return parseIpv6(host) !== null
}

export function isDomain(host: string): boolean {
  return DOMAIN_RE.test(host) && host.length <= 253
}

/**
 * HTTP CONNECT 权威串（authority）的主机名校验。
 *
 * `hostname` 来自客户端 VLESS / Trojan 请求头，是**任意字节**。
 * 直接拼进 `CONNECT <authority> HTTP/1.1\r\nHost: <authority>\r\n` 时，
 * 含 `\r\n` 的主机名能注入额外请求头、甚至伪造第二个 CONNECT（请求走私）。
 * SOCKS5 用长度前缀二进制编码主机名、直连 `connect()` 也不是文本协议，
 * 因此只需守住 HTTP CONNECT 这一条文本链路。
 *
 * 策略：控制字符黑名单（注入的根因）+ 形态白名单（复用 isIpv4 / isIpv6 /
 * isDomain，并放行 `localhost` 这类单标签主机名）。这里**不做** DNS 解析 ——
 * SSRF 由 outbound/guard.ts 的 blockedTarget 负责，那是另一道门。
 */
export function isSafeConnectHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (/[\u0000-\u001f\u007f]/.test(host)) return false
  return isIpv4(host) || isIpv6(host) || isDomain(host) || /^[a-zA-Z0-9_-]+$/.test(host)
}

/** 校验 CONNECT authority；失败抛错，由上层按「代理握手失败」分级上报 */
export function assertSafeConnectAuthority(hostname: string, port: number): void {
  if (!isSafeConnectHost(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid CONNECT authority')
  }
}

/* ------------------------------------------------------------------ */
/* IPv6 辅助                                                            */
/* ------------------------------------------------------------------ */

/** 把 IPv6 文本解析为 8 个 16 位分组，失败返回 null */
export function parseIpv6(host: string): number[] | null {
  if (!host.includes(':')) return null

  // 处理内嵌 IPv4（如 ::ffff:104.16.0.1）
  let text = host
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (!isIpv4(tail)) return null
    const parts = tail.split('.').map((p) => Number(p))
    text = `${text.slice(0, lastColon + 1)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }

  const doubleColon = text.indexOf('::')
  let headGroups: string[]
  let tailGroups: string[]
  if (doubleColon >= 0) {
    if (text.indexOf('::', doubleColon + 1) >= 0) return null
    const headText = text.slice(0, doubleColon)
    const tailText = text.slice(doubleColon + 2)
    headGroups = headText ? headText.split(':') : []
    tailGroups = tailText ? tailText.split(':') : []
  } else {
    headGroups = text.split(':')
    tailGroups = []
  }

  const total = headGroups.length + tailGroups.length
  if (total > 8) return null
  const groups: number[] = []
  const toGroup = (g: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    return parseInt(g, 16)
  }
  for (const g of headGroups) {
    const value = toGroup(g)
    if (value === null) return null
    groups.push(value)
  }
  const middle = 8 - total
  for (let i = 0; i < middle; i++) groups.push(0)
  for (const g of tailGroups) {
    const value = toGroup(g)
    if (value === null) return null
    groups.push(value)
  }
  return groups.length === 8 ? groups : null
}

/** 把 8 个 16 位分组格式化为压缩形式的 IPv6 文本 */
export function formatIpv6(groups: number[]): string {
  const hex = groups.map((g) => (g & 0xffff).toString(16))
  let bestStart = -1
  let bestLen = 0
  let start = -1
  let len = 0
  for (let i = 0; i < hex.length; i++) {
    if (hex[i] === '0') {
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
  if (bestLen < 2) return hex.join(':')
  const head = hex.slice(0, bestStart).join(':')
  const tail = hex.slice(bestStart + bestLen).join(':')
  return `${head}::${tail}`
}

/* ------------------------------------------------------------------ */
/* 读取                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 读取地址字段。
 * @param bytes 缓冲区
 * @param offset 地址类型字节所在位置
 * @param addressType 地址类型编号
 * @param vlessStyle true 使用 VLESS 编号（域名 2 / IPv6 3），false 使用 Trojan 编号（域名 3 / IPv6 4）
 */
export function readAddress(
  bytes: Uint8Array,
  offset: number,
  addressType: number,
  vlessStyle: boolean
): { hostname: string; next: number } | null {
  if (offset < 0 || offset >= bytes.length) return null

  if (addressType === 1) {
    // IPv4：类型字节 + 4 字节
    if (offset + 5 > bytes.length) return null
    const hostname = `${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}.${bytes[offset + 4]}`
    return { hostname, next: offset + 5 }
  }

  if (vlessStyle ? addressType === 2 : addressType === 3) {
    // 域名：类型字节 + 长度字节 + 内容
    if (offset + 2 > bytes.length) return null
    const len = bytes[offset + 1]!
    if (offset + 2 + len > bytes.length) return null
    const hostname = TEXT_DECODER.decode(bytes.subarray(offset + 2, offset + 2 + len))
    return { hostname, next: offset + 2 + len }
  }

  if (vlessStyle ? addressType === 3 : addressType === 4) {
    // IPv6：类型字节 + 16 字节
    if (offset + 17 > bytes.length) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 16)
    const groups: number[] = []
    for (let i = 0; i < 8; i++) groups.push(view.getUint16(i * 2, false))
    return { hostname: formatIpv6(groups), next: offset + 17 }
  }

  return null
}

/**
 * 从字节流中读取一个完整的地址字段。
 * 读取成功后游标停在地址之后，调用方可以继续读端口等内容。
 */
export async function readAddressFromStream(
  stream: ByteStream,
  vlessStyle: boolean
): Promise<{ hostname: string; addressType: number; consumed: number } | null> {
  const typeOnly = await stream.peekExactly(1)
  if (!typeOnly) return null
  const addressType = typeOnly[0]!

  let total: number
  if (addressType === 1) {
    total = 5
  } else if (vlessStyle ? addressType === 2 : addressType === 3) {
    // 域名需要先知道长度字节
    const head = await stream.peekExactly(2)
    if (!head) return null
    total = 2 + head[1]!
  } else if (vlessStyle ? addressType === 3 : addressType === 4) {
    total = 17
  } else {
    return null
  }

  const buf = await stream.peekExactly(total)
  if (!buf) return null
  const parsed = readAddress(buf, 0, addressType, vlessStyle)
  if (!parsed) return null
  stream.skip(total)
  return { hostname: parsed.hostname, addressType, consumed: total }
}

/* ------------------------------------------------------------------ */
/* 编码                                                                  */
/* ------------------------------------------------------------------ */

/** 将主机名编码为「类型字节 + 地址 + 端口」 */
export function encodeAddress(hostname: string, port: number, vlessStyle: boolean): Uint8Array {
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff])

  if (isIpv4(hostname)) {
    const parts = hostname.split('.').map((p) => Number(p))
    return new Uint8Array([1, ...parts, ...portBytes])
  }

  if (isIpv6(hostname)) {
    const groups = parseIpv6(hostname)
    if (!groups) return new Uint8Array(0)
    const out = new Uint8Array(1 + 16 + 2)
    out[0] = vlessStyle ? 3 : 4
    for (let i = 0; i < 8; i++) {
      const value = groups[i]!
      out[1 + i * 2] = (value >> 8) & 0xff
      out[2 + i * 2] = value & 0xff
    }
    out[17] = portBytes[0]!
    out[18] = portBytes[1]!
    return out
  }

  const name = new TextEncoder().encode(hostname)
  const out = new Uint8Array(1 + 1 + name.length + 2)
  out[0] = vlessStyle ? 2 : 3
  out[1] = name.length
  out.set(name, 2)
  out[out.length - 2] = portBytes[0]!
  out[out.length - 1] = portBytes[1]!
  return out
}
