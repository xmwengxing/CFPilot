/**
 * SOCKS5 客户端握手（出站落地代理）
 */
import { ByteStream } from '../protocols/stream'
import { isIpv4, isIpv6 } from '../protocols/address'

export interface Socks5Options {
  username?: string
  password?: string
}

/**
 * 在已建立的 TCP 连接上完成 SOCKS5 认证与 CONNECT。
 * 成功返回剩余可读流（可能包含握手响应之后的残留数据）。
 */
export async function socks5Connect(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  hostname: string,
  port: number,
  options: Socks5Options = {}
): Promise<ReadableStream<Uint8Array>> {
  const stream = new ByteStream(readable)
  const writer = writable.getWriter()

  const send = async (bytes: Uint8Array): Promise<void> => {
    await writer.write(bytes)
  }

  try {
    const methods: number[] = [0x00]
    if (options.username) methods.push(0x02)
    const greeting = new Uint8Array(2 + methods.length)
    greeting[0] = 0x05
    greeting[1] = methods.length
    greeting.set(methods, 2)
    await send(greeting)

    const methodReply = await stream.readExactly(2)
    if (!methodReply || methodReply[0] !== 0x05) throw new Error('SOCKS5 握手失败：非法响应')
    const method = methodReply[1]!

    if (method === 0x02) {
      const user = new TextEncoder().encode(options.username ?? '')
      const pass = new TextEncoder().encode(options.password ?? '')
      const auth = new Uint8Array(3 + user.length + pass.length)
      auth[0] = 0x01
      auth[1] = user.length
      auth.set(user, 2)
      auth[2 + user.length] = pass.length
      auth.set(pass, 3 + user.length)
      await send(auth)
      const authReply = await stream.readExactly(2)
      if (!authReply || authReply[1] !== 0x00) throw new Error('SOCKS5 用户名/密码认证失败')
    } else if (method !== 0x00) {
      throw new Error(`SOCKS5 不支持的认证方式：0x${method.toString(16)}`)
    }

    const address = encodeSocks5Address(hostname, port)
    const request = new Uint8Array(3 + address.length)
    request[0] = 0x05
    request[1] = 0x01 // CONNECT
    request[2] = 0x00
    request.set(address, 3)
    await send(request)

    const reply = await stream.readExactly(4)
    if (!reply || reply[0] !== 0x05) throw new Error('SOCKS5 CONNECT 响应非法')
    if (reply[1] !== 0x00) throw new Error(`SOCKS5 CONNECT 失败：0x${reply[1]!.toString(16)}`)

    // 读取绑定地址（长度取决于地址类型）
    const atyp = reply[3]!
    if (atyp === 0x01) await stream.readExactly(4)
    else if (atyp === 0x03) {
      const lenByte = await stream.readExactly(1)
      if (!lenByte) throw new Error('SOCKS5 响应截断')
      await stream.readExactly(lenByte[0]!)
    } else if (atyp === 0x04) await stream.readExactly(16)
    else throw new Error('SOCKS5 响应地址类型非法')
    await stream.readExactly(2) // 端口

    return stream.release()
  } finally {
    try {
      writer.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
}

function encodeSocks5Address(hostname: string, port: number): Uint8Array {
  if (isIpv4(hostname)) {
    const parts = hostname.split('.').map((p) => Number(p))
    const out = new Uint8Array(7)
    out[0] = 0x01
    out.set(parts, 1)
    out[5] = (port >> 8) & 0xff
    out[6] = port & 0xff
    return out
  }
  if (isIpv6(hostname)) {
    const out = new Uint8Array(19)
    out[0] = 0x04
    const groups = hostname.split(':').filter(Boolean)
    for (let i = 0; i < 8; i++) {
      const value = parseInt(groups[i] ?? '0', 16) || 0
      out[1 + i * 2] = (value >> 8) & 0xff
      out[2 + i * 2] = value & 0xff
    }
    out[17] = (port >> 8) & 0xff
    out[18] = port & 0xff
    return out
  }
  const name = new TextEncoder().encode(hostname)
  const out = new Uint8Array(2 + name.length + 2)
  out[0] = 0x03
  out[1] = name.length
  out.set(name, 2)
  out[out.length - 2] = (port >> 8) & 0xff
  out[out.length - 1] = port & 0xff
  return out
}
