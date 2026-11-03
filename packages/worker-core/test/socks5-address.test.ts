/**
 * SOCKS5 CONNECT 请求的**目标地址编码**（字节级断言）。
 *
 * ## 为什么断言 wire bytes 而不是导出内部函数
 *
 * `encodeSocks5Address` 是模块私有函数，它唯一的真实后果就是发出去的那十几个字节 ——
 * 直接断言字节比为了测试把它导出更贴近真相，也更早暴露编码错误。
 *
 * ## 这组用例锁的是什么
 *
 * IPv6 目标必须用 `ATYP = 0x04` 并写出**完整 8 组**地址。
 * 早前实现按 `split(':')` 切，`2606:4700::1` 只会得到 3 段
 * （`::` 产生的空串被过滤），于是打出去的是 `2606:4700:1::` ——
 * 地址完全错误、握手却看起来正常，表现为「代理连上了却连不到目标」。
 *
 * 用内存流而不是真实代理：这里只关心**发出去的字节**，
 * 与代理服务器是否真的存在无关，CI 也能稳定跑。
 */
import { describe, expect, it } from 'vitest'
import { socks5Connect } from '../src/outbound/socks5'

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** 收集客户端写出去的全部字节 */
function collectingWritable(): { stream: WritableStream<Uint8Array>; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = []
  return {
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      },
    }),
    bytes: () => concat(chunks),
  }
}

function readableOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!)
        i++
      } else {
        controller.close()
      }
    },
  })
}

/**
 * 服务端固定应答（顺序与客户端读取顺序一一对应）：
 *   ① 方法协商  `05 00`（无需认证）
 *   ② CONNECT 应答 `05 00 00 01`（成功，RSV=0，ATYP=IPv4）
 *   ③ 绑定地址 4 字节
 *   ④ 绑定端口 2 字节
 */
const serverOk = (): ReadableStream<Uint8Array> =>
  readableOf(
    new Uint8Array([0x05, 0x00]),
    new Uint8Array([0x05, 0x00, 0x00, 0x01]),
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    new Uint8Array([0x00, 0x00])
  )

/**
 * 一次握手后返回 CONNECT 请求部分。
 *
 * 前 3 字节是方法协商问候（`05 01 00`），CONNECT 从第 3 字节起：
 * `VER(05) CMD(01) RSV(00) ATYP(--) 地址... 端口(2)`。
 */
async function connectRequest(host: string, port: number): Promise<Uint8Array> {
  const w = collectingWritable()
  await socks5Connect(serverOk(), w.stream, host, port, {})
  const all = w.bytes()
  expect(all.slice(0, 3)).toEqual(new Uint8Array([0x05, 0x01, 0x00]))
  return all.slice(3)
}

describe('SOCKS5 CONNECT 地址编码', () => {
  it('IPv6 目标用 ATYP=0x04，并写出完整的 8 组地址（:: 正确展开）', async () => {
    const req = await connectRequest('2606:4700::1', 443)

    expect(req[0]).toBe(0x05) // VER
    expect(req[1]).toBe(0x01) // CMD: CONNECT
    expect(req[2]).toBe(0x00) // RSV
    expect(req[3]).toBe(0x04) // ATYP: IPv6

    // 2606:4700::1 → 2606 4700 0000 0000 0000 0000 0000 0001
    expect(Array.from(req.slice(4, 20))).toEqual([
      0x26, 0x06, 0x47, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x01,
    ])
    expect(((req[20] ?? 0) << 8) | (req[21] ?? 0)).toBe(443)
  })

  it('IPv6 目标写错的形态（split 切法产生的错位地址）绝不能出现', async () => {
    const req = await connectRequest('2606:4700::1', 443)
    const addr = req.slice(4, 20)

    // 错误实现会得到 `2606:4700:1::` = 2606 4700 0001 0000 ...
    expect(Array.from(addr)).not.toEqual([
      0x26, 0x06, 0x47, 0x00,
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ])
  })

  it('带方括号的 IPv6 目标与裸写法等价（不被当域名打包）', async () => {
    const bare = await connectRequest('2606:4700::1', 443)
    const bracketed = await connectRequest('[2606:4700::1]', 443)

    expect(bracketed[3]).toBe(0x04)
    expect(Array.from(bracketed)).toEqual(Array.from(bare))
  })

  it('全展开与内嵌 IPv4 的写法都能正确编码', async () => {
    const expanded = await connectRequest('2001:0db8:0000:0000:0000:0000:0000:0001', 80)
    expect(expanded[3]).toBe(0x04)
    expect(expanded.slice(4, 6)).toEqual(new Uint8Array([0x20, 0x01]))
    expect(expanded.slice(18, 20)).toEqual(new Uint8Array([0x00, 0x01]))
    expect(((expanded[20] ?? 0) << 8) | (expanded[21] ?? 0)).toBe(80)

    // ::ffff:10.0.0.1 —— 内嵌点分 IPv4
    const mapped = await connectRequest('::ffff:10.0.0.1', 1080)
    expect(mapped[3]).toBe(0x04)
    expect(mapped.slice(4, 14)).toEqual(new Uint8Array(10)) // 前 5 组全 0
    expect(mapped.slice(14, 16)).toEqual(new Uint8Array([0xff, 0xff]))
    expect(mapped.slice(16, 20)).toEqual(new Uint8Array([10, 0, 0, 1]))
  })

  it('IPv4 目标仍是 ATYP=0x01（不被 IPv6 规则误伤）', async () => {
    const req = await connectRequest('104.16.1.1', 443)
    expect(req[3]).toBe(0x01)
    expect(Array.from(req.slice(4, 8))).toEqual([104, 16, 1, 1])
    expect(req.byteLength).toBe(10) // 4 头 + 4 地址 + 2 端口
  })

  it('域名目标仍是 ATYP=0x03（不被 IPv6 规则误伤）', async () => {
    const req = await connectRequest('example.com', 443)
    expect(req[3]).toBe(0x03)
    expect(req[4]).toBe('example.com'.length)
    expect(new TextDecoder().decode(req.slice(5, 5 + 'example.com'.length))).toBe('example.com')
  })
})
