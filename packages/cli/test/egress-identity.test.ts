import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type * as Https from 'node:https'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('node:https', async (original) => ({ ...await original<typeof Https>(), request: requestMock }))
import { identifyEgress, isPublicIp, MAX_IDENTITY_BYTES, negotiateSocks, validateIdentityResponse } from '../src/experimental/egress-identity'

const now = Date.parse('2026-11-01T04:00:00Z')
const sample = { remote_ip: '8.8.8.8', observed_at: '2026-11-01T04:00:00Z', egress_kind: '用户代理', colo: 'HKG' }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function mockResponse(options: { status?: number; headers?: Record<string, string | undefined>; chunks?: Buffer[]; hang?: boolean } = {}): void {
  requestMock.mockImplementation((_url: URL, _options: unknown, callback: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
    req.destroy = vi.fn()
    req.end = () => {
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string | undefined> }
      response.statusCode = options.status ?? 200
      response.headers = options.headers ?? { 'content-type': 'application/json' }
      callback(response)
      if (options.hang) return
      for (const chunk of options.chunks ?? [Buffer.from(JSON.stringify({ ...sample, observed_at: new Date().toISOString() }))]) response.write(chunk)
      response.end()
    }
    return req
  })
}

describe('出口识别结果校验', () => {
  it.each(['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('接受公网地址 %s', (ip) => expect(isPublicIp(ip)).toBe(true))
  it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002::1', '3fff::1', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', 'example.com', '1.2.3.4:80'])('拒绝非公网字面量 %s', (ip) => expect(isPublicIp(ip)).toBe(false))
  it('只返回已声明字段并记录时间和年龄', () => {
    expect(validateIdentityResponse({ ...sample, secret: '不应输出' }, now + 1000)).toEqual({ remoteIp: '8.8.8.8', observedAt: '2026-11-01T04:00:00.000Z', fetchedAt: '2026-11-01T04:00:01.000Z', ageMs: 1000, egressKind: '用户代理', colo: 'HKG' })
  })
  it.each([null, [], {}, { ...sample, remote_ip: '127.0.0.1' }, { ...sample, observed_at: '2026-02-30T00:00:00Z' }, { ...sample, observed_at: '2026-11-01' }, { ...sample, observed_at: '2026-11-01T04:00:31Z' }, { ...sample, observed_at: '2026-11-01T03:54:59Z' }, { ...sample, colo: 'x\n危险' }, { ...sample, egress_kind: 3 }, { ...sample, colo: 'a'.repeat(129) }])('拒绝无效或陈旧响应 %#', (value) => expect(validateIdentityResponse(value, now)).toBeNull())
  it('接受时区偏移和未来容差边界', () => {
    expect(validateIdentityResponse({ ...sample, observed_at: '2026-11-01T12:00:30+08:00' }, now)?.ageMs).toBe(0)
  })
})

describe('出口识别 HTTP 边界', () => {
  it('GET 使用严格 TLS 路径，清除输出 query，不转发 XFF', async () => {
    mockResponse()
    const result = await identifyEgress({ url: 'https://identity.example.com/identify?secret=hidden' })
    expect(result).toMatchObject({ ok: true, observation: { transport: 'direct', sourceUrl: 'https://identity.example.com/identify' } })
    const [, options] = requestMock.mock.calls[0]!
    expect(options.method).toBe('GET')
    expect(options.headers['Accept-Encoding']).toBe('identity')
    expect(Object.keys(options.headers).some((key) => key.toLowerCase().includes('forwarded'))).toBe(false)
  })
  it('专用短期 token 仅通过请求头传输', async () => {
    mockResponse()
    const token = 'short-lived-secret-token'
    const result = await identifyEgress({ url: 'https://identity.example.com/', token, tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(requestMock.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${token}`)
    expect(JSON.stringify(result)).not.toContain(token)
  })
  it.each(['http://identity.example.com/', 'https://user:secret@identity.example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://0x7f000001/', 'https://service.local/', 'https://localhost/', 'https://identity.example.com/#secret'])('配置不合法时不发送请求 %s', async (url) => {
    expect(await identifyEgress({ url })).toMatchObject({ ok: false, code: 'config' })
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each([undefined, new Date(now).toISOString(), new Date(Date.now() + 600_000).toISOString()])('拒绝无过期时间或非短期 token %#', async (tokenExpiresAt) => {
    expect(await identifyEgress({ url: 'https://identity.example.com/', token: 'secret-token-is-long-enough', tokenExpiresAt })).toMatchObject({ ok: false, code: 'config' })
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['http://127.0.0.1:1080', 'socks5://127.0.0.1:0', 'socks5://127.0.0.1:65536', 'socks5://127.0.0.1:1080/path', 'socks5://127.0.0.1:1080?secret=x', `socks5://${'a'.repeat(256)}:password@127.0.0.1:1080`])('拒绝无效代理而不回退 %#', async (proxy) => {
    expect(await identifyEgress({ url: 'https://identity.example.com/', proxy })).toMatchObject({ ok: false, code: 'config' })
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('底层错误与认证失败不泄露敏感内容', async () => {
    const secret = 'secret-that-must-not-leak'
    requestMock.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
      req.destroy = vi.fn()
      req.end = () => req.emit('error', new Error(secret))
      return req
    })
    const result = await identifyEgress({ url: `https://identity.example.com/?token=${secret}`, token: secret, tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(result).toMatchObject({ ok: false, code: 'transport' })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it.each([301, 302, 401, 500])('拒绝 HTTP %i 且不跟随重定向', async (status) => {
    mockResponse({ status })
    expect(await identifyEgress({ url: 'https://identity.example.com/' })).toMatchObject({ ok: false, code: 'http' })
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
  it.each([{ 'content-type': 'text/html' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' }])('拒绝 HTML 与压缩响应 %#', async (headers) => {
    mockResponse({ headers })
    expect(await identifyEgress({ url: 'https://identity.example.com/' })).toMatchObject({ ok: false, code: 'response' })
  })
  it('拒绝声明超限和无长度流式超限', async () => {
    mockResponse({ headers: { 'content-type': 'application/json', 'content-length': String(MAX_IDENTITY_BYTES + 1) } })
    expect(await identifyEgress({ url: 'https://identity.example.com/' })).toMatchObject({ ok: false, code: 'size' })
    mockResponse({ chunks: [Buffer.alloc(8192), Buffer.alloc(8193)] })
    expect(await identifyEgress({ url: 'https://identity.example.com/' })).toMatchObject({ ok: false, code: 'size' })
  })
  it('完整聚合分块 JSON，16 KiB 边界可接受', async () => {
    const json = Buffer.from(JSON.stringify({ ...sample, observed_at: new Date().toISOString() }))
    const padded = Buffer.concat([json, Buffer.alloc(MAX_IDENTITY_BYTES - json.length, 32)])
    mockResponse({ chunks: [padded.subarray(0, 30), padded.subarray(30)] })
    expect(await identifyEgress({ url: 'https://identity.example.com/' })).toMatchObject({ ok: true })
  })
  it.each([Buffer.from('not json'), Buffer.from([0xff, 0xfe]), Buffer.from('{"remote_ip":"127.0.0.1"}')])('拒绝异常响应 %#', async (body) => {
    mockResponse({ chunks: [body] })
    expect(await identifyEgress({ url: 'https://identity.example.com/' })).toMatchObject({ ok: false, code: 'response' })
  })
  it('慢速响应受总超时限制', async () => {
    vi.useFakeTimers()
    mockResponse({ hang: true })
    const pending = identifyEgress({ url: 'https://identity.example.com/', timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' })
  })
})

describe('SOCKS5 指定路径握手', () => {
  it('支持分片握手和用户名密码，不在本机解析目标', async () => {
    const received: Buffer[] = []
    let stage = 0
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        if (stage === 0) { socket.write(Buffer.from([5])); socket.write(Buffer.from([2])); stage++ }
        else if (stage === 1) { socket.write(Buffer.from([1, 0])); stage++ }
        else { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage++ }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as net.AddressInfo
    const socket = net.connect(address.port, '127.0.0.1')
    try {
      await once(socket, 'connect')
      await negotiateSocks(socket, new URL(`socks5://name:password@127.0.0.1:${address.port}`), new URL('https://identity.example.com/'))
      expect(received[0]).toEqual(Buffer.from([5, 1, 2]))
      expect(received[1]?.toString()).toContain('password')
      expect(received[2]?.subarray(0, 5)).toEqual(Buffer.from([5, 1, 0, 3, 20]))
      expect(received[2]?.toString()).toContain('identity.example.com')
    } finally { socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  it.each([{ host: '8.8.8.8', type: 1 }, { host: '[2606:4700:4700::1111]', type: 4 }])('IP字面量使用正确地址类型 $type', async ({ host, type }) => {
    let connectType = 0
    const server = net.createServer((socket) => socket.once('data', () => {
      socket.write(Buffer.from([5, 0]))
      socket.once('data', (data) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
        connectType = bytes[3]!
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
      })
    }))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address() as net.AddressInfo
    const socket = net.connect(address.port, '127.0.0.1')
    try {
      await once(socket, 'connect')
      await negotiateSocks(socket, new URL(`socks5://127.0.0.1:${address.port}`), new URL(`https://${host}/`))
      expect(connectType).toBe(type)
    } finally { socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  it('代理拒绝时失败而不是直连回退', async () => {
    const server = net.createServer((socket) => socket.once('data', () => socket.end(Buffer.from([5, 255]))))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address() as net.AddressInfo
    const socket = net.connect(address.port, '127.0.0.1')
    try {
      await once(socket, 'connect')
      await expect(negotiateSocks(socket, new URL(`socks5://127.0.0.1:${address.port}`), new URL('https://identity.example.com/'))).rejects.toThrow('认证方式')
    } finally { socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
