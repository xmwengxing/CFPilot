import { describe, expect, it, vi } from 'vitest'

// 出站拨号与中继都被 mock，确保只验证 XHTTP 自身的协议行为。
const dialMock = vi.hoisted(() => vi.fn())

vi.mock('../src/outbound/dial', () => ({
  dial: dialMock,
}))

// relay 用真实管道实现：读 a 写 b，保证响应流能正常结束。
// 注意：XHTTP 的 writable 是 TransformStream 的写入端，mock 必须写入它，
// 否则下行数据不会出现在响应体里。
vi.mock('../src/budget', async () => {
  const actual = await vi.importActual<typeof import('../src/budget')>('../src/budget')
  return {
    ...actual,
    relay: async (
      a: ReadableStream<Uint8Array>,
      b: { write(c: Uint8Array): unknown; close(): unknown } | WritableStream<Uint8Array>
    ) => {
      const target =
        'getWriter' in b && typeof b.getWriter === 'function' ? b.getWriter() : (b as never)
      const reader = a.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) await target.write(value)
        }
      } catch {
        /* 测试用，忽略 */
      } finally {
        await target.close()
      }
    },
  }
})

const { handleXhttp } = await import('../src/protocols/xhttp')
const { ByteStream } = await import('../src/protocols/stream')
const { uuidToBytes } = await import('../src/protocols/vless')

const UUID = '11111111-2222-3333-4444-555555555555'

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

function buildVlessRequest(options: { payload?: Uint8Array; addons?: Uint8Array } = {}): Uint8Array {
  const uuid = uuidToBytes(UUID)!
  return concat(
    new Uint8Array([0x00]),
    uuid,
    new Uint8Array([options.addons?.byteLength ?? 0]),
    ...(options.addons ? [options.addons] : []),
    new Uint8Array([0x01]), // TCP
    new Uint8Array([0x01, 0xbb]), // 443
    new Uint8Array([0x02, 0x0b, ...new TextEncoder().encode('example.com')]),
    options.payload ?? new Uint8Array([1, 2, 3])
  )
}

/** 从响应流中读出全部字节 */
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
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const baseConfig = {
  uuid: UUID,
  nat64: '',
  concurrentDial: true,
} as unknown as Parameters<typeof handleXhttp>[1]

function setupDial() {
  const written: Uint8Array[] = []
  const writer = {
    write: async (chunk: Uint8Array) => {
      written.push(chunk)
    },
    close: async () => {},
  }
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
  })
  return { written, writer }
}

describe('XHTTP stream-one', () => {
  it('响应体首字节是 VLESS 协议响应头', async () => {
    setupDial()
    const request = new Request('https://worker.test/xhttp', {
      method: 'POST',
      body: Buffer.from(buildVlessRequest()),
    })

    const response = await handleXhttp(request, baseConfig, [])

    expect(response.status).toBe(200)
    const body = await readAll(response.body!)
    // 版本(1) + Addons 长度(1) + Addons(0) + 下行数据
    expect(body[0]).toBe(0x00)
    expect(body[1]).toBe(0x00)
    expect(Array.from(body.subarray(2))).toEqual([9, 9])
  })

  it('回显请求里的 Addons', async () => {
    setupDial()
    const request = new Request('https://worker.test/xhttp', {
      method: 'POST',
      body: Buffer.from(buildVlessRequest({ addons: new Uint8Array([0xde, 0xad]) })),
    })

    const response = await handleXhttp(request, baseConfig, [])
    const body = await readAll(response.body!)

    expect(body[0]).toBe(0x00)
    expect(body[1]).toBe(0x02)
    expect(Array.from(body.subarray(2, 4))).toEqual([0xde, 0xad])
    expect(Array.from(body.subarray(4))).toEqual([9, 9])
  })

  it('响应头包含流式所需的无缓冲标记', async () => {
    setupDial()
    const request = new Request('https://worker.test/xhttp', {
      method: 'POST',
      body: Buffer.from(buildVlessRequest()),
    })

    const response = await handleXhttp(request, baseConfig, [])

    expect(response.headers.get('X-Accel-Buffering')).toBe('no')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('上行负载在协议头之后被送到出站', async () => {
    const { written } = setupDial()
    const payload = new Uint8Array([7, 7, 7])
    const request = new Request('https://worker.test/xhttp', {
      method: 'POST',
      body: Buffer.from(buildVlessRequest({ payload })),
    })

    await handleXhttp(request, baseConfig, [])
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0))

    const flat = new Uint8Array(written.reduce((sum, c) => sum + c.byteLength, 0))
    let offset = 0
    for (const chunk of written) {
      flat.set(chunk, offset)
      offset += chunk.byteLength
    }
    expect(Array.from(flat)).toEqual([7, 7, 7])
  })
})
