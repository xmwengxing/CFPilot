import { describe, expect, it, vi, beforeEach } from 'vitest'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleXhttp, parseXhttpRoute, isXhttpPath, clearXhttpSessions } = await import('../src/protocols/xhttp')
const { uuidToBytes } = await import('../src/protocols/vless')
const { vlessUri } = await import('../src/sub-engine')
const { DEFAULT_CONFIG } = await import('../src/config')

const UUID = '11111111-2222-3333-4444-555555555555'

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.byteLength }
  return out
}

function buildSeq0(payload: Uint8Array = new Uint8Array([1, 2, 3])): Uint8Array {
  const uuid = uuidToBytes(UUID)!
  return concat(
    new Uint8Array([0x00]), uuid, new Uint8Array([0]),
    new Uint8Array([0x01]), new Uint8Array([0x01, 0xbb]),
    new Uint8Array([0x02, 0x0b, ...new TextEncoder().encode('example.com')]),
    payload
  )
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
  return out
}

const baseConfig = {
  ...DEFAULT_CONFIG,
  uuid: UUID,
  xhttpPath: '/xhttp',
} as unknown as Parameters<typeof handleXhttp>[1]

function setupDial() {
  const written: Uint8Array[] = []
  const writer = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk.slice())
    },
  })
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([9, 9]))
      controller.close()
    },
  })
  dialMock.mockResolvedValue({
    readable,
    writable: writer,
    via: 'direct',
    endpoint: 'example.com:443',
    close: async () => {},
  })
  return { written }
}

describe('XHTTP 路径解析', () => {
  it('stream-one 接受带/不带尾部斜杠', () => {
    expect(parseXhttpRoute('/xhttp', '/xhttp')).toEqual({ kind: 'stream-one' })
    expect(parseXhttpRoute('/xhttp/', '/xhttp')).toEqual({ kind: 'stream-one' })
    expect(parseXhttpRoute('/xhttp/', '/xhttp/')).toEqual({ kind: 'stream-one' })
    expect(isXhttpPath('/xhttp/', '/xhttp')).toBe(true)
  })
  it('packet-up 与下行路径', () => {
    expect(parseXhttpRoute('/xhttp/sess-1/0', '/xhttp')).toEqual({ kind: 'packet-up', sessionId: 'sess-1', seq: 0 })
    expect(parseXhttpRoute('/xhttp/sess-1/12', '/xhttp')).toEqual({ kind: 'packet-up', sessionId: 'sess-1', seq: 12 })
    expect(parseXhttpRoute('/xhttp/sess-1', '/xhttp')).toEqual({ kind: 'session', sessionId: 'sess-1' })
  })
  it('前缀相近但非会话路径不匹配', () => {
    expect(parseXhttpRoute('/xhttp2', '/xhttp')).toBeNull()
    expect(parseXhttpRoute('/xhttp2/sess/0', '/xhttp')).toBeNull()
    expect(parseXhttpRoute('/other', '/xhttp')).toBeNull()
    expect(parseXhttpRoute('/xhttp/a/b/c', '/xhttp')).toBeNull()
    expect(parseXhttpRoute('/xhttp/a/notnum', '/xhttp')).toBeNull()
  })
  it('非 POST 的 stream-one 返回 null（中性页）', async () => {
    setupDial()
    const req = new Request('https://worker.test/xhttp/', { method: 'GET' })
    expect(await handleXhttp(req, baseConfig, [])).toBeNull()
  })
})

describe('XHTTP packet-up 端到端（mock 出站）', () => {
  beforeEach(() => {
    clearXhttpSessions()
    dialMock.mockReset()
  })

  it('上行分包 + 下行流可打通', async () => {
    const { written } = setupDial()
    // 1) 上行 seq 0（头 + 首包）
    const post0 = new Request('https://worker.test/xhttp/sess-e2e/0', {
      method: 'POST',
      body: Buffer.from(buildSeq0(new Uint8Array([7, 7, 7]))),
    })
    const res0 = await handleXhttp(post0, baseConfig, [])
    expect(res0).not.toBeNull()
    expect(res0!.status).toBe(200)
    expect(res0!.headers.get('Access-Control-Allow-Origin')).toBe('*')

    // 2) 上行 seq 1（续包）
    const post1 = new Request('https://worker.test/xhttp/sess-e2e/1', {
      method: 'POST',
      body: Buffer.from(new Uint8Array([8, 8])),
    })
    const res1 = await handleXhttp(post1, baseConfig, [])
    expect(res1!.status).toBe(200)

    // 3) 下行 GET
    const get = new Request('https://worker.test/xhttp/sess-e2e', { method: 'GET' })
    const resDown = (await handleXhttp(get, baseConfig, []))!
    expect(resDown.status).toBe(200)
    expect(resDown.headers.get('X-Accel-Buffering')).toBe('no')
    const body = await readAll(resDown.body!)
    expect(body[0]).toBe(0x00)
    expect(body[1]).toBe(0x00)
    expect(Array.from(body.subarray(2))).toEqual([9, 9])

    // 上行已按序写入出站
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0))
    const flat: number[] = []
    for (const c of written) flat.push(...Array.from(c))
    expect(flat).toEqual([7, 7, 7, 8, 8])
  })

  it('下行先到时等上行头到达后再下发', async () => {
    const { written } = setupDial()
    const get = new Request('https://worker.test/xhttp/sess-early', { method: 'GET' })
    const downPromise = handleXhttp(get, baseConfig, [])
    // 随后发上行
    const post0 = new Request('https://worker.test/xhttp/sess-early/0', {
      method: 'POST',
      body: Buffer.from(buildSeq0()),
    })
    expect((await handleXhttp(post0, baseConfig, []))!.status).toBe(200)
    const resDown = (await downPromise)!
    expect(resDown.status).toBe(200)
    const body = await readAll(resDown.body!)
    expect(Array.from(body.subarray(2))).toEqual([9, 9])
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0))
  })

  it('非法 VLESS 头返回 400', async () => {
    setupDial()
    const post = new Request('https://worker.test/xhttp/sess-bad/0', {
      method: 'POST',
      body: Buffer.from(new Uint8Array([0, 1, 2, 3])),
    })
    const res = (await handleXhttp(post, baseConfig, []))!
    expect(res.status).toBe(400)
    expect(dialMock).not.toHaveBeenCalled()
  })
})

describe('XHTTP 订阅链接', () => {
  it('使用 packet-up 且关闭 gRPC 头伪装', () => {
    const ctx = {
      nodes: [{ ip: '1.2.3.4', port: 443, remark: '', colo: '', latency: 0, speed: 0, source: 'official' as const }],
      config: { ...DEFAULT_CONFIG, uuid: UUID, xhttpPath: '/xhttp', clientFingerprint: 'chrome' },
      domain: 'example.pages.dev',
      port: 443,
      ports: [443],
      protocol: 'both' as const,
      transport: 'both' as const,
    }
    const uri = vlessUri(ctx.nodes[0]!, ctx, 'xhttp', 'test')
    const url = new URL(uri)
    expect(url.searchParams.get('type')).toBe('xhttp')
    expect(url.searchParams.get('mode')).toBe('packet-up')
    expect(url.searchParams.get('alpn')).toBe('h2')
    const extra = JSON.parse(url.searchParams.get('extra') ?? '{}') as Record<string, unknown>
    expect(extra.noGRPCHeader).toBe(true)
  })
})
