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
import { formatIpv6, readAddressFromStream } from './address'

export const VLESS_VERSION = 0x00
export const VLESS_COMMAND_TCP = 0x01
export const VLESS_COMMAND_UDP = 0x02
/** Mux（smux 多流）—— 需要多路复用状态机，本数据面不支持 */
export const VLESS_COMMAND_MUX = 0x03
/** 反向代理命令 */
export const VLESS_COMMAND_RVS = 0x04

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

/** 复用的解码器：每条连接都要解一次域名，避免每次构造新实例 */
const TEXT_DECODER = new TextDecoder()

/**
 * 按 uuid 字符串缓存解析结果。
 *
 * 期望值只来自配置，键的个数极少；配置一换就自然换键失效。
 * 这里刻意不往 `UserConfig` 上挂编译字段 —— 配置对象会被整体
 * `JSON.stringify` 写回 KV，`Uint8Array` 会污染存储 schema。
 * 返回值为只读，调用方只做逐字节比较。
 */
const uuidBytesCache = new Map<string, Uint8Array | null>()

/** UUID 字符串 → 16 字节 */
export function uuidToBytes(uuid: string): Uint8Array | null {
  const hit = uuidBytesCache.get(uuid)
  if (hit !== undefined) return hit
  const clean = uuid.replace(/-/g, '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(clean)) {
    uuidBytesCache.set(uuid, null)
    return null
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  if (uuidBytesCache.size >= 16) uuidBytesCache.clear()
  uuidBytesCache.set(uuid, out)
  return out
}

/**
 * 协议头字节已够判凭据、但 UUID 不匹配。
 *
 * ## 为什么需要区分「半包」与「认证失败」
 *
 * `parseVlessBuffer` 对两种情况都返回 `null`，而 WS 入站会把它当成
 * 「半包还没收齐」，启动 2 秒握手截止定时器，并在等待期间允许对端继续
 * 灌最多 64KB —— 扫描器/错误 UUID 的客户端因此白占 2 秒与内存。
 * 这里把「字节数已够 17 字节（版本 + UUID）」且不匹配的情况单独判出来，
 * 调用方可以立即关闭。
 */
export function vlessAuthFailed(bytes: Uint8Array, expectedUuid: string): boolean {
  if (bytes.byteLength < 17) return false
  const expected = uuidToBytes(expectedUuid)
  if (!expected) return false
  for (let i = 0; i < 16; i++) {
    if (bytes[1 + i] !== expected[i]) return true
  }
  return false
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
  // 逐字节比较：UUID 校验在每一条连接的握手路径上。
  // 早期用「转成 32 字符十六进制再比较字符串」，一次校验要多分配两个字符串，
  // 对只需要知道「相等与否」的校验毫无意义。
  for (let i = 0; i < 16; i++) {
    if (uuidBytes[i] !== expected[i]) return null
  }

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
 * 从 Addons protobuf 里取 `flow` 字符串（field 1, wire type 2）。
 *
 * 只需要判「有没有 flow」：XTLS-RPRX-Vision 需要裸 TCP 与 TLS 记录内省，
 * Workers 的 WS 是消息帧且铁律 12 禁止终结出站 TLS，物理上无法实现。
 * 这里不做完整 protobuf 解析，只按 tag 跳过不认识的字段。
 */
export function vlessFlow(addons: Uint8Array): string {
  let i = 0
  while (i < addons.byteLength) {
    const tag = addons[i++]!
    const field = tag >> 3
    const wire = tag & 0x07
    if (wire === 2) {
      let len = 0
      let shift = 0
      let b = 0
      do {
        if (i >= addons.byteLength) return ''
        b = addons[i++]!
        len |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      if (i + len > addons.byteLength) return ''
      if (field === 1 && len > 0) {
        return TEXT_DECODER.decode(addons.subarray(i, i + len))
      }
      i += len
    } else if (wire === 0) {
      while (i < addons.byteLength && (addons[i++]! & 0x80) !== 0) {
        /* 跳过 varint */
      }
    } else {
      // 不认识的 wire type：没必要继续冒险解析
      return ''
    }
  }
  return ''
}

/**
 * 校验 VLESS 协议头，返回**明确拒绝原因**（null = 合法）。
 *
 * 此前 `parseVlessBuffer` 只读不校验：客户端开 Mux(0x03) 会把 smux 首字节
 * 当 addressType 解析，表现为「挂且诊断看不出原因」；非 0 version 也被接受；
 * `flow=xtls-rprx-vision` 被静默当成普通 TCP，客户端误判已协商 vision。
 * 集中在这里，让 WS 与 XHTTP 两条入站路径共用同一套判定。
 */
export function validateVlessHeader(header: VlessHeader): string | null {
  if (header.version !== VLESS_VERSION) {
    return `VLESS 版本不支持：${header.version}`
  }
  if (header.command === VLESS_COMMAND_MUX || header.command === VLESS_COMMAND_RVS) {
    return 'VLESS Mux/反向命令不支持：请关闭客户端多路复用'
  }
  if (header.command !== VLESS_COMMAND_TCP && header.command !== VLESS_COMMAND_UDP) {
    return `VLESS 命令不支持：${header.command}`
  }
  const flow = vlessFlow(header.addons)
  if (flow) {
    return `VLESS flow(${flow}) 不支持：请关闭客户端 flow`
  }
  return null
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
    hostname = TEXT_DECODER.decode(bytes.subarray(offset, offset + len))
    offset += len
  } else if (addressType === 3) {
    if (bytes.byteLength < offset + 16) return null
    // 与 address.ts / readAddressFromStream 同口径（RFC 5952 压缩形式）：
    // 两个入口解析同一个 IPv6 目标必须得到同一个键，否则健康记忆/固定映射会分裂。
    const groups: number[] = []
    for (let i = 0; i < 8; i++) groups.push((bytes[offset + i * 2]! << 8) | bytes[offset + i * 2 + 1]!)
    hostname = formatIpv6(groups)
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
