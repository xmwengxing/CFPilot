/**
 * 单连接流量熔断的关闭码 —— 回归测试。
 *
 * 熔断发生时必须用 **1013（Try Again Later）**：
 * - 1013 = 「现在不行，稍后再来」→ 客户端/浏览器按可重连续传处理；
 * - 1009 = 「消息过大」→ 客户端会当成协议错误，可能直接判节点不可用。
 *
 * 内存类熔断（缓冲/积压超限）仍用 1009，那是真的单帧太大，语义不能混。
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleWebSocket } = await import('../src/protocols/websocket-self')

const TROJAN_PASSWORD = 'trojan-pass-budget'

class FakeWebSocket {
  closed: { code: number; reason: string } | null = null
  binaryType = ''
  private listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {}
  accept(): void {}
  send(): void {}
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

let lastPair: { client: FakeWebSocket; server: FakeWebSocket } | null = null
class RecordingWebSocketPair {
  client = new FakeWebSocket()
  server = new FakeWebSocket()
  constructor() {
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

/** 出站桩：readable 永不结束（模拟长连接），writable 直接吞掉写入 */
function makeDialResult() {
  return {
    readable: new ReadableStream<Uint8Array>({ start() {} }),
    writable: new WritableStream<Uint8Array>({ write: () => undefined }),
    via: 'direct' as const,
    endpoint: '203.0.113.1:443',
    close: vi.fn(),
  }
}

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

/** 让事件循环把已排队的微任务跑完 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('单连接流量熔断的关闭码', () => {
  it('超过 dataBudgetMB 时用 1013 关闭（可重试语义，而不是 1009 协议错误）', async () => {
    dialMock.mockReset()
    dialMock.mockReturnValue(Promise.resolve(makeDialResult()))
    ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingWebSocketPair
    lastPair = null

    // 1MB 上限：先建连，再灌 1.5MB 触发熔断
    const config = {
      uuid: '11111111-2222-3333-4444-555555555555',
      trojanPassword: TROJAN_PASSWORD,
      enableTrojan: true,
      wsPath: '/t',
      trojanPath: '/trojan',
      concurrentDial: 1,
      resolvePreferred: false,
      dataBudgetMB: 1,
    } as unknown as Parameters<typeof handleWebSocket>[2]

    await handleWebSocket(request, 'trojan', config, [])
    const pair = lastPair as { server: FakeWebSocket } | null
    if (!pair) throw new Error('handleWebSocket 尚未创建 WebSocketPair')
    const server = pair

    // 协议头 → 触发拨号并建立出站
    server.server.emit('message', { data: buildTrojanHeader(TROJAN_PASSWORD, 'example.com', 443) })
    await flush()

    // 单帧 1.5MB：累计超 1MB → 熔断
    server.server.emit('message', { data: new Uint8Array(1_500_000) })
    await flush()

    expect(server.server.closed).not.toBeNull()
    expect(server.server.closed!.code).toBe(1013)
    expect(server.server.closed!.reason).toContain('流量')
  })
})
