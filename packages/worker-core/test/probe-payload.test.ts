/**
 * 探针测速载荷：**必须不可压缩**。
 *
 * ## 背景（GPT 优选器审计，2026-10-29）
 *
 * 早前 `/__edge_probe` 的 64KB 块是 `buf.fill(0x61)` —— 全是重复字符 'a'，
 * 压缩比可以到 1000:1。虽然响应头里写了 `Content-Encoding: identity`，
 * 但只要某天这个头被去掉、或者中间层自行压缩，测出来的「吞吐」
 * 就会变成压缩管道的速度，与真实代理流量（TLS 密文，几乎不可压缩）毫无关系。
 *
 * 现在改用确定性伪随机块：字节分布均匀、不可压缩、每次构建内容一致。
 */
import { describe, expect, it } from 'vitest'
import { handleEdgeProbe } from '../src/probe'

async function readBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
    if (total >= 4096) break
  }
  await reader.cancel()
  const out = new Uint8Array(Math.min(total, 4096))
  let off = 0
  for (const c of chunks) {
    if (off >= out.length) break
    const take = Math.min(c.byteLength, out.length - off)
    out.set(c.subarray(0, take), off)
    off += take
  }
  return out
}

function probeRequest(bytes: number): Request {
  return new Request(`https://dp.example.com/__edge_probe?bytes=${bytes}`)
}

describe('探针载荷不可压缩', () => {
  it('前 4KB 的字节分布足够均匀（不是同一个字符）', async () => {
    const response = await handleEdgeProbe(probeRequest(8192))
    expect(response.status).toBe(200)
    const body = await readBody(response)

    expect(body.byteLength).toBe(4096)
    const distinct = new Set(body)
    // 均匀随机下 4KB 里基本能覆盖全部 256 种字节值
    expect(distinct.size).toBeGreaterThan(200)
    // 旧实现（全 'a'）这里会是 1
    expect(distinct.size).not.toBe(1)
  })

  it('内容确定性：两次请求的数据块完全相同（便于对照复现）', async () => {
    const a = await readBody(await handleEdgeProbe(probeRequest(4096)))
    const b = await readBody(await handleEdgeProbe(probeRequest(4096)))
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('仍声明 identity 编码与测试字节数', async () => {
    const response = await handleEdgeProbe(probeRequest(4096))
    expect(response.headers.get('Content-Encoding')).toBe('identity')
    expect(response.headers.get('X-Probe-Bytes')).toBe('4096')
  })
})
