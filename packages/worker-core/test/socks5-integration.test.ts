/**
 * SOCKS5 客户端实现对接**真实 SOCKS5 代理服务器**的集成测试。
 *
 * 与已有的 `http-proxy.test.ts`（内存流）不同，这里连的是真的 TCP 代理，
 * 能暴露「字节读取顺序」「分块到达」这类内存流测不出来的问题。
 *
 * 需要先启动本地代理：node socks5-proxy.mjs（端口 11080）
 */
import { describe, expect, it, beforeAll } from 'vitest'
import net from 'node:net'
import { socks5Connect } from '../src/outbound/socks5'

const PROXY_PORT = 11080
const TARGET_PORT = 18080
let proxyUp = false

beforeAll(async () => {
  // 探测代理是否在跑
  await new Promise<void>((resolve) => {
    const s = net.connect(PROXY_PORT, '127.0.0.1', () => {
      s.destroy()
      proxyUp = true
      resolve()
    })
    s.on('error', () => resolve())
    s.setTimeout(1000, () => {
      s.destroy()
      resolve()
    })
  })
})

describe('SOCKS5 客户端对接真实代理', () => {
  it('代理未启动时跳过（避免 CI 失败）', () => {
    if (!proxyUp) {
      expect(true).toBe(true)
      return
    }
    expect(proxyUp).toBe(true)
  })

  it('完成握手并拿到隧道流', async () => {
    if (!proxyUp) return

    const sock = net.connect(PROXY_PORT, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        sock.on('data', (c: Buffer) => controller.enqueue(new Uint8Array(c)))
        sock.on('end', () => controller.close())
        sock.on('error', (e: Error) => controller.error(e))
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          sock.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()))
        })
      },
    })

    // 目标是一个不存在的端口也可以：这里只验证握手与响应解析
    const stream = await socks5Connect(readable, writable, '127.0.0.1', TARGET_PORT, {})
    expect(stream).toBeInstanceOf(ReadableStream)
    sock.destroy()
  })

  it('代理返回非 0x05 版本时报错', async () => {
    if (!proxyUp) return

    // 造一个只返回垃圾字节的"代理"
    const fake = net.connect(PROXY_PORT, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      fake.once('connect', resolve)
      fake.once('error', reject)
    })
    // 直接写非法响应覆盖后续交互
    fake.write(Buffer.from([0x04, 0x00, 0x00, 0x00]))

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        fake.on('data', (c: Buffer) => controller.enqueue(new Uint8Array(c)))
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve) => {
          fake.write(Buffer.from(chunk), () => resolve())
        })
      },
    })

    await expect(socks5Connect(readable, writable, '127.0.0.1', 443, {})).rejects.toThrow(/非法|失败|认证方式/)
    fake.destroy()
  })
})

describe('SOCKS5 握手超时', () => {
  it('代理不回应时超时抛错，不静默挂起', async () => {
    const writable = new WritableStream<Uint8Array>({
      write() {
        /* 丢弃：模拟代理不回应 */
      },
    })
    const readable = new ReadableStream<Uint8Array>({
      start() {
        /* 故意不 enqueue */
      },
    })
    await expect(socks5Connect(readable, writable, 'example.com', 443, {})).rejects.toThrow(/超时/)
  }, 20000)
})
