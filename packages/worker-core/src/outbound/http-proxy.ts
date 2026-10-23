/**
 * HTTP CONNECT 代理（出站落地代理）
 *
 * 同时用于两种代理：
 *   - `http://`  代理服务器本身走明文
 *   - `https://` 代理服务器本身走 TLS（由 Workers 的 `secureTransport:'on'` 终结，
 *     本函数在 TLS 之上发明文 CONNECT —— 与 edgetunnel 的 `httpsConnect` 一致）
 */
import { ByteStream } from '../protocols/stream'

const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a]

/** 代理握手超时（ms）：代理连上但不回应时的兜底 */
export const HANDSHAKE_TIMEOUT_MS = 6000

export interface HttpProxyAuth {
  username?: string
  password?: string
}

/** 在已建立的连接上完成 HTTP CONNECT 隧道握手 */
export async function httpConnect(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  hostname: string,
  port: number,
  auth: HttpProxyAuth = {}
): Promise<ReadableStream<Uint8Array>> {
  const stream = new ByteStream(readable)
  const writer = writable.getWriter()
  const target = `${hostname}:${port}`

  try {
    // 代理认证（RFC 7235 Basic）。edgetunnel 同样用 Proxy-Authorization 头。
    const authHeader =
      auth.username && auth.password
        ? `Proxy-Authorization: Basic ${btoa(`${auth.username}:${auth.password}`)}\r\n`
        : ''

    const request = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      'Proxy-Connection: keep-alive',
      'User-Agent: CFPilot/1.0',
      authHeader,
      '',
      '',
    ].join('\r\n')
    await writer.write(new TextEncoder().encode(request))

    // 逐字节读取响应头，直到出现 CRLFCRLF
    //
    // ⚠️ **必须带超时**：代理若连上了但不回应 CONNECT（真机实测：
    // 把 SOCKS5 服务器当 HTTP 代理用），没有超时的逐字节读会**永远挂起** ——
    // 表现为客户端拿到协议响应头后一直收不到数据、也不报错（静默挂起 60s+）。
    // 必须超时后抛错，让上层按「代理握手失败」分级上报。
    const header: number[] = []
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    for (let i = 0; i < 8192; i++) {
      if (Date.now() > deadline) {
        throw new Error(`HTTP 代理握手超时（${HANDSHAKE_TIMEOUT_MS}ms 无响应）`)
      }
      const byte = await Promise.race([
        stream.readExactly(1),
        new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
      ])
      // null = 本次读取超时；再给一个短窗口确认不是流刚好结束
      if (!byte) {
        const tail = await Promise.race([
          stream.readExactly(1),
          new Promise<null>((r) => setTimeout(() => r(null), 200)),
        ])
        if (!tail) {
          throw new Error(`HTTP 代理握手超时（${HANDSHAKE_TIMEOUT_MS}ms 无响应）`)
        }
        header.push(tail[0]!)
        continue
      }
      header.push(byte[0]!)
      const n = header.length
      if (n >= 4 && header[n - 4] === CRLF_CRLF[0] && header[n - 3] === CRLF_CRLF[1] && header[n - 2] === CRLF_CRLF[2] && header[n - 1] === CRLF_CRLF[3]) {
        break
      }
    }

    const text = new TextDecoder().decode(new Uint8Array(header))
    const statusLine = text.split('\r\n')[0] ?? ''
    const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
    if (!match) throw new Error('HTTP 代理响应非法')
    if (match[1] !== '200') throw new Error(`HTTP 代理 CONNECT 失败：${match[1]}`)

    return stream.release()
  } finally {
    try {
      writer.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
}
