/**
 * 拨号期间到达的数据帧不丢 —— 回归测试。
 *
 * 守护 2026-10-23 真机复现的缺陷：
 * 真实客户端（Xray / v2rayN / Clash 等）把 VLESS 协议头和首个数据包
 * 作为**两个独立的 WS 帧背靠背**发出，不等协议响应头。
 * 第二帧到达时 `established` 已置位、但 `writer` 尚未就绪（还在拨号），
 * 早前实现让它走 pumpUp → `if (!writer) return` **静默丢弃** →
 * 真机表现为「WS 升级 101、VLESS 认证通过，但隧道挂起、永远等不到响应」。
 *
 * vendor（CFNext）的实测形态是暂存回缓冲区，writer 就绪后整体补写：
 *   i ? (s ? await s.write(e) : l = l ? concat(l, e) : e) : await u(e)
 */
import { describe, expect, it, vi } from 'vitest'

// 可控拨号：返回的 promise 由测试手动 resolve，模拟「拨号进行中」
const dialMock = vi.hoisted(() => vi.fn())

/**
 * 把可控拨号注入 `globalThis.__cfpDial`。
 *
 * `websocket-self` 现在**不静态 import** `outbound/dial`（静态依赖会让
 * Workers 通道 isolate 启动失败，HTTP 522），改为从 `globalThis.__cfpDial`
 * 取拨号函数 —— 所以测试也必须走这条路径注入 mock。
 */
;(globalThis as { __cfpDial?: unknown }).__cfpDial = dialMock

const { handleWebSocket } = await import('../src/protocols/websocket-self')

const UUID = '11111111-2222-3333-4444-555555555555'

/** 测试用 WebSocket 桩（只需事件与发送能力） */
class FakeWebSocket {
  sent: Uint8Array[] = []
  closed: { code: number; reason: string } | null = null
  binaryType = ''
  private listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {}

  accept(): void {}
  send(bytes: Uint8Array): void {
    this.sent.push(bytes)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code: code ?? 1005, reason: reason ?? '' }
  }
  addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  emit(type: string, ev: { data: unknown }): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

/** WebSocketPair 全局桩：Object.values 顺序必须是 [client, server] */
class FakeWebSocketPair {
  client: FakeWebSocket
  server: FakeWebSocket
  constructor() {
    this.client = new FakeWebSocket()
    this.server = new FakeWebSocket()
  }
}

/**
 * 记录最近一次被创建的 pair。
 *
 * `handleWebSocket` 内部自己 `new WebSocketPair()`，测试拿不到引用，
 * 必须通过全局类的副作获取它实际使用的那一对。
 */
let lastPair: FakeWebSocketPair | null = null
class RecordingWebSocketPair extends FakeWebSocketPair {
  constructor() {
    super()
    lastPair = this
  }
}

function buildVlessHeader(hostname: string, port: number): Uint8Array {
  const clean = UUID.replace(/-/g, '')
  const uuid = new Uint8Array(16)
  for (let i = 0; i < 16; i++) uuid[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  const name = new TextEncoder().encode(hostname)
  return new Uint8Array([
    0x00, ...uuid, 0x00, // version + UUID + addons 长度 0
    0x01, (port >> 8) & 0xff, port & 0xff, // command=TCP + port
    0x02, name.length, ...name, // addrType=domain
  ])
}

/** 收集写入内容的 DialResult 桩 */
function collectingDial(): {
  result: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
  written: () => Uint8Array[]
} {
  const chunks: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  // 不结束、不产数据：只关心上行写入
  const readable = new ReadableStream<Uint8Array>({
    start() {
      /* 挂起 */
    },
  })
  return { result: { readable, writable }, written: () => chunks }
}

function setup(): { server: FakeWebSocket; releaseDial: (r: unknown) => void } {
  let releaseDial!: (r: unknown) => void
  dialMock.mockReturnValue(
    new Promise((resolve) => {
      releaseDial = resolve
    })
  )
  ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingWebSocketPair
  return {
    // handleWebSocket 在调用时才会创建 pair，用 getter 延迟取
    get server(): FakeWebSocket {
      if (!lastPair) throw new Error('handleWebSocket 尚未创建 WebSocketPair')
      return lastPair.server
    },
    releaseDial,
  }
}

const config = {
  uuid: UUID,
  trojanPassword: '',
  enableTrojan: false,
  wsPath: '/t',
  concurrentDial: 2,
  resolvePreferred: false,
} as unknown as Parameters<typeof handleWebSocket>[2]

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

describe('拨号期间的数据帧暂存（自研 WS 入站）', () => {
  it('协议头与首包分帧背靠背发出时，首包不丢', async () => {
    const ctx = setup()
    await handleWebSocket(request, 'vless', config, [])

    // 帧1：VLESS 协议头（触发拨号，dial 挂起中）
    ctx.server.emit('message', { data: buildVlessHeader('example.com', 80).buffer as ArrayBuffer })
    // 让 establish 走到 await dial
    await new Promise((r) => setTimeout(r, 5))

    // 帧2：背靠背的首包 —— 此刻 writer 尚未就绪
    ctx.server.emit('message', {
      data: new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n').buffer as ArrayBuffer,
    })

    // 释放拨号
    const dial = collectingDial()
    ctx.releaseDial(dial.result)
    await new Promise((r) => setTimeout(r, 10))

    const text = new TextDecoder().decode(
      Buffer.concat(dial.written().map((c) => Buffer.from(c)))
    )
    expect(text).toContain('GET / HTTP/1.1')
    expect(text).toContain('Host: example.com')
  })

  it('协议头与首包合并在同一帧时，首包不丢（原有路径不回归）', async () => {
    const ctx = setup()
    await handleWebSocket(request, 'vless', config, [])

    const merged = new Uint8Array([
      ...buildVlessHeader('example.com', 80),
      ...new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n'),
    ])
    ctx.server.emit('message', { data: merged.buffer as ArrayBuffer })
    await new Promise((r) => setTimeout(r, 5))

    const dial = collectingDial()
    ctx.releaseDial(dial.result)
    await new Promise((r) => setTimeout(r, 10))

    const text = new TextDecoder().decode(
      Buffer.concat(dial.written().map((c) => Buffer.from(c)))
    )
    expect(text).toContain('GET / HTTP/1.1')
  })

  it('拨号期间多帧暂存后，按到达顺序补写', async () => {
    const ctx = setup()
    await handleWebSocket(request, 'vless', config, [])

    ctx.server.emit('message', { data: buildVlessHeader('example.com', 80).buffer as ArrayBuffer })
    await new Promise((r) => setTimeout(r, 5))
    ctx.server.emit('message', { data: new TextEncoder().encode('AAA').buffer as ArrayBuffer })
    ctx.server.emit('message', { data: new TextEncoder().encode('BBB').buffer as ArrayBuffer })
    ctx.server.emit('message', { data: new TextEncoder().encode('CCC').buffer as ArrayBuffer })

    const dial = collectingDial()
    ctx.releaseDial(dial.result)
    await new Promise((r) => setTimeout(r, 10))

    const text = new TextDecoder().decode(
      Buffer.concat(dial.written().map((c) => Buffer.from(c)))
    )
    expect(text).toBe('AAABBBCCC')
  })

  it('拨号完成后到达的帧走 pumpUp 正常写入', async () => {
    const ctx = setup()
    await handleWebSocket(request, 'vless', config, [])

    ctx.server.emit('message', { data: buildVlessHeader('example.com', 80).buffer as ArrayBuffer })
    await new Promise((r) => setTimeout(r, 5))
    const dial = collectingDial()
    ctx.releaseDial(dial.result)
    await new Promise((r) => setTimeout(r, 10))

    // 拨号已完成：此帧应直接写入
    ctx.server.emit('message', { data: new TextEncoder().encode('AFTER').buffer as ArrayBuffer })
    await new Promise((r) => setTimeout(r, 10))

    const text = new TextDecoder().decode(
      Buffer.concat(dial.written().map((c) => Buffer.from(c)))
    )
    expect(text).toBe('AFTER')
  })
})
