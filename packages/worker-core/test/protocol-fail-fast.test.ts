/**
 * 入站加固：消息顺序链、认证失败快速关闭、IPv6 文本口径。
 *
 * ## 守护的三个缺陷（2026-11-18 审计核实）
 *
 * 1. **消息顺序**：每条 message 各起一个 async 任务，Blob 分支要 await，
 *    ArrayBuffer 分支不用 —— 混发时后到的帧可能先完成归一化，TLS 分片乱序。
 * 2. **半包与认证失败不分**：错误 UUID / 口令也要白等 2 秒握手截止，
 *    期间还允许对端继续灌最多 64KB。
 * 3. **IPv6 文本两种口径**：buffer 解析器输出未压缩 `2001:0db8:0:0:…`，
 *    而 `address.ts` 用 RFC 5952 压缩形式 —— 同一目标会得到两个不同的键。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleWebSocket } = await import('../src/protocols/websocket-self')
const { parseVlessBuffer } = await import('../src/protocols/vless')
const { uuidToBytes } = await import('../src/protocols/vless')

const UUID = '11111111-2222-3333-4444-555555555555'
const PASSWORD = 'trojan-pass-failfast'

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

class FakePair {
  client = new FakeWebSocket()
  server = new FakeWebSocket()
}

let lastPair: FakePair | null = null
class RecordingPair extends FakePair {
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

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

const trojanConfig = {
  uuid: UUID,
  trojanPassword: PASSWORD,
  enableTrojan: true,
  wsPath: '/t',
  trojanPath: '/trojan',
  concurrentDial: 1,
  resolvePreferred: false,
  aggressiveRedial: false,
  dialConnectMs: 5000,
  dialBudgetMs: 15000,
  dohBudgetMs: 1200,
  dialStallMs: 2500,
  relayRedialMax: 4,
} as unknown as Parameters<typeof handleWebSocket>[2]

const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

async function open(): Promise<FakeWebSocket> {
  ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingPair
  lastPair = null
  dialMock.mockImplementation(async () => ({
    readable: new ReadableStream<Uint8Array>({
      pull() {
        /* 永不产出 */
      },
    }),
    writable: new WritableStream<Uint8Array>(),
    via: 'direct' as const,
    endpoint: '203.0.113.20:443',
    close: vi.fn(),
  }))
  await handleWebSocket(request, 'trojan', trojanConfig, [], { waitUntil: () => {} })
  const pair = lastPair as FakePair | null
  if (!pair) throw new Error('WebSocketPair 未创建')
  return pair.server
}

beforeEach(() => {
  dialMock.mockReset()
})

describe('入站消息顺序链', () => {
  it('Blob 帧先到、ArrayBuffer 帧后到 → 仍按到达顺序拼出完整协议头', async () => {
    const server = await open()
    const header = buildTrojanHeader(PASSWORD, 'example.com', 443)
    const first = header.subarray(0, 40)
    const rest = header.subarray(40)

    // 手工控制 Blob 分支的 arrayBuffer() 何时完成（模拟 CF 运行时的异步转换）
    let releaseBlob: ((buf: ArrayBuffer) => void) | null = null
    const blobLike = {
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseBlob = resolve
        }),
    }

    server.emit('message', { data: blobLike })
    // 后到的 ArrayBuffer 帧不能越过先到的 Blob 帧
    // 必须用独立缓冲：`subarray().buffer` 是整个底层 buffer（70 字节），不是这 30 字节
    server.emit('message', { data: rest.slice().buffer })
    await flush()
    expect(dialMock).not.toHaveBeenCalled()

    releaseBlob!(first.slice().buffer)
    await flush()

    // 顺序正确 → 两段拼成完整头 → 建连
    expect(dialMock).toHaveBeenCalledTimes(1)
  })
})

describe('认证失败快速关闭', () => {
  it('口令错误（字节已够判凭据）→ 立即 1008，不等握手截止', async () => {
    const server = await open()
    server.emit('message', { data: buildTrojanHeader('wrong-pass', 'example.com', 443).buffer })
    await flush()

    expect(dialMock).not.toHaveBeenCalled()
    expect(server.closed?.code).toBe(1008)
    expect(server.closed?.reason).toContain('认证失败')
  })

  it('半包（字节不够判凭据）→ 不提前关闭，仍等握手截止', async () => {
    vi.useFakeTimers()
    try {
      const server = await open()
      server.emit('message', { data: new Uint8Array(20).buffer })
      await vi.advanceTimersByTimeAsync(50)
      expect(server.closed).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('IPv6 文本口径', () => {
  function vlessIpv6Header(groups: number[], port = 443): Uint8Array {
    const uuid = uuidToBytes(UUID)!
    const addr: number[] = []
    for (const g of groups) addr.push((g >> 8) & 0xff, g & 0xff)
    return new Uint8Array([
      0x00,
      ...uuid,
      0x00, // addons
      0x01, // TCP
      (port >> 8) & 0xff,
      port & 0xff,
      0x03, // IPv6
      ...addr,
      0x01, // 负载 1 字节
    ])
  }

  it('压缩形式与 address.ts 同口径（2001:db8::1）', () => {
    const parsed = parseVlessBuffer(vlessIpv6Header([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]), UUID)
    expect(parsed).not.toBeNull()
    expect(parsed!.header.hostname).toBe('2001:db8::1')
  })
})
