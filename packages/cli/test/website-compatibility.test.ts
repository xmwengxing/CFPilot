import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as net from 'node:net'
import { once } from 'node:events'
import type * as Https from 'node:https'
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('node:https', async (original) => ({ ...await original<typeof Https>(), request: requestMock }))
import { probeWebsite, probeWebsites, WEBSITE_MAX_BYTES } from '../src/experimental/website-compatibility'

const target = { label: '测试站点', url: 'https://site.example.com/check?secret=hidden' }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
function response(options: { status?: number; headers?: Record<string, string | undefined>; chunks?: Buffer[]; hang?: boolean; errorCode?: string } = {}): void {
  requestMock.mockImplementation((_url: URL, _options: unknown, callback: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
    req.destroy = vi.fn()
    req.end = () => {
      if (options.errorCode) { req.emit('error', Object.assign(new Error('sensitive-token-must-not-leak'), { code: options.errorCode })); return }
      const stream = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string | undefined> }
      stream.statusCode = options.status ?? 200
      stream.headers = options.headers ?? { 'content-type': 'text/html' }
      callback(stream)
      if (options.hang) return
      for (const chunk of options.chunks ?? [Buffer.from('<html>ready</html>')]) stream.write(chunk)
      stream.end()
    }
    return req
  })
}

describe('网站兼容性状态判定', () => {
  it('2xx默认成功，输出字段可嵌入报告，URL去除query', async () => {
    response()
    const result = await probeWebsite(target)
    expect(result).toMatchObject({ label: target.label, url: 'https://site.example.com/check', status: 'ok', httpStatus: 200, challengeHeader: false, transport: 'direct' })
    expect(result.ms).toBeGreaterThanOrEqual(0)
    expect(result.expectedContentOk).toBeUndefined()
    const [, options] = requestMock.mock.calls[0]!
    expect(options.headers).toEqual({ Accept: '*/*', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-store' })
    expect(options.method).toBe('GET')
    expect(options.maxHeaderSize).toBe(8192)
  })
  it.each([201, 204, 206])('接受成功状态 %i', async (status) => {
    response({ status }); expect((await probeWebsite(target)).status).toBe('ok')
  })
  it.each([{ status: 403, expected: 'forbidden' }, { status: 429, expected: 'rate_limited' }, { status: 500, expected: 'http_error' }, { status: 404, expected: 'http_error' }, { status: 302, expected: 'http_error' }])('独立分类HTTP $status', async ({ status, expected }) => {
    response({ status }); expect((await probeWebsite(target)).status).toBe(expected)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
  it('明确挑战头优先于403', async () => {
    response({ status: 403, headers: { 'cf-mitigated': 'challenge' } })
    expect(await probeWebsite(target)).toMatchObject({ status: 'challenge', challengeHeader: true, httpStatus: 403 })
  })
  it('只匹配准确挑战头，不将相似字段识别为挑战', async () => {
    response({ headers: { 'cf-mitigated': 'not-challenge' } })
    expect((await probeWebsite(target)).status).toBe('ok')
  })
  it('识别明确挑战脚本，不把普通challenge单词视为挑战', async () => {
    response({ chunks: [Buffer.from('<script src="/cdn-cgi/challenge-platform/h/g/orchestrate"></script>')] })
    expect(await probeWebsite(target)).toMatchObject({ status: 'challenge', challengeHeader: false })
    response({ chunks: [Buffer.from('<p>A challenge for developers</p>')] })
    expect((await probeWebsite(target)).status).toBe('ok')
  })
  it('正文显式匹配支持分片及UTF8', async () => {
    const body = Buffer.from('准备就绪 ready')
    response({ chunks: [body.subarray(0, 2), body.subarray(2)] })
    expect(await probeWebsite({ ...target, expectedText: '准备就绪' })).toMatchObject({ status: 'ok', expectedContentOk: true })
  })
  it('未匹配标记与非法UTF8属于invalid_response', async () => {
    response()
    expect(await probeWebsite({ ...target, expectedText: 'not-found' })).toMatchObject({ status: 'invalid_response', expectedContentOk: false })
    response({ chunks: [Buffer.from([0xff])] })
    expect(await probeWebsite({ ...target, expectedText: 'ready' })).toMatchObject({ status: 'invalid_response', expectedContentOk: false })
  })
  it('未配置正文条件时允许二进制内容，不强制JSON', async () => {
    response({ headers: { 'content-type': 'application/octet-stream' }, chunks: [Buffer.from([0xff, 0xfe])] })
    expect((await probeWebsite(target)).status).toBe('ok')
  })
})

describe('网站检测安全预算', () => {
  it.each(['http://site.example.com/', 'https://user:pass@site.example.com/', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.1/', 'https://2130706433/', 'https://service.local/', 'https://site.example.com/#secret', 'https://site.example.com:0/'])('拒绝不安全URL %s', async (url) => {
    expect(await probeWebsite({ ...target, url })).toMatchObject({ status: 'invalid_response', httpStatus: 0 })
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['https://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'https://site.example.com/'])('允许公网目标 %s', async (url) => {
    response(); expect((await probeWebsite({ ...target, url })).status).toBe('ok')
  })
  it.each(['http://127.0.0.1:8080', 'socks5://127.0.0.1:0', 'socks5://127.0.0.1:1080/path'])('无效代理不回退 %s', async (proxy) => {
    expect((await probeWebsite(target, { proxy })).status).toBe('invalid_response')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('拒绝压缩，不尝试解压', async () => {
    response({ headers: { 'content-encoding': 'gzip' } })
    expect((await probeWebsite(target)).status).toBe('invalid_response')
  })
  it('16 KiB边界成功，声明或实际超限失败', async () => {
    response({ chunks: [Buffer.alloc(WEBSITE_MAX_BYTES, 65)] })
    expect((await probeWebsite(target)).status).toBe('ok')
    response({ headers: { 'content-length': String(WEBSITE_MAX_BYTES + 1) } })
    expect((await probeWebsite(target)).status).toBe('invalid_response')
    response({ chunks: [Buffer.alloc(8192), Buffer.alloc(8193)] })
    expect((await probeWebsite(target)).status).toBe('invalid_response')
  })
  it('总超时覆盖持续无结束响应', async () => {
    vi.useFakeTimers(); response({ hang: true })
    const pending = probeWebsite(target, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).status).toBe('timeout')
  })
  it.each(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'])('TLS错误分类且不泄露异常 %s', async (errorCode) => {
    response({ errorCode })
    const result = await probeWebsite(target)
    expect(result.status).toBe('tls_error')
    expect(JSON.stringify(result)).not.toContain('sensitive-token')
    expect(JSON.stringify(result)).not.toContain('hidden')
  })
  it('普通传输错误与TLS错误分开', async () => {
    response({ errorCode: 'ECONNREFUSED' })
    expect((await probeWebsite(target)).status).toBe('http_error')
  })
  it('SOCKS5拒绝时不发送直连备用请求', async () => {
    const server = net.createServer((socket) => socket.once('data', () => socket.end(Buffer.from([5, 255]))))
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address() as net.AddressInfo
    requestMock.mockImplementation((_url: URL, options: { agent: Https.Agent }) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
      req.destroy = vi.fn()
      req.end = () => { options.agent.createConnection({}, () => undefined) }
      return req
    })
    try {
      const result = await probeWebsite(target, { proxy: `socks5://127.0.0.1:${address.port}` })
      expect(result).toMatchObject({ status: 'http_error', transport: 'socks5', httpStatus: 0 })
      expect(requestMock).toHaveBeenCalledTimes(1)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  it('有界列表串行按原顺序返回，不合并或重排目标', async () => {
    response()
    const results = await probeWebsites({ targets: [target, { label: 'second', url: 'https://second.example.com/' }] })
    expect(results.map((result) => result.label)).toEqual([target.label, 'second'])
    expect(results.every((result) => result.status === 'ok')).toBe(true)
  })
  it('拒绝空列表、重复标签和超过10个目标', async () => {
    await expect(probeWebsites({ targets: [] })).rejects.toThrow('1–10')
    await expect(probeWebsites({ targets: [target, target] })).rejects.toThrow('1–10')
    await expect(probeWebsites({ targets: Array.from({ length: 11 }, (_, i) => ({ ...target, label: String(i) })) })).rejects.toThrow('1–10')
    expect(requestMock).not.toHaveBeenCalled()
  })
})
