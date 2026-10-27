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

/** 在字节序列里定位响应头终止符 CRLFCRLF（可跨块拼接） */
function indexOfHeaderTerminator(bytes: Uint8Array): number {
  const n = bytes.byteLength
  for (let i = 0; i + 3 < n; i++) {
    if (CRLF_CRLF.every((b, k) => bytes[i + k] === b)) return i
  }
  return -1
}

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

    // **按块**读取响应头，直到出现 CRLFCRLF —— 不要逐字节读。
    //
    // ⚠️ **必须带超时**：代理若连上了但不回应 CONNECT（真机实测：
    // 把 SOCKS5 服务器当 HTTP 代理用），没有超时的读会**永远挂起** ——
    // 表现为客户端拿到协议响应头后一直收不到数据、也不报错（静默挂起 60s+）。
    // 必须超时后抛错，让上层按「代理握手失败」分级上报。
    //
    // 早期实现逐字节 `readExactly(1)` 且**每字节**建一个 `Promise.race` + 定时器：
    // 解析一个百余字节的响应头要创建上百个 Promise/Timer，白烧 CPU
    // （免费版单请求仅 10ms 预算，性能方案 三.1 定位）。
    // 现改为「按块 fill + peek 整体扫描 + skip 精确消费」，典型 1~2 次读取；
    // 终止符之后同块到达的隧道数据留在 ByteStream 缓冲，由 `release()` 带出。
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    let headText = ''
    for (;;) {
      const view = stream.peek()
      const idx = indexOfHeaderTerminator(view)
      if (idx >= 0) {
        headText = new TextDecoder().decode(view.subarray(0, idx))
        stream.skip(idx + 4)
        break
      }
      if (view.byteLength > 8192) throw new Error('HTTP 代理响应头超过 8192 字节')
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`HTTP 代理握手超时（${HANDSHAKE_TIMEOUT_MS}ms 无响应）`)
      }
      const filled = await Promise.race([
        stream.fill(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
      ])
      if (filled === 'timeout') {
        throw new Error(`HTTP 代理握手超时（${HANDSHAKE_TIMEOUT_MS}ms 无响应）`)
      }
      if (filled === null) {
        // 流结束且未见终止符（终止符扫描已在本轮开头做过）
        throw new Error('HTTP 代理响应不完整（连接被提前关闭）')
      }
    }

    const text = headText
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
