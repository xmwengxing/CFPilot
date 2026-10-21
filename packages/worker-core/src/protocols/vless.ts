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
