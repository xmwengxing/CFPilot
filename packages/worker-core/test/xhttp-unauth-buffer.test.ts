import { describe, expect, it, vi, beforeEach } from 'vitest'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleXhttp, clearXhttpSessions } = await import('../src/protocols/xhttp')
const { DEFAULT_CONFIG } = await import('../src/config')

const UUID = '11111111-2222-3333-4444-555555555555'

const baseConfig = {
  ...DEFAULT_CONFIG,
  uuid: UUID,
  xhttpPath: '/xhttp',
} as unknown as Parameters<typeof handleXhttp>[1]

function postChunk(sessionId: string, seq: number, body: Uint8Array): Request {
  return new Request(`https://example.com/xhttp/${sessionId}/${seq}`, {
    method: 'POST',
    body: body as unknown as BodyInit,
  })
}

describe('XHTTP packet-up 的 isolate 级暂存预算', () => {
  beforeEach(() => {
    clearXhttpSessions()
  })

  it('未鉴权的分包不能无限占用 isolate 内存（超预算必须被拒）', async () => {
    // seq >= 1 不需要 VLESS 头 —— 任何人都能塞字节。
    // 单包上限 10MB，isolate 总预算 32MB ⇒ 第 4 个 10MB 包必须被拒。
    const chunk = new Uint8Array(10 * 1024 * 1024)
    for (const id of ['s1', 's2', 's3']) {
      const res = await handleXhttp(postChunk(id, 1, chunk), baseConfig, [])
      expect(res!.status).toBe(200)
    }
    // 第四个必然超 32MB 总预算
    const over = await handleXhttp(postChunk('s4', 1, chunk), baseConfig, [])
    expect(over!.status).toBe(503)
  })

  it('会话关闭后额度归还，新会话不会被永久拒绝', async () => {
    const chunk = new Uint8Array(10 * 1024 * 1024)
    for (const id of ['a', 'b', 'c']) {
      await handleXhttp(postChunk(id, 1, chunk), baseConfig, [])
    }
    // 第四个被拒（超预算）
    const rejected = await handleXhttp(postChunk('d', 1, chunk), baseConfig, [])
    expect(rejected!.status).toBe(503)
    // 清掉会话（额度归还）后再来一次就能过
    clearXhttpSessions()
    const ok = await handleXhttp(postChunk('e', 1, chunk), baseConfig, [])
    expect(ok!.status).toBe(200)
  })

  it('Content-Length 超限的包在读 body 之前就被拒（不分配内存）', async () => {
    const req = new Request('https://example.com/xhttp/x/1', {
      method: 'POST',
      body: new Uint8Array(1024),
      headers: { 'content-length': String(50 * 1024 * 1024) },
    })
    const res = await handleXhttp(req, baseConfig, [])
    expect(res!.status).toBe(413)
  })

  it('seq=0 的分包在 VLESS 头非法时被拒绝（这条路径有鉴权）', async () => {
    const res = await handleXhttp(postChunk('randomsession2', 0, new Uint8Array([1, 2, 3])), baseConfig, [])
    expect(res).not.toBeNull()
    expect(res!.status).toBe(400)
  })
})
