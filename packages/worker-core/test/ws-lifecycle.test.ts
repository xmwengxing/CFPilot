/**
 * 数据面连接生命周期 —— 回归测试（2026-10-29，对标 cfnew 审计结论）。
 *
 * 守护三件事：
 *
 * 1. **握手截止时间**：协议头不完整 / 认证失败时，连接必须在 `HANDSHAKE_DEADLINE_MS`
 *    之后被**关闭**。
 *    早前实现是「解析失败就 return」——连接既不报错也不释放，
 *    一直占用 isolate 的 WebSocket 与出站资源，直到运行时自己超时。
 *    同时旧实现在每个 message 里都 `setTimeout` 且不清旧的，定时器会累积。
 *
 * 2. **幂等清理**：客户端断开 / 读错误 / 拨号超时都可能抢先触发清理，
 *    但底层 Socket 只能被关一次；`DialResult.close()` 必须被调用且只调用一次。
 *
 * 3. **分帧到达仍能成功**：截止时间不能误伤把协议头拆成多帧发的客户端
 *    （真实客户端常见：先发协议头，隔几毫秒再发首包）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleWebSocket } = await import('../src/protocols/websocket-self')

const UUID = '11111111-2222-3333-4444-555555555555'
const TROJAN_PASSWORD = 'trojan-pass-lifecycle'

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

class FakeWebSocketPair {
  client = new FakeWebSocket()
  server = new FakeWebSocket()
}

let lastPair: FakeWebSocketPair | null = null
class RecordingWebSocketPair extends FakeWebSocketPair {
  constructor() {
    super()
    lastPair = this
  }
}

function buildTrojanHeader(password: string, hostname: string, port: number): Uint8Array {
  const digest = createHash('sha224').update(password).digest('hex')
  const name = new TextEncoder().encode(hostname)
  return new Uint8Array([
    ...new TextEncoder().encode(`${digest}\r\n`),
    0x01,
    0x03,
    name.length,
    ...name,
    (port >> 8) & 0xff,
    port & 0xff,
    ...new TextEncoder().encode('\r\n'),
  ])
}

/** 收集写入内容的 DialResult 桩；readable 永不结束（模拟长连接） */
function makeDialResult(): {
  result: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; via: 'direct'; endpoint: string; close: () => void }
  written: () => Uint8Array[]
  closeSpy: ReturnType<typeof vi.fn>
} {
  const chunks: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({ write: (c) => void chunks.push(c) })
  const readable = new ReadableStream<Uint8Array>({ start() {} })
  const closeSpy = vi.fn()
  return {
    result: { readable, writable, via: 'direct', endpoint: '203.0.113.1:443', close: closeSpy },
    written: () => chunks,
    closeSpy,
  }
}

function setup(dialResult = makeDialResult()) {
  dialMock.mockReset()
  dialMock.mockReturnValue(Promise.resolve(dialResult.result))
  ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingWebSocketPair
  lastPair = null
  const holder = { server: null as FakeWebSocket | null }
  return {
    dialResult,
    get server(): FakeWebSocket {
      if (!lastPair) throw new Error('handleWebSocket 尚未创建 WebSocketPair')
      holder.server = lastPair.server
      return lastPair.server
    },
  }
}

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

const trojanConfig = {
  uuid: UUID,
  trojanPassword: TROJAN_PASSWORD,
  enableTrojan: true,
  wsPath: '/t',
  trojanPath: '/trojan',
  concurrentDial: 1,
  resolvePreferred: false,
} as unknown as Parameters<typeof handleWebSocket>[2]

/**
 * 让事件循环把已排队的微任务跑完。
 *
 * ⚠️ 不能用 setTimeout —— 前几个用例开着 fake timers，
 * 真实 setTimeout 会被拦下，整个用例就卡在这里超时。
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('握手截止时间', () => {
  it('协议头不完整 → 到点后关闭（不再静默挂起）', async () => {
    vi.useFakeTimers()
    try {
      const ctx = setup()
      await handleWebSocket(request, 'trojan', trojanConfig, [])
      const server = ctx.server

      // 只发半个协议头（够长、但凑不出完整的 Trojan 头）
      server.emit('message', { data: new Uint8Array(20).buffer })
      await vi.advanceTimersByTimeAsync(50)
      expect(server.closed).toBeNull()

      await vi.advanceTimersByTimeAsync(2500)
      await flush()
      expect(server.closed?.code).toBe(1008)
      // 握手没成功 → 从未建立出站连接，自然没有 socket 可关
      expect(dialMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('口令错误 → 到点后关闭，且不建立出站连接', async () => {
    vi.useFakeTimers()
    try {
      const ctx = setup()
      await handleWebSocket(request, 'trojan', trojanConfig, [])
      const server = ctx.server

      server.emit('message', { data: buildTrojanHeader('wrong-pass', 'neverssl.com', 80).buffer })
      await vi.advanceTimersByTimeAsync(2500)
      await flush()

      expect(dialMock).not.toHaveBeenCalled()
      expect(server.closed?.code).toBe(1008)
    } finally {
      vi.useRealTimers()
    }
  })

  it('截止前凑齐协议头 → 正常建连（不误伤分帧客户端）', async () => {
    vi.useFakeTimers()
    try {
      const ctx = setup()
      await handleWebSocket(request, 'trojan', trojanConfig, [])
      const server = ctx.server

      const header = buildTrojanHeader(TROJAN_PASSWORD, 'neverssl.com', 80)
      server.emit('message', { data: header.subarray(0, 30).buffer })
      await vi.advanceTimersByTimeAsync(500)
      server.emit('message', { data: header.slice(30).buffer })
      await vi.advanceTimersByTimeAsync(3000)
      await flush()

      expect(dialMock).toHaveBeenCalledTimes(1)
      expect(server.closed?.code).not.toBe(1008)
    } finally {
      vi.useRealTimers()
    }
  })

  it('多个分片不会累积定时器：只关一次', async () => {
    vi.useFakeTimers()
    try {
      const ctx = setup()
      await handleWebSocket(request, 'trojan', trojanConfig, [])
      const server = ctx.server

      for (let i = 1; i <= 5; i++) {
        server.emit('message', { data: new Uint8Array(i).buffer })
        await vi.advanceTimersByTimeAsync(100)
      }
      await vi.advanceTimersByTimeAsync(3000)
      await flush()

      expect(server.closed?.code).toBe(1008)
      // 五个分片只应产生**一次**关闭（旧实现会累积出多个定时器）
      expect(dialMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('幂等清理', () => {
  it('客户端断开 + 后续重复事件 → 底层 Socket 只关一次', async () => {
    const ctx = setup()
    await handleWebSocket(request, 'trojan', trojanConfig, [])
    const server = ctx.server

    server.emit('message', { data: buildTrojanHeader(TROJAN_PASSWORD, 'neverssl.com', 80).buffer })
    await flush()
    expect(dialMock).toHaveBeenCalledTimes(1)

    server.emit('close', { data: null })
    server.emit('close', { data: null })
    server.emit('error', { data: null })
    await flush()

    expect(ctx.dialResult.closeSpy).toHaveBeenCalledTimes(1)
  })
})
