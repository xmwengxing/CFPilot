import { describe, expect, it } from 'vitest'
import { ByteStream } from '../src/protocols/stream'
import { parseVless, uuidToBytes } from '../src/protocols/vless'
import { parseTrojan, trojanPasswordHash } from '../src/protocols/trojan'

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

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

const UUID = '11111111-2222-3333-4444-555555555555'

function buildVlessRequest(options: {
  uuid?: string
  command?: number
  port?: number
  address?: Uint8Array
  payload?: Uint8Array
}): Uint8Array {
  const uuid = uuidToBytes(options.uuid ?? UUID)!
  const command = options.command ?? 0x01
  const port = options.port ?? 443
  const address = options.address ?? new Uint8Array([0x02, 0x0b, ...new TextEncoder().encode('example.com')])
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff])
  return concat(
    new Uint8Array([0x00]),
    uuid,
    new Uint8Array([0x00]), // addons 长度
    new Uint8Array([command]),
    portBytes,
    address,
    options.payload ?? new Uint8Array(0)
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
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

describe('VLESS 解析', () => {
  it('解析域名目标与端口', async () => {
    const bytes = buildVlessRequest({ payload: new Uint8Array([1, 2, 3]) })
    const result = await parseVless(new ByteStream(streamOf(bytes)), UUID)
    expect(result).not.toBeNull()
    expect(result!.header.command).toBe(0x01)
    expect(result!.header.port).toBe(443)
    expect(result!.header.hostname).toBe('example.com')
    expect(result!.header.addressType).toBe(0x02)
    expect(await readAll(result!.payload)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('解析 IPv4 目标', async () => {
    const address = new Uint8Array([0x01, 1, 1, 1, 1])
    const bytes = buildVlessRequest({ address, port: 80 })
    const result = await parseVless(new ByteStream(streamOf(bytes)), UUID)
    expect(result!.header.hostname).toBe('1.1.1.1')
    expect(result!.header.port).toBe(80)
  })

  it('UUID 不匹配时拒绝', async () => {
    const bytes = buildVlessRequest({ uuid: '99999999-2222-3333-4444-555555555555' })
    const result = await parseVless(new ByteStream(streamOf(bytes)), UUID)
    expect(result).toBeNull()
  })

  it('数据不完整时拒绝', async () => {
    const bytes = buildVlessRequest({}).subarray(0, 10)
    const result = await parseVless(new ByteStream(streamOf(bytes)), UUID)
    expect(result).toBeNull()
  })
})

describe('Trojan 解析', () => {
  const PASSWORD = 'cfp-test-password'

  it('解析 SHA224 口令 + 域名目标', async () => {
    const hash = new TextEncoder().encode(trojanPasswordHash(PASSWORD))
    const address = new Uint8Array([0x03, 0x0b, ...new TextEncoder().encode('example.com')])
    const bytes = concat(
      hash,
      new Uint8Array([0x0d, 0x0a]),
      new Uint8Array([0x01]), // CONNECT
      address,
      new Uint8Array([0x01, 0xbb]), // 443
      new Uint8Array([0x0d, 0x0a]),
      new Uint8Array([9, 8, 7])
    )
    const result = await parseTrojan(new ByteStream(streamOf(bytes)), PASSWORD)
    expect(result).not.toBeNull()
    expect(result!.header.command).toBe(0x01)
    expect(result!.header.port).toBe(443)
    expect(result!.header.hostname).toBe('example.com')
    expect(await readAll(result!.payload)).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('口令错误时拒绝', async () => {
    const hash = new TextEncoder().encode(trojanPasswordHash('wrong-password'))
    const bytes = concat(hash, new Uint8Array([0x0d, 0x0a]))
    const result = await parseTrojan(new ByteStream(streamOf(bytes)), PASSWORD)
    expect(result).toBeNull()
  })

  it('兼容明文口令', async () => {
    const address = new Uint8Array([0x03, 0x0b, ...new TextEncoder().encode('example.com')])
    const bytes = concat(
      new TextEncoder().encode(PASSWORD),
      new Uint8Array([0x0d, 0x0a]),
      new Uint8Array([0x01]),
      address,
      new Uint8Array([0x01, 0xbb]),
      new Uint8Array([0x0d, 0x0a])
    )
    const result = await parseTrojan(new ByteStream(streamOf(bytes)), PASSWORD)
    expect(result).not.toBeNull()
    expect(result!.header.hostname).toBe('example.com')
  })
})
