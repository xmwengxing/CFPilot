/**
 * DoH 响应里的 AAAA 过滤 —— 报文级回归测试。
 *
 * ## 守护的缺陷（2026-11-18 核实）
 *
 * `filterAaaa` 早前用 `packet.slice(0, i)` 建**定长**输出缓冲，随后
 * `out.set(rr, out.byteLength)` 写入必然抛 `RangeError`；异常被 `resolve()`
 * 的 catch 吞成 SERVFAIL。也就是说：只要 DoH 应答里含任何一条**非 AAAA**
 * 记录（A / CNAME / OPT…），这条查询就 100% 变成 SERVFAIL。
 *
 * 既有 `udp-dns.test.ts` 全绿是因为它的桩报文 header 计数全为 0，
 * 走了 `qd === 0 && an === 0 …` 的快速返回分支 —— 从没碰到真正的 RR 遍历。
 *
 * 另外两处缺陷：
 *   - 非压缩 NAME 分支在标签结束后多跳 4 字节（把 Question 段的 QTYPE+QCLASS
 *     偏移搬到 RR 段），type / rdlen 整体错位；
 *   - 三个区段用记录数的**值**相等来区分（`total === an`），an 与 ns 相等时
 *     会计错区段。
 *
 * 本文件同时钉住协议边界：压缩指针、复合形态（标签 + 指针）、EDNS0 的
 * 根名称 OPT 记录、截断包必须 fail-open（原样返回，绝不 SERVFAIL）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DnsUdpSession } from '../src/protocols/udp-dns'

/** 域名 → 未压缩的标签序列（含结尾 0x00） */
function labels(text: string): number[] {
  const out: number[] = []
  for (const part of text.split('.')) {
    if (!part) continue
    out.push(part.length, ...Array.from(new TextEncoder().encode(part)))
  }
  out.push(0)
  return out
}

/** 一条 RR：NAME + TYPE2 + CLASS2 + TTL4 + RDLEN2 + RDATA */
function rr(namePart: number[], type: number, rdata: number[], ttl = 60): number[] {
  return [
    ...namePart,
    (type >> 8) & 0xff,
    type & 0xff,
    0x00,
    0x01,
    (ttl >> 24) & 0xff,
    (ttl >> 16) & 0xff,
    (ttl >> 8) & 0xff,
    ttl & 0xff,
    (rdata.length >> 8) & 0xff,
    rdata.length & 0xff,
    ...rdata,
  ]
}

interface BuildOptions {
  question?: string
  answers?: number[][]
  authority?: number[][]
  additional?: number[][]
  /** 低 4 位即 RCODE（0 NOERROR / 3 NXDOMAIN） */
  rcode?: number
}

/** 构造一条 DNS 响应报文（各段记录数取实际数组长度） */
function build(opts: BuildOptions): Uint8Array {
  const question =
    opts.question === undefined ? [] : [...labels(opts.question), 0x00, 0x01, 0x00, 0x01]
  const an = opts.answers ?? []
  const ns = opts.authority ?? []
  const ar = opts.additional ?? []
  const body = [...question, ...an.flat(), ...ns.flat(), ...ar.flat()]
  const out = new Uint8Array(12 + body.length)
  out[0] = 0x12
  out[1] = 0x34
  out[2] = 0x81 // QR=1, RD=1
  out[3] = 0x80 | (opts.rcode ?? 0) // RA=1
  out[4] = opts.question === undefined ? 0 : 0
  out[5] = opts.question === undefined ? 0 : 1
  out[6] = 0
  out[7] = an.length
  out[8] = 0
  out[9] = ns.length
  out[10] = 0
  out[11] = ar.length
  out.set(body, 12)
  return out
}

const A_DATA = [1, 2, 3, 4]
const AAAA_DATA = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

function frame(packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + packet.byteLength)
  out[0] = (packet.byteLength >> 8) & 0xff
  out[1] = packet.byteLength & 0xff
  out.set(packet, 2)
  return out
}

/** 一条 12 字节的最小查询（只用于驱动会话切帧） */
function query(): Uint8Array {
  const out = new Uint8Array(12)
  out[0] = 0x12
  out[1] = 0x34
  out[2] = 0x01
  return out
}

const flush = () => new Promise((r) => setTimeout(r, 20))

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer

/** 把一条 DoH 响应喂给会话，返回回写的 DNS 报文（去掉 2 字节长度前缀） */
async function replyFor(response: Uint8Array): Promise<Uint8Array> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(buf(response), { status: 200 })))
  const sent: Uint8Array[] = []
  const session = new DnsUdpSession({
    endpoint: 'https://dns.example/dns-query',
    send: (b) => sent.push(b),
  })
  session.push(frame(query()))
  await flush()
  expect(sent).toHaveLength(1)
  return sent[0]!.subarray(2)
}

function ancount(body: Uint8Array): number {
  return (body[6]! << 8) | body[7]!
}
function nscount(body: Uint8Array): number {
  return (body[8]! << 8) | body[9]!
}
function arcount(body: Uint8Array): number {
  return (body[10]! << 8) | body[11]!
}
function rcode(body: Uint8Array): number {
  return body[3]! & 0x0f
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AAAA 过滤：正常应答不再变 SERVFAIL', () => {
  it('只有 A 记录 → 原样保留，ANCOUNT 正确', async () => {
    const original = build({
      question: 'example.com',
      answers: [rr([0xc0, 0x0c], 1, A_DATA)],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(1)
    expect(body.byteLength).toBe(original.byteLength)
    expect(body).toEqual(original)
  })

  it('A + AAAA → 只丢 AAAA，A 记录字节完整保留', async () => {
    const aaaa = rr([0xc0, 0x0c], 28, AAAA_DATA)
    const original = build({
      question: 'example.com',
      answers: [rr([0xc0, 0x0c], 1, A_DATA), aaaa],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(1)
    expect(body.byteLength).toBe(original.byteLength - aaaa.length)
    // 前 12 字节头 + question 之后就是保留下来的 A 记录
    const aTail = rr([0xc0, 0x0c], 1, A_DATA)
    expect(body.subarray(body.byteLength - aTail.length)).toEqual(new Uint8Array(aTail))
  })

  it('未压缩 CNAME 链 + A → 两条都保留（非指针 NAME 分支不再错位）', async () => {
    const original = build({
      question: 'www.example.com',
      answers: [
        rr(labels('www.example.com'), 5, labels('target.example.com')),
        rr(labels('target.example.com'), 1, A_DATA),
      ],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(2)
    expect(body.byteLength).toBe(original.byteLength)
    expect(body).toEqual(original)
  })

  it('复合形态（标签 + 压缩指针）的 NAME 也能正确跳过', async () => {
    const original = build({
      question: 'example.com',
      answers: [rr([3, 0x77, 0x77, 0x77, 0xc0, 0x0c], 1, A_DATA)],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(1)
    expect(body).toEqual(original)
  })

  it('AAAA 在 Authority 段也会被剔除，且段计数分别重算', async () => {
    const original = build({
      question: 'example.com',
      answers: [rr([0xc0, 0x0c], 1, A_DATA)],
      authority: [rr([0xc0, 0x0c], 28, AAAA_DATA)],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(1)
    expect(nscount(body)).toBe(0)
  })

  it('EDNS0 根名称 OPT 记录（Additional 段）完整保留', async () => {
    const opt = rr([0x00], 41, [0x00, 0x10, 0x04, 0xd0, 0, 0, 0, 0, 0, 0, 0])
    const original = build({
      question: 'example.com',
      answers: [rr([0xc0, 0x0c], 1, A_DATA)],
      additional: [opt],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(1)
    expect(arcount(body)).toBe(1)
    expect(body).toEqual(original)
  })

  it('只有 AAAA → ANCOUNT 归零，报文仍是合法响应（不是 SERVFAIL）', async () => {
    const aaaa = rr([0xc0, 0x0c], 28, AAAA_DATA)
    const original = build({
      question: 'v6.example.com',
      answers: [aaaa],
    })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(0)
    expect(ancount(body)).toBe(0)
    expect(body.byteLength).toBe(original.byteLength - aaaa.length)
  })

  it('截断 / 畸形包 → fail-open（原样返回，绝不抛错变 SERVFAIL）', async () => {
    const full = build({
      question: 'example.com',
      answers: [rr([0xc0, 0x0c], 1, A_DATA)],
    })
    const broken = full.subarray(0, full.byteLength - 2)
    const body = await replyFor(broken)
    expect(rcode(body)).toBe(0)
    expect(body).toEqual(broken)
  })

  it('NXDOMAIN 空应答走快速路径，RCODE 不被改写', async () => {
    const original = build({ question: 'nx.example.com', rcode: 3 })
    const body = await replyFor(original)
    expect(rcode(body)).toBe(3)
    expect(ancount(body)).toBe(0)
  })
})
