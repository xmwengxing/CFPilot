/**
 * HTTP CONNECT 代理（出站落地代理）
 */
import { ByteStream } from '../protocols/stream'

const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a]

/** 在已建立的 TCP 连接上完成 HTTP CONNECT 隧道握手 */
export async function httpConnect(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  hostname: string,
  port: number
): Promise<ReadableStream<Uint8Array>> {
  const stream = new ByteStream(readable)
  const writer = writable.getWriter()
  const target = `${hostname}:${port}`

  try {
    const request = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      'Proxy-Connection: keep-alive',
      'User-Agent: CFPilot/1.0',
      '',
      '',
    ].join('\r\n')
    await writer.write(new TextEncoder().encode(request))

    // 逐字节读取响应头，直到出现 CRLFCRLF
    const header: number[] = []
    for (let i = 0; i < 8192; i++) {
      const byte = await stream.readExactly(1)
      if (!byte) break
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
