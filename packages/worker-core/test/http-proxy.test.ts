/**
 * HTTP CONNECT 代理握手测试。
 *
 * 用内存流模拟一个 HTTP 代理服务器，验证：
 * ① CONNECT 请求行与 Host 头正确
 * ② 带凭据时发出 Proxy-Authorization（通用做法）
 * ③ 代理返回非 200 时明确报错（不能静默吞掉）
 * ④ CONNECT 响应之后紧跟的隧道数据不丢失
 */
import { describe, expect, it } from 'vitest'
import { httpConnect } from '../src/outbound/http-proxy'
import { concatBytes } from '../src/protocols/stream'

/** 收集写入端收到的全部字节 */
function collectingWritable(): { stream: WritableStream<Uint8Array>; text: () => string } {
  const chunks: Uint8Array[] = []
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  return {
    stream,
    text: () => new TextDecoder().decode(concat(chunks)),
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** 构造一个只读一次的内存流 */
function readableOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!)
        i++
      } else {
        controller.close()
      }
    },
  })
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('HTTP CONNECT 代理握手', () => {
  it('发出正确的 CONNECT 请求', async () => {
    const w = collectingWritable()
    const readable = readableOf(enc('HTTP/1.1 200 Connection Established\r\n\r\n'))
    await httpConnect(readable, w.stream, 'example.com', 443)
    const req = w.text()
    expect(req).toContain('CONNECT example.com:443 HTTP/1.1')
    expect(req).toContain('Host: example.com:443')
  })

  it('带凭据时发出 Proxy-Authorization 头', async () => {
    const w = collectingWritable()
    const readable = readableOf(enc('HTTP/1.1 200 Connection Established\r\n\r\n'))
    await httpConnect(readable, w.stream, 'example.com', 443, {
      username: 'user',
      password: 'pass',
    })
    const req = w.text()
    expect(req).toContain('Proxy-Authorization: Basic ')
    // Basic 编码内容可还原
    const b64 = req.match(/Proxy-Authorization: Basic (.+)\r\n/)?.[1] ?? ''
    expect(atob(b64)).toBe('user:pass')
  })

  it('无凭据时不发 Proxy-Authorization 头', async () => {
    const w = collectingWritable()
    const readable = readableOf(enc('HTTP/1.1 200 Connection Established\r\n\r\n'))
    await httpConnect(readable, w.stream, 'example.com', 443)
    expect(w.text()).not.toContain('Proxy-Authorization')
  })

  it('代理返回非 200 时明确报错', async () => {
    const w = collectingWritable()
    const readable = readableOf(enc('HTTP/1.1 403 Forbidden\r\n\r\n'))
    await expect(httpConnect(readable, w.stream, 'example.com', 443)).rejects.toThrow(/403/)
  })

  it('响应格式非法时报错', async () => {
    const w = collectingWritable()
    const readable = readableOf(enc('GARBAGE\r\n\r\n'))
    await expect(httpConnect(readable, w.stream, 'example.com', 443)).rejects.toThrow(/非法/)
  })

  it('CONNECT 响应之后紧跟的隧道数据不丢失', async () => {
    const w = collectingWritable()
    // 响应头与首包隧道数据在同一个 chunk 里
    const readable = readableOf(
      concatBytes(enc('HTTP/1.1 200 Connection Established\r\n\r\n'), enc('HELLO-TUNNEL'))
    )
    const stream = await httpConnect(readable, w.stream, 'example.com', 443)
    const reader = stream.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe('HELLO-TUNNEL')
  })

  it('响应头与隧道数据分块到达时也能正确拼接', async () => {
    const w = collectingWritable()
    const readable = readableOf(
      enc('HTTP/1.1 200 Conne'),
      enc('ction Established\r\n\r\nHE'),
      enc('LLO')
    )
    const stream = await httpConnect(readable, w.stream, 'example.com', 443)
    const reader = stream.getReader()
    const parts: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(new TextDecoder().decode(value))
    }
    expect(parts.join('')).toBe('HELLO')
  })
})

describe('代理握手超时（真机发现的静默挂起缺陷）', () => {
  it('代理连上但不回应时超时抛错，不静默挂起', async () => {
    // 构造一个「连上了但永不回应」的代理：写入端丢弃数据，读取端永远不返回
    const { stream: writable } = collectingWritable()
    const readable = new ReadableStream<Uint8Array>({
      start() {
        /* 故意不 enqueue 任何数据 —— 模拟代理不回应 CONNECT */
      },
    })
    await expect(
      httpConnect(readable, writable, 'example.com', 443, { username: 'u', password: 'p' })
    ).rejects.toThrow(/超时/)
  }, 20000)
})
