/**
 * Trojan 入站协议解析
 *
 * 请求头布局：
 *   0..55  hex(SHA224(password)) —— 56 个 ASCII 十六进制字符
 *   56..57 CRLF
 *   58     命令：0x01 CONNECT / 0x03 UDP ASSOCIATE
 *   59     地址类型：1=IPv4 3=域名 4=IPv6
 *   60..   地址
 *   +2     端口（网络字节序）
 *   +2     CRLF
 *   之后    负载
 */
import type { ByteStream } from './stream'
import { readAddressFromStream } from './address'
import { sha224Hex } from './sha224'

export const TROJAN_COMMAND_TCP = 0x01
export const TROJAN_COMMAND_UDP = 0x03

export interface TrojanHeader {
  command: number
  port: number
  hostname: string
  addressType: number
}

export interface TrojanResult {
  header: TrojanHeader
  payload: ReadableStream<Uint8Array>
}

/** 计算 Trojan 口令校验值 */
export function trojanPasswordHash(password: string): string {
  return sha224Hex(new TextEncoder().encode(password))
}

function isCrLf(bytes: Uint8Array): boolean {
  return bytes.length === 2 && bytes[0] === 0x0d && bytes[1] === 0x0a
}

/** 解析 Trojan 请求头 */
export async function parseTrojan(
  stream: ByteStream,
  expectedPassword: string
): Promise<TrojanResult | null> {
  const expectedHash = trojanPasswordHash(expectedPassword)
  const hashBytes = await stream.peekExactly(56)

  // 客户端发送的是 56 个 ASCII 十六进制字符，直接按文本比较
  const provided = hashBytes
    ? new TextDecoder().decode(hashBytes).trim().toLowerCase()
    : ''

  if (provided === expectedHash) {
    // 标准做法：56 位十六进制 SHA224 摘要，其后紧跟 CRLF
    stream.skip(56)
    const crlf1 = await stream.readExactly(2)
    if (!crlf1 || !isCrLf(crlf1)) return null
  } else {
    // 容错：部分客户端直接发送明文口令（口令 + CRLF）
    const pwBytes = new TextEncoder().encode(expectedPassword)
    if (pwBytes.length === 0 || pwBytes.length > 56) return null
    const peek = await stream.peekExactly(pwBytes.length + 2)
    if (!peek) return null
    let matched = true
    for (let i = 0; i < pwBytes.length; i++) {
      if (peek[i] !== pwBytes[i]) {
        matched = false
        break
      }
    }
    if (!matched) return null
    if (!isCrLf(peek.subarray(pwBytes.length, pwBytes.length + 2))) return null
    stream.skip(pwBytes.length + 2)
  }

  const commandByte = await stream.readExactly(1)
  if (!commandByte) return null

  // 地址字段 = 类型字节 + 地址内容
  const address = await readAddressFromStream(stream, false)
  if (!address) return null

  const portBytes = await stream.readExactly(2)
  if (!portBytes) return null
  const crlf2 = await stream.readExactly(2)
  if (!crlf2 || !isCrLf(crlf2)) return null

  const port = (portBytes[0]! << 8) | portBytes[1]!
  return {
    header: {
      command: commandByte[0]!,
      port,
      hostname: address.hostname,
      addressType: address.addressType,
    },
    payload: stream.release(),
  }
}

export interface TrojanBufferResult {
  header: TrojanHeader
  consumed: number
}

/** 同步解析（见 vless.ts 中 parseVlessBuffer 的说明） */
export function parseTrojanBuffer(
  bytes: Uint8Array,
  expectedPassword: string
): TrojanBufferResult | null {
  if (bytes.byteLength < 58) return null
  const expectedHash = trojanPasswordHash(expectedPassword)
  const provided = new TextDecoder().decode(bytes.subarray(0, 56)).trim().toLowerCase()
  if (provided !== expectedHash) return null
  if (bytes[56] !== 0x0d || bytes[57] !== 0x0a) return null
  let offset = 58
  if (bytes.byteLength < offset + 2) return null
  const command = bytes[offset]!
  offset += 1
  const addressType = bytes[offset]!
  offset += 1

  let hostname = ''
  if (addressType === 1) {
    if (bytes.byteLength < offset + 4) return null
    hostname = `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`
    offset += 4
  } else if (addressType === 3) {
    if (bytes.byteLength < offset + 1) return null
    const len = bytes[offset]!
    offset += 1
    if (bytes.byteLength < offset + len) return null
    hostname = new TextDecoder().decode(bytes.subarray(offset, offset + len))
    offset += len
  } else if (addressType === 4) {
    if (bytes.byteLength < offset + 16) return null
    const parts: string[] = []
    for (let i = 0; i < 8; i++) parts.push(((bytes[offset + i * 2]! << 8) | bytes[offset + i * 2 + 1]!).toString(16))
    hostname = parts.join(':')
    offset += 16
  } else {
    return null
  }

  if (bytes.byteLength < offset + 4) return null
  const port = (bytes[offset]! << 8) | bytes[offset + 1]!
  offset += 2
  if (bytes[offset] !== 0x0d || bytes[offset + 1] !== 0x0a) return null
  offset += 2

  return { header: { command, port, hostname, addressType }, consumed: offset }
}
