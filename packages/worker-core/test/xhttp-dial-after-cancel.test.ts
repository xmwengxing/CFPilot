/**
 * XHTTP packet-up：下行在拨号完成前被取消 → 刚建好的 Socket 必须被关闭。
 *
 * ## 守护的缺陷（2026-11-18 审计核实）
 *
 * `handleSessionDownlink` 在回完协议响应头后异步启动 `ensureDial`，但
 * `dialogPromise.then` 里**没有**检查 `cancelled` / `session.closed`：
 * 客户端取消 GET 后 `closeSession` 只关了当时已存在的 `session.dialResult`（还是 null），
 * 数百毫秒后拨号成功，这条 TCP 连接既无人读也无人关，
 * 白占「单请求 6 条并发出站」里的一个槽位，直到运行时超时。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleXhttp, clearXhttpSessions } = await import('../src/protocols/xhttp')
const { uuidToBytes } = await import('../src/protocols/vless')
const { DEFAULT_CONFIG } = await import('../src/config')

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

/** 合法的 seq 0 分包：VLESS 头（域名目标）+ 1 字节负载 */
function buildSeq0(): Uint8Array {
  const uuid = uuidToBytes(UUID)!
  const name = new TextEncoder().encode('example.com')
  return concat(
    new Uint8Array([0x00]),
    uuid,
    new Uint8Array([0]),
    new Uint8Array([0x01]),
    new Uint8Array([0x01, 0xbb]),
    new Uint8Array([0x02, name.length]),
    name,
    new Uint8Array([1])
  )
}

const config = {
  ...DEFAULT_CONFIG,
  uuid: UUID,
  xhttpPath: '/xhttp',
} as unknown as Parameters<typeof handleXhttp>[1]

const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

describe('XHTTP 下行取消与在途拨号', () => {
  beforeEach(() => {
    clearXhttpSessions()
    dialMock.mockReset()
  })

  it('取消后迟到的拨号结果被关闭（幂等，只关一次）', async () => {
    let resolveDial: ((value: unknown) => void) | null = null
    dialMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDial = resolve
      })
    )

    // 1) 上行 seq 0（建立会话 + 发布协议头）
    const post = await handleXhttp(
      new Request('https://worker.test/xhttp/sess-1/0', { method: 'POST', body: Buffer.from(buildSeq0()) }),
      config,
      []
    )
    expect(post!.status).toBe(200)

    // 2) 下行 GET：读第一块触发「先回响应头、再后台拨号」
    const get = await handleXhttp(
      new Request('https://worker.test/xhttp/sess-1', { method: 'GET' }),
      config,
      []
    )
    const reader = get!.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value).toEqual(new Uint8Array([0, 0]))
    await flush()
    expect(dialMock).toHaveBeenCalledTimes(1)

    // 3) 拨号尚未完成时客户端取消
    await reader.cancel('client cancelled')
    await flush()

    // 4) 拨号这时才成功
    const closeSpy = vi.fn()
    const readable = new ReadableStream<Uint8Array>({
      pull() {
        /* 永不产出 */
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write() {
        /* 丢弃 */
      },
    })
    resolveDial!({ readable, writable, via: 'direct', endpoint: '203.0.113.9:443', close: closeSpy })
    await flush()

    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})
