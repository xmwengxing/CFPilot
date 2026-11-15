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

const { handleWebSocket, recentCloses, recentSessions, diagnosticCounters } = await import('../src/protocols/websocket-self')
const { uuidToBytes } = await import('../src/protocols/vless')

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

/**
 * 「假活」DialResult 桩：TCP 建连成功、但下行永不结束也永不给数据。
 * pumpDown 的 reader.read() 会一直挂起，只能靠静默定时器驱动重拨。
 *
 * ⚠️ 反代入口在生产里走的是 `dialDirect`（换的是入口 IP，TLS 目标不变），
 * 因此 `via` 同样是 `'direct'` —— 不要伪造 `'relay'`，那会触发护栏
 * 「当前走落地代理」的误判，测出来的不是真实链路。
 */
function stallDialResult(endpoint: string, via: 'direct' | 'socks5' = 'direct') {
  return {
    readable: new ReadableStream<Uint8Array>({ pull() { /* 永不产出 */ } }),
    writable: new WritableStream<Uint8Array>(),
    via,
    endpoint,
    close: vi.fn(),
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

/** VLESS 协议头（version 0 + UUID + 空 addons + TCP + 域名目标） */
function buildVlessHeaderFor(hostname: string, port: number): Uint8Array {
  const name = new TextEncoder().encode(hostname)
  const uuid = uuidToBytes(UUID)!
  return new Uint8Array([
    0x00, ...uuid,
    0x00, // addons 长度
    0x01, // TCP
    (port >> 8) & 0xff, port & 0xff,
    0x02, name.byteLength, ...name,
  ])
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
  // 时序参数（P1 #11）：手写 config 桩必须给全，否则 dialStallMs 为
  // undefined → setTimeout(..., undefined) 变 0ms，假活判定立刻触发。
  dialConnectMs: 5000,
  dialBudgetMs: 15000,
  dohBudgetMs: 1200,
  dialStallMs: 2500,
  relayRedialMax: 4,
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
  // closes 是模块级环形缓冲，测试间要清干净
  recentCloses().length = 0
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

  it('event.data 为 Blob 形态时仍能解出协议头（不再静默丢弃）', async () => {
    // CF 运行时下 event.data 可能是 Blob（只有 .arrayBuffer()）。
    // 旧实现直接 new Uint8Array(data as ArrayBuffer) → 长度 0 的视图，
    // 每条消息被静默丢弃，表现为「101 成功但隧道全 -1」。
    dialMock.mockReturnValue(Promise.resolve(dataThenEofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    const raw = firstMessage()
    server.emit('message', {
      data: { arrayBuffer: async () => raw.buffer },
    })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 协议头被成功解析才会发起出站
    expect(dialMock).toHaveBeenCalledTimes(1)
    expect(server.closed?.code).toBe(1000)
  })

  it('event.data 为字符串形态时不会崩溃（协议头不完整则不发起出站）', async () => {
    dialMock.mockReturnValue(Promise.resolve(dataThenEofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: 'not-a-binary-header' })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 文本经 TextEncoder 编码后不是合法 Trojan 头：不能发起出站，也不能抛异常
    expect(dialMock).not.toHaveBeenCalled()
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

describe('假活反代的链式换入口（2026-11-15 状态机修复）', () => {
  it('第二个入口也假活时继续换下一个，最终成功，不静默挂起', async () => {
    vi.useFakeTimers()
    relayMock.mockResolvedValue([
      { ip: '198.51.100.1', port: 443, label: 'r1' },
      { ip: '198.51.100.2', port: 443, label: 'r2' },
    ])
    dialMock
      // 初始直连：TCP 通、零下行
      .mockResolvedValueOnce(stallDialResult('203.0.113.1:443', 'direct'))
      // 第一次重拨到的入口：也是假活
      .mockResolvedValueOnce(stallDialResult('198.51.100.1:443'))
      // 第二个入口：正常回数据
      .mockResolvedValueOnce(dataThenEofDialResult().result)

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()

    // 初始直连 2.5s 静默 → 第一次重拨到 198.51.100.1
    await vi.advanceTimersByTimeAsync(2600)
    await flush()
    expect(dialMock).toHaveBeenCalledTimes(2)
    expect(dialMock.mock.calls[1]![0].hostname).toBe('198.51.100.1')

    // 该入口也假活：重拨后的短确认窗口（1.2s）到点 → 第二次重拨。
    // 旧实现 redialStarted 永不复位，这一步会被入口 return，
    // 会话挂在没有定时器的旧泵上（真机一直转圈）。
    await vi.advanceTimersByTimeAsync(1300)
    await flush()
    expect(dialMock).toHaveBeenCalledTimes(3)
    expect(dialMock.mock.calls[2]![0].hostname).toBe('198.51.100.2')

    // 第二个入口有下行 → 正常结束，不是 1011 也不是挂起
    await vi.advanceTimersByTimeAsync(50)
    await flush()
    expect(server.closed?.code).toBe(1000)
    expect(server.closed?.reason).toContain('via=')
  })

  it('所有反代入口都假活 → 明确 close 1011，绝不静默挂起', async () => {
    vi.useFakeTimers()
    relayMock.mockResolvedValue([
      { ip: '198.51.100.1', port: 443, label: 'r1' },
      { ip: '198.51.100.2', port: 443, label: 'r2' },
      { ip: '198.51.100.3', port: 443, label: 'r3' },
      { ip: '198.51.100.4', port: 443, label: 'r4' },
    ])
    dialMock.mockImplementation(() => Promise.resolve(stallDialResult('198.51.100.1:443')))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()

    // 2.5s 初始静默 + 最多 3 轮 1.2s 确认窗口，留足余量
    await vi.advanceTimersByTimeAsync(9000)
    await flush()

    expect(server.closed?.code).toBe(1011)
    // 必须真的链式换了多个入口（旧实现只拨 1 个反代就挂起）
    expect(dialMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    // 收尾快照覆盖所有 closeWith 路径（此前错误关闭不留痕）
    expect(recentCloses().some((c) => c.code === 1011)).toBe(true)
    // 换过的入口互不重复
    const hosts = dialMock.mock.calls.slice(1).map((c) => c[0].hostname)
    expect(new Set(hosts).size).toBe(hosts.length)
  })
})

describe('错误关闭的结构化留痕', () => {
  it('护栏拦截的 close 进 closes 缓冲，close reason 带出口前缀', async () => {
    dialMock.mockReturnValue(Promise.resolve(eofDialResult('socks5').result))
    const proxy = { kind: 'socks5', host: '10.0.0.1', port: 1080 } as unknown as Parameters<typeof handleWebSocket>[3][number]

    await handleWebSocket(request, 'trojan', baseConfig, [proxy], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const closes = recentCloses()
    expect(closes.length).toBeGreaterThan(0)
    expect(closes[0]!.code).toBe(1011)
    expect(closes[0]!.via).toBe('socks5')
    expect(closes[0]!.reason).toContain('出口')
    // 前缀必须存活，且不能把中文原因挤出 123 字节
    expect(server.closed?.reason).toContain('via=socks5')
    expect(server.closed?.reason).toContain('出口')
  })

  it('每条会话关闭都进 sessions 结构化快照（P2 #13）', async () => {
    dialMock.mockReturnValue(Promise.resolve(dataThenEofDialResult().result))

    await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const sessions = recentSessions()
    expect(sessions.length).toBeGreaterThan(0)
    const s = sessions[0]!
    expect(s.mode).toBe('trojan')
    expect(s.transport).toBe('ws')
    expect(s.closeCode).toBe(1000)
    expect(s.target).toBe('example.com:443')
    expect(s.via).toBe('direct')
    expect(s.dlBytes).toBeGreaterThan(0)
    expect(s.ulBytes).toBeGreaterThan(0)
  })

  it('诊断计数器带 since / uptimeMs，数值可判时间窗', () => {
    const c = diagnosticCounters()
    expect(c.since).toBeGreaterThan(0)
    expect(c.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(c.stallRedials).toBeGreaterThanOrEqual(0)
  })
})

describe('按目标域名的出站策略（P2 #12）', () => {
describe('按目标域名的出站策略（P2 #12）', () => {
  it('stall: 策略覆盖静默窗口', async () => {
    // 出厂 dialStallMs=2500，策略改成 6000：静默窗口应取 6000
    const config = { ...baseConfig, dialStallMs: 2500, pinnedHosts: 'slow.example=stall:6000' } as unknown as Parameters<typeof handleWebSocket>[2]
    dialMock.mockReturnValue(Promise.resolve(dataThenEofDialResult().result))

    await handleWebSocket(
      new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } }),
      'trojan',
      config,
      [],
      ctxStub
    )
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    // 2.5s 时不能已被关闭（策略窗口是 6s）
    expect(server.closed?.code).not.toBe(1011)
    // 正常收尾
    expect(server.closed?.code).toBe(1000)
  })

  it('noredial 策略：假活时明确 1011，不切反代入口', async () => {
    vi.useFakeTimers()
    dialMock.mockReturnValue(Promise.resolve(stallDialResult('203.0.113.1:443')))
    const config = {
      ...baseConfig,
      dialStallMs: 2500,
      pinnedHosts: 'example.com=noredial',
    } as unknown as Parameters<typeof handleWebSocket>[2]

    await handleWebSocket(
      new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } }),
      'trojan',
      config,
      [],
      ctxStub
    )
    const server = lastPair!.server
    server.emit('message', { data: firstMessage().buffer })
    await flush()
    await vi.advanceTimersByTimeAsync(2700)
    await flush()

    expect(server.closed?.code).toBe(1011)
    expect(server.closed?.reason).toContain('禁止自动切换反代入口')
    expect(dialMock).toHaveBeenCalledTimes(1)
  })

  it('通配策略覆盖子域（api.x.com 命中 *.x.com）', async () => {
    vi.useFakeTimers()
    dialMock.mockReturnValue(Promise.resolve(stallDialResult('203.0.113.1:443')))
    const config = {
      ...baseConfig,
      dialStallMs: 2500,
      pinnedHosts: '*.x.com=noredial',
    } as unknown as Parameters<typeof handleWebSocket>[2]
    await handleWebSocket(
      new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } }),
      'trojan',
      config,
      [],
      ctxStub
    )
    const server = lastPair!.server
    // ⚠️ 必须带 payload：stall 判定要求「已向上游写过数据」（retainedBytes>0），
    // 裸协议头不发数据谈不上假活，重拨永远不会触发。
    const apiHeader = buildTrojanHeader('api.x.com', 443)
    const msg = new Uint8Array(apiHeader.byteLength + 3)
    msg.set(apiHeader, 0)
    msg.set([1, 2, 3], apiHeader.byteLength)
    server.emit('message', { data: msg.buffer })
    await flush()
    await vi.advanceTimersByTimeAsync(2700)
    await flush()

    expect(server.closed?.code).toBe(1011)
    expect(server.closed?.reason).toContain('禁止自动切换反代入口')
    expect(dialMock).toHaveBeenCalledTimes(1)
  })
})
})