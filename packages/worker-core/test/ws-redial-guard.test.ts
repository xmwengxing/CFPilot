/**
 * 故障切换护栏与零字节首包超时 —— 回归测试。
 *
 * 守护三件事：
 *
 * 1. WS 建立后一个字节都不发时，8 秒内必须关闭（原先完全没有这个定时器）；
 * 2. 上游秒级 EOF/Reset、已发上行但 0 下行时，不能按 `close 1000 done` 收尸，
 *    必须触发反代重拨（真机采样 6 个目标里命中 2 个）；
 * 3. 用户显式指定了出口（落地代理 / ProxyIP）时，自动重拨必须被护栏挡住，
 *    否则会静默绕过用户指定的出口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const dialMock = vi.hoisted(() => vi.fn())
const relayMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))
vi.mock('../src/outbound/relay', () => ({ collectRelayEndpoints: relayMock }))

const { handleWebSocket } = await import('../src/protocols/websocket-self')

const UUID = '11111111-2222-3333-4444-555555555555'
const PASSWORD = 'trojan-pass-guard'

class FakeWebSocket {
  sent: Uint8Array[] = []
  closed: { code: number; reason: string } | null = null
  binaryType = ''
  private listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {}
  accept(): void {}
  send(bytes: Uint8Array): void { this.sent.push(bytes) }
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
  constructor() { super(); lastPair = this }
}

/** 上游立即 EOF 的 DialResult 桩（readable 建好就 close） */
function eofDialResult(via: 'direct' | 'socks5' = 'direct') {
  const chunks: Uint8Array[] = []
  return {
    result: {
      readable: new ReadableStream<Uint8Array>({ start(c) { c.close() } }),
      writable: new WritableStream<Uint8Array>({ write: (c) => void chunks.push(c) }),
      via,
      endpoint: '203.0.113.1:443',
      close: vi.fn(),
    },
    written: () => chunks,
  }
}

/** 先给一帧下行、再正常结束的 DialResult 桩 */
function dataThenEofDialResult() {
  return {
    result: {
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]))
          c.close()
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      via: 'direct',
      endpoint: '203.0.113.1:443',
      close: vi.fn(),
    },
  }
}

function buildTrojanHeader(hostname: string, port: number): Uint8Array {
  const digest = createHash('sha224').update(PASSWORD).digest('hex')
  const name = new TextEncoder().encode(hostname)
  return new Uint8Array([
    ...new TextEncoder().encode(`${digest}\r\n`),
    0x01, 0x03, name.length, ...name,
    (port >> 8) & 0xff, port & 0xff,
    ...new TextEncoder().encode('\r\n'),
  ])
}

/** 协议头 + 3 字节负载（保证 retainedBytes > 0） */
function firstMessage(): Uint8Array {
  const header = buildTrojanHeader('example.com', 443)
  const out = new Uint8Array(header.byteLength + 3)
  out.set(header, 0)
  out.set([1, 2, 3], header.byteLength)
  return out
}

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

const baseConfig = {
  uuid: UUID,
  trojanPassword: PASSWORD,
  enableTrojan: true,
  wsPath: '/t',
  trojanPath: '/trojan',
  concurrentDial: 1,
  resolvePreferred: false,
  aggressiveRedial: false,
} as unknown as Parameters<typeof handleWebSocket>[2]

const ctxStub = { waitUntil: (_p: Promise<unknown>): void => {} }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  dialMock.mockReset()
  relayMock.mockReset()
  relayMock.mockResolvedValue([{ ip: '198.51.100.1', port: 443, label: 'test' }])
  lastPair = null
  ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingWebSocketPair
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('零字节首包超时', () => {
  it('连上 WS 却一个字节都不发 → 8 秒后 close 1008', async () => {
    vi.useFakeTimers()
    dialMock.mockReturnValue(Promise.resolve(eofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    expect(server.closed).toBeNull()

    await vi.advanceTimersByTimeAsync(8000)
    expect(server.closed?.code).toBe(1008)
    expect(server.closed?.reason).toContain('首包超时')
    // 没有协议头，根本不该发起出站
    expect(dialMock).not.toHaveBeenCalled()
  })

  it('收到首字节后不再触发首包超时', async () => {
    vi.useFakeTimers()
    dialMock.mockReturnValue(Promise.resolve(eofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()

    await vi.advanceTimersByTimeAsync(8000)
    // 会话可以正常结束，但关闭原因不能是首包超时
    expect(server.closed?.reason ?? '').not.toContain('首包超时')
  })
})

describe('正常结束的出口判据', () => {
  it('收到下行后正常结束 → close reason 带 via 与 endpoint', async () => {
    dialMock.mockReturnValue(Promise.resolve(dataThenEofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(server.closed?.code).toBe(1000)
    expect(server.closed?.reason).toContain('via=direct')
    expect(server.closed?.reason).toContain('ep=203.0.113.1:443')
    // 收到过响应就不该重拨
    expect(dialMock).toHaveBeenCalledTimes(1)
  })
})

describe('秒级 EOF 与重拨护栏', () => {
  it('0 下行 + 已发上行 → 立即重拨到反代入口，而不是 close 1000 done', async () => {
    dialMock.mockReturnValue(Promise.resolve(eofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    // 让 pumpDown 的 read()/finally 与重拨里的 await 都跑完
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(dialMock).toHaveBeenCalledTimes(2)
    // 第二次拨号的目标是反代入口，不是原始目标
    expect(dialMock.mock.calls[1]![0].hostname).toBe('198.51.100.1')
    expect(server.closed?.reason ?? '').not.toContain('done')
  })

  it('用户配了落地代理 → 护栏拦截，不再拨第二次，明确 close 1011', async () => {
    dialMock.mockReturnValue(Promise.resolve(eofDialResult('socks5').result))
    const proxy = { kind: 'socks5', host: '10.0.0.1', port: 1080 } as unknown as Parameters<typeof handleWebSocket>[3][number]

    await handleWebSocket(request, 'trojan', baseConfig, [proxy], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(dialMock).toHaveBeenCalledTimes(1)
    expect(server.closed?.code).toBe(1011)
    expect(server.closed?.reason).toContain('出口')
  })

  it('用户配了 ProxyIP（via 仍是 direct）→ 靠配置信号兜住', async () => {
    dialMock.mockReturnValue(Promise.resolve(eofDialResult('direct').result))
    const config = { ...baseConfig, proxyIp: '104.16.0.9' } as unknown as Parameters<typeof handleWebSocket>[2]

    await handleWebSocket(request, 'trojan', config, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(dialMock).toHaveBeenCalledTimes(1)
    expect(server.closed?.code).toBe(1011)
    expect(server.closed?.reason).toContain('ProxyIP')
  })

  it('激进模式放开护栏，仍会重拨', async () => {
    dialMock.mockReturnValue(Promise.resolve(eofDialResult('socks5').result))
    const config = { ...baseConfig, aggressiveRedial: true } as unknown as Parameters<typeof handleWebSocket>[2]
    const proxy = { kind: 'socks5', host: '10.0.0.1', port: 1080 } as unknown as Parameters<typeof handleWebSocket>[3][number]

    await handleWebSocket(request, 'trojan', config, [proxy], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(dialMock).toHaveBeenCalledTimes(2)
  })
})
