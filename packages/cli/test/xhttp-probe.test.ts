import { describe, expect, it, vi, beforeEach } from 'vitest'

const connectMock = vi.hoisted(() => vi.fn())
vi.mock('node:http2', () => ({ connect: connectMock }))

const { probeXhttpEndpoint, verifyXhttpTunnel, randomXhttpSession } = await import('../src/scan/true-probe')

function fakeReq(status: number, bodyChunks: Buffer[] = []) {
  const handlers = new Map<string, Array<(...args: never[]) => void>>()
  return {
    on(event: string, cb: (...args: never[]) => void) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(cb)
    },
    emit(event: string, ...args: never[]) {
      for (const cb of handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args)
    },
    end() {
      // 下一tick触发 response
      queueMicrotask(() => {
        this.emit('response', { ':status': status, 'cf-ray': 'abc-SJC' } as never)
        for (const c of bodyChunks) this.emit('data', c as never)
      })
    },
    destroy() {},
    get destroyed() { return false },
    get closed() { return false },
  }
}

function fakeClient(req: unknown) {
  return {
    on() {},
    request() { return req as never },
    close() {},
    destroy() {},
  }
}

describe('XHTTP 探针（mock H2）', () => {
  beforeEach(() => {
    connectMock.mockReset()
  })

  it('randomSession 非空且唯一', () => {
    const a = randomXhttpSession()
    const b = randomXhttpSession()
    expect(a.startsWith('sess-')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('端点 400 判 OK 并带 colo', async () => {
    connectMock.mockReturnValue(fakeClient(fakeReq(400)))
    const r = await probeXhttpEndpoint('1.2.3.4', 443, 'example.pages.dev', '/xhttp', 2000)
    expect(r.ok).toBe(true)
    expect(r.status).toBe(400)
    expect(r.colo).toBe('SJC')
  })

  it('端点 403 判失败', async () => {
    connectMock.mockReturnValue(fakeClient(fakeReq(403)))
    const r = await probeXhttpEndpoint('1.2.3.4', 443, 'example.pages.dev', '/xhttp', 2000)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('403')
  })

  it('端点 200 中性页判失败', async () => {
    connectMock.mockReturnValue(fakeClient(fakeReq(200)))
    const r = await probeXhttpEndpoint('1.2.3.4', 443, 'example.pages.dev', '/xhttp', 2000)
    expect(r.ok).toBe(false)
  })

  it('真隧道：VLESS 头后有回包判 OK', async () => {
    const vlessRes = Buffer.concat([Buffer.from([0, 0]), Buffer.from('HTTP/1.1 200 OK\r\n\r\nhello')])
    connectMock.mockImplementation((_url: string, _opts: unknown) => {
      const upReq = fakeReq(200)
      const downReq = fakeReq(200, [vlessRes])
      let call = 0
      return {
        on() {},
        request(headers: Record<string, string>) {
          call++
          return (headers[':method'] === 'POST' ? upReq : downReq) as never
        },
        close() {},
        destroy() {},
      }
    })
    const r = await verifyXhttpTunnel({
      ip: '1.2.3.4', port: 443, host: 'example.pages.dev', xhttpPath: '/xhttp',
      uuid: '11111111-2222-3333-4444-555555555555', targetHost: 'baidu.com', targetPort: 80,
    })
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('data')
  })

  it('真隧道：缺 uuid 直接失败', async () => {
    const r = await verifyXhttpTunnel({ ip: '1.2.3.4', port: 443, host: 'h', xhttpPath: '/xhttp' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('缺少 uuid')
  })
})
