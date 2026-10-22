import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'node:http'
import type { UserConfig } from '../src/types'

// 出站拨号被 mock：只验证 WS 数据面自身的协议行为，不真的建连。
const dialMock = vi.hoisted(() => vi.fn())

vi.mock('../src/outbound/dial', () => ({
  dial: dialMock,
}))

const { handleWebSocket } = await import('../src/protocols/websocket')
const { uuidToBytes } = await import('../src/protocols/vless')
const { trojanPasswordHash } = await import('../src/protocols/trojan')

/**
 * workerd 的 WebSocketPair 在 Node 不存在。
 * 这里用 ws 库起一个本地服务器：把「服务端 socket」交给被测代码，
 * 测试侧用「客户端 socket」收发，形成真实双向通道。
 */
let wss: WebSocketServer
let httpServer: ReturnType<typeof createServer>
let pending: Array<(server: WebSocket) => void> = []

class TestWebSocketPair {
  constructor() {
    const resolvers: Array<(ws: WebSocket) => void> = []
    const clientReady = new Promise<WebSocket>((resolve) => resolvers.push(resolve))

    wss!.once('connection', (server) => {
      const resolve = resolvers.shift()
      resolve?.(server)
    })

    // 客户端连接触发上面的 connection 事件
    const client = new WebSocket(`ws://127.0.0.1:${port}/probe`)
    client.binaryType = 'arraybuffer'

    return [client, undefined] as unknown as [WebSocket, WebSocket]
  }
}

let port = 0

beforeAll(async () => {
  httpServer = createServer()
  wss = new WebSocketServer({ server: httpServer })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  port = typeof address === 'object' && address ? address.port : 0
  ;(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = TestWebSocketPair
})

afterAll(async () => {
  wss.close()
  httpServer.closeAllConnections?.()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

/**
 * 建立一对互通 socket，并把服务端 socket 交给被测的 handleWebSocket。
 * 因为 handleWebSocket 内部自己 new WebSocketPair()，这里采用「拦截」方式：
 * 先让被测代码拿到一个由 ws 服务端充当的 server socket。
 */
async function withPair(
  mode: 'vless' | 'trojan',
  run: (client: WebSocket) => Promise<void>
): Promise<{ messages: Uint8Array[]; closed: Array<{ code: number; reason: string }> }> {
  const serverReady = new Promise<WebSocket>((resolve) => pending.push(resolve))
  const clientReady = new Promise<WebSocket>((resolve) => {
    wss!.once('connection', (server) => resolve(server))
  })

  const client = new WebSocket(`ws://127.0.0.1:${port}/probe`)
  client.binaryType = 'arraybuffer'
  const server = await clientReady
  void serverReady
  // 必须等客户端真正 open，否则 cleanup 时 ws 会因「连接未建立」抛错
  await new Promise<void>((resolve) => {
    if (client.readyState === WebSocket.OPEN) resolve()
    else client.once('open', () => resolve())
  })

  const messages: Uint8Array[] = []
  const closed: Array<{ code: number; reason: string }> = []
  // 只收集「被测代码通过 server socket 发出」的消息。
  // ws 服务端的 'message' 是客户端→服务端方向，这里要反过来：
  // 用 server.send() 的发出去向无法直接监听，因此改为拦截 server.send。
  const originalSend = server.send.bind(server)
  ;(server as unknown as { send: (data: unknown, cb?: (err?: Error) => void) => void }).send = (
    data: unknown,
    cb?: (err?: Error) => void
  ) => {
    if (typeof data === 'string') messages.push(new TextEncoder().encode(data))
    else if (data instanceof Uint8Array) messages.push(data)
    else if (data instanceof ArrayBuffer) messages.push(new Uint8Array(data))
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView
      messages.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    }
    return originalSend(data as never, cb as never)
  }
  server.on('close', ((code: number, reason: unknown) => {
    closed.push({ code, reason: String(reason ?? '') })
  }) as never)

  // 直接调用内部逻辑：通过替换 WebSocketPair 的返回值来注入真实 server
  const originalPair = (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair
  // ws 的 socket 没有 workerd 的 accept()；这里补一个无害实现，
  // 因为 ws 服务端在建连时已经等同于 accepted。
  const serverAny = server as unknown as { accept?: (o?: unknown) => void }
  if (typeof serverAny.accept !== 'function') {
    serverAny.accept = () => {}
  }
  ;(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    constructor() {
      return [client, server] as unknown as [WebSocket, WebSocket]
    }
  }
  try {
    const request = new Request('https://worker.test/vless', { headers: { Upgrade: 'websocket' } })
    const response = await handleWebSocket(request, mode, config, [])
    // Node 的 Response 不接受 101；被测代码已做降级处理，两种状态都算通过
    expect([101, 200]).toContain(response.status)
    await run(client)
  } finally {
    ;(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = originalPair
    try {
      if (client.readyState === WebSocket.OPEN) client.close()
      else client.terminate()
    } catch {
      /* 已销毁 */
    }
  }

  await new Promise((r) => setTimeout(r, 60))
  return { messages, closed }
}

const UUID = '11111111-2222-3333-4444-555555555555'
const PASSWORD = 'cfp-ws-test-password'

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function buildVless(payload = new Uint8Array([1, 2, 3])): Uint8Array {
  return concat(
    new Uint8Array([0x00]),
    uuidToBytes(UUID)!,
    new Uint8Array([0x00]),
    new Uint8Array([0x01]),
    new Uint8Array([0x01, 0xbb]),
    new Uint8Array([0x02, 0x0b, ...new TextEncoder().encode('example.com')]),
    payload
  )
}

function buildTrojan(payload = new Uint8Array([4, 5, 6])): Uint8Array {
  const hash = new TextEncoder().encode(trojanPasswordHash(PASSWORD))
  return concat(
    hash,
    new Uint8Array([0x0d, 0x0a]),
    new Uint8Array([0x01]),
    new Uint8Array([0x03, 0x0b, ...new TextEncoder().encode('example.com')]),
    new Uint8Array([0x01, 0xbb]),
    new Uint8Array([0x0d, 0x0a]),
    payload
  )
}

function setupDial() {
  const written: Uint8Array[] = []
  const writer = {
    write: async (chunk: Uint8Array) => { written.push(chunk) },
    close: async () => {},
    getWriter: () => writer,
  }
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { controller.close() },
  })
  dialMock.mockResolvedValue({ readable, writable: writer, via: 'direct', endpoint: 'example.com:443' })
  return { written }
}

const config: UserConfig = {
  uuid: UUID,
  trojanPassword: PASSWORD,
  wsPath: '/vless',
  trojanPath: '/trojan',
  xhttpPath: '/xhttp',
  add: '', addApi: '', addCsv: '',
  poolOfficial: true, officialCount: 20, poolDomain: true, domainCount: 10, poolManual: false,
  poolCountries: '', dls: 0, maxLatency: 0, maxNodes: 0,
  proxyIp: '', socks5: '', httpProxy: '', nat64: '', concurrentDial: true,
  enableTrojan: true, enableXhttp: true, subDomain: '',
  subProtocol: 'vless', subTransport: 'ws',
  clientFingerprint: 'chrome', tlsFragment: false, tlsFragmentSize: '10-20', tlsFragmentDelay: '10-20',
}

describe('自研 WebSocket 数据面', () => {
  it('VLESS 101 后先回协议响应头', async () => {
    setupDial()
    const { messages } = await withPair('vless', async (client) => {
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocket.OPEN) resolve()
        else client.on('open', () => resolve())
      })
      client.send(buildVless())
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(Array.from(messages[0]!)).toEqual([0, 0])
  })

  it('协议头分帧到达时攒包后仍能建立连接', async () => {
    setupDial()
    const { messages } = await withPair('vless', async (client) => {
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocket.OPEN) resolve()
        else client.on('open', () => resolve())
      })
      const full = buildVless()
      client.send(full.slice(0, 10))
      await new Promise((r) => setTimeout(r, 40))
      client.send(full.slice(10))
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(Array.from(messages[0]!)).toEqual([0, 0])
  })

  it('Trojan 口令正确时建立连接并回响应头', async () => {
    setupDial()
    const { messages } = await withPair('trojan', async (client) => {
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocket.OPEN) resolve()
        else client.on('open', () => resolve())
      })
      client.send(buildTrojan())
      await new Promise((r) => setTimeout(r, 180))
    })
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(Array.from(messages[0]!)).toEqual([0, 0])
  })

  it('UUID 不匹配时关闭连接且不拨号', async () => {
    setupDial()
    dialMock.mockClear()
    const bad = buildVless()
    bad.set(new Uint8Array(16).fill(0xff), 1)
    const { closed } = await withPair('vless', async (client) => {
      await new Promise<void>((resolve) => {
        if (client.readyState === WebSocket.OPEN) resolve()
        else client.on('open', () => resolve())
      })
      client.send(bad)
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(dialMock).not.toHaveBeenCalled()
    expect(closed.length).toBeGreaterThanOrEqual(1)
  })
})
