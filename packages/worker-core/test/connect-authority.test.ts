/**
 * HTTP CONNECT 请求走私（CRLF 注入）回归。
 *
 * 目标主机名来自客户端 VLESS / Trojan 请求头，是**任意字节**。
 * 直接拼进 `CONNECT <authority> HTTP/1.1\r\nHost: <authority>\r\n` 时，
 * 含 \r\n 的 host 能注入额外请求头、甚至伪造第二个 CONNECT。
 * 校验必须在拿 writable 锁之前完成，否则会留下半开的 socket。
 */
import { describe, expect, it } from 'vitest'
import { httpConnect } from '../src/outbound/http-proxy'
import { isSafeConnectHost } from '../src/protocols/address'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function proxyResponse(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc('HTTP/1.1 200 Connection Established\r\n\r\n'))
      controller.close()
    },
  })
}

function collectingWritable(): { stream: WritableStream<Uint8Array>; text: () => string } {
  const chunks: Uint8Array[] = []
  return {
    stream: new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk) } }),
    text: () => chunks.map((c) => new TextDecoder().decode(c)).join(''),
  }
}

const INJECTIONS = [
  'example.com\r\nX-Injected: true',
  'example.com\nHost: evil.example',
  'example.com\r',
  'example.com\u0000',
  'example.com\u007f',
  'example.com\r\n\r\nCONNECT evil.example:443 HTTP/1.1',
  'example.com with space',
  'example.com@evil',
  '',
]

describe('CONNECT authority 注入防护', () => {
  it.each(INJECTIONS)('拒绝畸形主机名 %j', async (host) => {
    const w = collectingWritable()
    await expect(httpConnect(proxyResponse(), w.stream, host, 443)).rejects.toThrow(
      /Invalid CONNECT authority/
    )
    // 拒绝发生在拿到 writable 之前：一个字节都不能发给代理
    expect(w.text()).toBe('')
  })

  it('非法端口一律拒绝', async () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      const w = collectingWritable()
      await expect(httpConnect(proxyResponse(), w.stream, 'example.com', port)).rejects.toThrow(
        /Invalid CONNECT authority/
      )
      expect(w.text()).toBe('')
    }
  })

  it('常见合法目标形态不被误伤', async () => {
    for (const host of [
      'example.com',
      'sub.example.co.uk',
      'xn--fsqu00a.xn--0zwm56d',
      'a-b.example.com',
      '104.16.1.1',
      '2606:4700::1',
      'localhost',
      'my_host',
    ]) {
      const w = collectingWritable()
      await httpConnect(proxyResponse(), w.stream, host, 443)
      expect(w.text()).toContain('CONNECT ')
    }
  })

  it('超长主机名（>253）拒绝', async () => {
    const w = collectingWritable()
    await expect(
      httpConnect(proxyResponse(), w.stream, 'a'.repeat(254), 443)
    ).rejects.toThrow(/Invalid CONNECT authority/)
    expect(w.text()).toBe('')
  })

  it('isSafeConnectHost 只放行规范形态', () => {
    for (const host of INJECTIONS) expect(isSafeConnectHost(host)).toBe(false)
    expect(isSafeConnectHost('example.com')).toBe(true)
    expect(isSafeConnectHost('2606:4700::1')).toBe(true)
    expect(isSafeConnectHost('localhost')).toBe(true)
  })
})
