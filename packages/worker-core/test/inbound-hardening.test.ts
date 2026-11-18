/**
 * 入站加固（第二批）：会话 id 上限、UDP 会话关闭、下行读错误留痕。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleXhttp, parseXhttpRoute } = await import('../src/protocols/xhttp')
const { handleWebSocket } = await import('../src/protocols/websocket-self')
const { DnsUdpSession } = await import('../src/protocols/udp-dns')
const { uuidToBytes } = await import('../src/protocols/vless')
const { DEFAULT_CONFIG } = await import('../src/config')

const UUID = '11111111-2222-3333-4444-555555555555'
const PASSWORD = 'trojan-pass-hardening'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

/* ------------------------------------------------------------------ */
/* XHTTP 会话 id                                                        */
/* ------------------------------------------------------------------ */

describe('XHTTP 会话 id 上限', () => {
  function parse(path: string) {
    return parseXhttpRoute(path, '/xhttp')
  }

  it('128 字符以内照常受理', () => {
    const id = 'a'.repeat(128)
    expect(parse(`/xhttp/${id}`)).toEqual({ kind: 'session', sessionId: id })
    expect(parse(`/xhttp/${id}/1`)).toEqual({ kind: 'packet-up', sessionId: id, seq: 1 })
  })

  it('超长 id 直接拒绝（不成为 isolate Map 的巨型键）', () => {
    const id = 'a'.repeat(129)
    expect(parse(`/xhttp/${id}`)).toBeNull()
    expect(parse(`/xhttp/${id}/1`)).toBeNull()
  })

  it('控制字符仍被拒绝', () => {
    expect(parse('/xhttp/a\u0001b')).toBeNull()
  })
})

describe('XHTTP 超长会话 id 不建立会话', () => {
  beforeEach(() => {
    dialMock.mockReset()
  })
  it('handleXhttp 对超长 id 返回 null（中性页）', async () => {
    const config = { ...DEFAULT_CONFIG, uuid: UUID } as unknown as Parameters<typeof handleXhttp>[1]
    const res = await handleXhttp(
      new Request(`https://worker.test/xhttp/${'a'.repeat(200)}`, { method: 'GET' }),
      config,
      []
    )
    expect(res).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* UDP DNS 会话关闭                                                      */
/* ------------------------------------------------------------------ */

describe('UDP-DNS 会话关闭', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('close 后在飞查询被 abort，且不再回写', async () => {
    let aborted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          })
      )
    )
    const sent: Uint8Array[] = []
    const session = new DnsUdpSession({ endpoint: 'https://dns.example/q', send: (b) => sent.push(b) })

    const packet = new Uint8Array(12)
    packet[0] = 0x12
    packet[1] = 0x34
    const frame = new Uint8Array(2 + packet.byteLength)
    frame[0] = 0
    frame[1] = packet.byteLength
    frame.set(packet, 2)
    session.push(frame)
    await flush()

    session.close()
    await flush()

    expect(aborted).toBe(true)
    expect(sent).toHaveLength(0)
    // 关闭后继续 push 不应再发起查询
    session.push(frame)
    await flush()
    expect(sent).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* WS 下行读错误                                                         */
/* ------------------------------------------------------------------ */

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

function buildTrojanHeader(hostname: string, port: number): Uint8Array {
  const digest = createHash('sha224').update(PASSWORD).digest('hex')
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

const config = {
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

describe('WS 下行读错误留痕', () => {
  beforeEach(() => {
    dialMock.mockReset()
  })

  it('上游读错误 → close reason 里带 err=（不再与正常 EOF 混淆）', async () => {
    dialMock.mockResolvedValue({
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error('upstream reset'))
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      via: 'direct',
      endpoint: '203.0.113.30:443',
      close: vi.fn(),
    })
    ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingPair
    lastPair = null
    await handleWebSocket(
      new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } }),
      'trojan',
      config,
      [],
      { waitUntil: () => {} }
    )
    const pair = lastPair as FakePair | null
    if (!pair) throw new Error('WebSocketPair 未创建')

    // 只发协议头、不带负载：retainedBytes 为 0，不会触发假活重拨分支
    pair.server.emit('message', { data: buildTrojanHeader('example.com', 80).buffer })
    await flush()

    expect(pair.server.closed?.code).toBe(1000)
    expect(pair.server.closed?.reason).toContain('err=')
    expect(pair.server.closed?.reason).toContain('upstream reset')
  })
})
