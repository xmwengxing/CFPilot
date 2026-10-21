/**
 * VLESS 入站协议解析
 *
 * 请求头布局：
 *   0      版本号（当前 Xray 写入 0x00）
 *   1..16  UUID 原始 16 字节
 *   17     Addons 长度 M
 *   18..   Addons（M 字节 protobuf）
 *   18+M   命令：0x01 TCP / 0x02 UDP
 *   +1..2  端口（网络字节序）
 *   +3     地址类型：1=IPv4 2=域名 3=IPv6
 *   +4..   地址
 *   之后    负载
 */
import type { ByteStream } from './stream'
import { readAddressFromStream } from './address'

export const VLESS_COMMAND_TCP = 0x01
export const VLESS_COMMAND_UDP = 0x02

export interface VlessHeader {
  version: number
  command: number
  port: number
  hostname: string
  addressType: number
  /** Addons 原始字节（可能为空） */
  addons: Uint8Array
}

export interface VlessResult {
  header: VlessHeader
  /** 协议头之后的负载流 */
  payload: ReadableStream<Uint8Array>
}

const HEX = '0123456789abcdef'

/** UUID 字符串 → 16 字节 */
export function uuidToBytes(uuid: string): Uint8Array | null {
  const clean = uuid.replace(/-/g, '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(clean)) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

/** 解析 VLESS 请求头 */
export async function parseVless(
  stream: ByteStream,
  expectedUuid: string
): Promise<VlessResult | null> {
  const version = await stream.readExactly(1)
  if (!version) return null
  const uuidBytes = await stream.readExactly(16)
  if (!uuidBytes) return null

  const expected = uuidToBytes(expectedUuid)
  if (!expected) return null
  if (bytesToHex(uuidBytes) !== bytesToHex(expected)) return null

  const addonsLenByte = await stream.readExactly(1)
  if (!addonsLenByte) return null
  const addonsLen = addonsLenByte[0]!
  const addons = addonsLen > 0 ? await stream.readExactly(addonsLen) : new Uint8Array(0)
  if (!addons) return null

  const commandByte = await stream.readExactly(1)
  if (!commandByte) return null
  const portBytes = await stream.readExactly(2)
  if (!portBytes) return null

  // 地址字段 = 类型字节 + 地址内容
  const address = await readAddressFromStream(stream, true)
  if (!address) return null

  const port = (portBytes[0]! << 8) | portBytes[1]!

  return {
    header: {
      version: version[0]!,
      command: commandByte[0]!,
      port,
      hostname: address.hostname,
      addressType: address.addressType,
      addons,
    },
    payload: stream.release(),
  }
}

export interface VlessBufferResult {
  header: VlessHeader
  /** 协议头占用的字节数，其后即为负载 */
  consumed: number
}

/**
 * 同步解析（用于 WebSocket 消息处理器内部）。
 *
 * 返回 null 表示「字节还不够」或校验失败；调用方应继续攒包。
 * 之所以需要同步版本：`connect()` 必须在 message 事件里同步调用，
 * 见 protocols/websocket.ts 顶部说明。
 */
export function parseVlessBuffer(bytes: Uint8Array, expectedUuid: string): VlessBufferResult | null {
  if (bytes.byteLength < 18) return null
  const expected = uuidToBytes(expectedUuid)
  if (!expected) return null
  for (let i = 0; i < 16; i++) {
    if (bytes[1 + i] !== expected[i]) return null
  }
  const addonsLen = bytes[17]!
  let offset = 18 + addonsLen
  if (bytes.byteLength < offset + 4) return null
  const command = bytes[offset]!
  offset += 1
  const port = (bytes[offset]! << 8) | bytes[offset + 1]!
  offset += 2
  const addressType = bytes[offset]!
  offset += 1

  let hostname = ''
  if (addressType === 1) {
    if (bytes.byteLength < offset + 4) return null
    hostname = `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`
    offset += 4
  } else if (addressType === 2) {
    if (bytes.byteLength < offset + 1) return null
    const len = bytes[offset]!
    offset += 1
    if (bytes.byteLength < offset + len) return null
    hostname = new TextDecoder().decode(bytes.subarray(offset, offset + len))
    offset += len
  } else if (addressType === 3) {
    if (bytes.byteLength < offset + 16) return null
    const parts: string[] = []
    for (let i = 0; i < 8; i++) parts.push(((bytes[offset + i * 2]! << 8) | bytes[offset + i * 2 + 1]!).toString(16))
    hostname = parts.join(':')
    offset += 16
  } else {
    return null
  }

  return {
    header: {
      version: bytes[0]!,
      command,
      port,
      hostname,
      addressType,
      addons: bytes.subarray(18, 18 + addonsLen),
    },
    consumed: offset,
  }
}
