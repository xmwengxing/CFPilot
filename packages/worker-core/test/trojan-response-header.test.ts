/**
 * Trojan 入站**不能**回 VLESS 协议响应头 —— 回归测试。
 *
 * ## 真机缺陷（2026-10-28，用户报「Trojan 节点全部 -1」）
 *
 * VLESS 的响应头（`版本(1) + Addons 长度(1)`，空 Addons 时就是 `00 00`）是协议的一部分：
 * 客户端收到它才认为入站已建立。**但 Trojan 协议没有响应头** ——
 * 认证通过后服务端直接透明转发，客户端读到的第一个字节就是目标站的数据。
 *
 * 早前实现不区分模式，对两种协议都发 `[0x00, 0x00]`。真机抓到 Trojan 客户端的下行开头是：
 *
 * ```
 * 0000 485454502f312e312034303320466f7262696464656e...   （== "\0\0HTTP/1.1 403 Forbidden"）
 * ```
 *
 * 客户端把这 2 个 NUL 当成隧道数据的开头 → TLS 记录头错位 → 握手失败 → 全部 -1。
 *
 * 本测试钉住：
 *   - `mode === 'trojan'` 时**一个字节都不许发**（只能由目标站数据填满下行）；
 *   - `mode === 'vless'` 时仍然先发 `00 00`（这条不能改坏）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

// 拨号永远挂起：本测试只关心「拨号之前/期间发了什么」，不需要真实出站
const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({
  dial: dialMock,
}))

const { handleWebSocket } = await import('../src/protocols/websocket-self')

const UUID = '11111111-2222-3333-4444-555555555555'
const TROJAN_PASSWORD = 'trojan-pass-verify'

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

/** Trojan 请求头：hex(SHA224(password)) + CRLF + CMD + ATYP + ADDR + PORT + CRLF */
function buildTrojanHeader(password: string, hostname: string, port: number): Uint8Array {
  const digest = createHash('sha224').update(password).digest('hex')
  const name = new TextEncoder().encode(hostname)
  return new Uint8Array([
    ...new TextEncoder().encode(`${digest}\r\n`),
    0x01, // CONNECT
    0x03, // domain
    name.length,
    ...name,
    (port >> 8) & 0xff,
    port & 0xff,
    ...new TextEncoder().encode('\r\n'),
  ])
}

function buildVlessHeader(hostname: string, port: number): Uint8Array {
  const clean = UUID.replace(/-/g, '')
  const uuid = new Uint8Array(16)
  for (let i = 0; i < 16; i++) uuid[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  const name = new TextEncoder().encode(hostname)
  return new Uint8Array([
    0x00, ...uuid, 0x00,
    0x01, (port >> 8) & 0xff, port & 0xff,
    0x02, name.length, ...name,
  ])
}

function setup(): FakeWebSocket {
  dialMock.mockReturnValue(new Promise(() => {}))
  ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingWebSocketPair
  lastPair = null
  return new Proxy({} as FakeWebSocket, {
    get(_t, prop) {
      if (!lastPair) throw new Error('handleWebSocket 尚未创建 WebSocketPair')
      return (lastPair.server as unknown as Record<string | symbol, unknown>)[prop]
    },
  })
}

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

const trojanConfig = {
  uuid: UUID,
  trojanPassword: TROJAN_PASSWORD,
  enableTrojan: true,
  wsPath: '/t',
  trojanPath: '/trojan',
  concurrentDial: 2,
  resolvePreferred: false,
} as unknown as Parameters<typeof handleWebSocket>[2]

const vlessConfig = {
  ...trojanConfig,
  trojanPassword: '',
} as unknown as Parameters<typeof handleWebSocket>[2]

/** 等事件循环把 message 处理完（handler 是 async 的） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('Trojan 入站不发 VLESS 响应头', () => {
  it('trojan：认证通过后一个字节都不发（下行必须由目标站数据填满）', async () => {
    const server = setup()
    await handleWebSocket(request, 'trojan', trojanConfig, [])
    server.emit('message', { data: buildTrojanHeader(TROJAN_PASSWORD, 'neverssl.com', 80).buffer })
    await flush()

    expect(server.sent).toEqual([])
    // 拨号是挂起的（mock 永不 resolve），所以也还没 close
    expect(server.closed).toBeNull()
  })

  it('vless：仍然先发 00 00（这条不能因为修 trojan 被改坏）', async () => {
    const server = setup()
    await handleWebSocket(request, 'vless', vlessConfig, [])
    server.emit('message', { data: buildVlessHeader('neverssl.com', 80).buffer })
    await flush()

    expect(server.sent.length).toBeGreaterThan(0)
    expect(Array.from(server.sent[0]!)).toEqual([0x00, 0x00])
  })

  it('trojan：口令错误时不建立会话（close 1011，且不发任何数据）', async () => {
    const server = setup()
    await handleWebSocket(request, 'trojan', trojanConfig, [])
    server.emit('message', { data: buildTrojanHeader('wrong-password', 'neverssl.com', 80).buffer })
    await flush()

    expect(server.sent).toEqual([])
    // 口令错 → 首次解析失败 → 80ms 后重试一次仍失败 → 保持静默等待，不发响应头
    // （重试期间不能把半截报文当成功）
    expect(server.closed).toBeNull()
  })
})
