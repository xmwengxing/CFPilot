/**
 * UDP/53 → DoH 会话
 *
 * 这里钉死的是**帧格式**：VLESS 的 UDP 是「2 字节长度 + 报文」，
 * 客户端会把多个查询背靠背发过来，也可能一帧跨多个 WS 消息。
 * 切帧错了不会报错，只会让 DNS 静默失效 —— 所以必须有测试。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

import { DnsUdpSession, servfail } from '../src/protocols/udp-dns'

/** 造一个假 DNS 查询（12 字节头 + 任意负载） */
function query(id: number, payload = 'q'): Uint8Array {
  const body = new Uint8Array(12 + payload.length)
  body[0] = (id >> 8) & 0xff
  body[1] = id & 0xff
  body[2] = 0x01 // RD
  for (let i = 0; i < payload.length; i++) body[12 + i] = payload.charCodeAt(i)
  return body
}

/** 加长度前缀 */
function frame(packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + packet.byteLength)
  out[0] = (packet.byteLength >> 8) & 0xff
  out[1] = packet.byteLength & 0xff
  out.set(packet, 2)
  return out
}

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

/** 等一轮微任务 + 宏任务，让串行队列跑完 */
const flush = () => new Promise((r) => setTimeout(r, 20))

/** 转成独立的 ArrayBuffer：Workers 的 BodyInit 不接受 Uint8Array<ArrayBufferLike> */
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('servfail', () => {
  it('把查询翻成 QR=1 / RCODE=2，并保留 ID', () => {
    const q = query(0x1234)
    const r = servfail(q)
    expect(r[0]).toBe(0x12)
    expect(r[1]).toBe(0x34)
    expect(r[2]! & 0x80).toBe(0x80) // QR = 1
    expect(r[3]! & 0x0f).toBe(0x02) // RCODE = SERVFAIL
    expect(r[2]! & 0x01).toBe(0x01) // RD 保留
  })

  it('过短的报文返回空', () => {
    expect(servfail(new Uint8Array(3)).byteLength).toBe(0)
  })
})

describe('DnsUdpSession 切帧', () => {
  it('一帧完整报文 → 一次 DoH → 一次回写', async () => {
    const dohBody = query(0x1234, 'answer')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(buf(dohBody), { status: 200 })))

    const sent: Uint8Array[] = []
    const session = new DnsUdpSession({
      endpoint: 'https://dns.example/dns-query',
      send: (b) => sent.push(b),
    })
    session.push(frame(query(0x1234)))
    await flush()

    expect(sent).toHaveLength(1)
    const out = sent[0]!
    expect((out[0]! << 8) | out[1]!).toBe(dohBody.byteLength)
    expect(out.subarray(2)).toEqual(dohBody)
  })

  it('半帧 + 半帧 → 只在凑齐后发一次', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(buf(query(1)), { status: 200 })))
    const sent: Uint8Array[] = []
    const session = new DnsUdpSession({ endpoint: 'https://dns.example/q', send: (b) => sent.push(b) })

    const full = frame(query(1))
    session.push(full.subarray(0, 3))
    await flush()
    expect(sent).toHaveLength(0)

    session.push(full.subarray(3))
    await flush()
    expect(sent).toHaveLength(1)
  })

  it('多个查询背靠背 → 逐帧各回一次，顺序不乱', async () => {
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1
        return new Response(buf(query(n)), { status: 200 })
      })
    )
    const sent: Uint8Array[] = []
    const session = new DnsUdpSession({ endpoint: 'https://dns.example/q', send: (b) => sent.push(b) })

    session.push(join(frame(query(1)), frame(query(2)), frame(query(3))))
    await flush()

    expect(sent).toHaveLength(3)
    // 串行处理：第 k 个响应体是 query(k)
    for (let i = 0; i < 3; i++) {
      expect(sent[i]!.subarray(2)[1]).toBe(i + 1)
    }
  })

  it('DoH 失败 → 回 SERVFAIL 而不是静默丢弃', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 502 })))
    const sent: Uint8Array[] = []
    const session = new DnsUdpSession({ endpoint: 'https://dns.example/q', send: (b) => sent.push(b) })

    session.push(frame(query(0x0abc)))
    await flush()

    expect(sent).toHaveLength(1)
    const body = sent[0]!.subarray(2)
    expect(body[3]! & 0x0f).toBe(0x02)
  })

  it('长度前缀为 0 的畸形帧被丢弃，不影响后续帧', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(buf(query(9)), { status: 200 })))
    const sent: Uint8Array[] = []
    const session = new DnsUdpSession({ endpoint: 'https://dns.example/q', send: (b) => sent.push(b) })

    session.push(join(new Uint8Array([0, 0]), frame(query(9))))
    await flush()

    expect(session.droppedCount).toBe(1)
    expect(sent).toHaveLength(1)
  })
})
