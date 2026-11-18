/**
 * 请求体限量读取 —— 回归测试。
 *
 * ## 守护的缺陷（GPT 审计 D-04 / C-07）
 *
 * XHTTP packet-up 与面板 API 早前都是 `await request.arrayBuffer()` /
 * `request.json()` **先读完再判长度**。`Content-Length` 不可信（可缺失、
 * 可分块），于是并发几个大 body 就能把 isolate 内存顶到 1101 ——
 * 而拒绝发生在内存已经分配之后，等于没防。
 *
 * 现在统一走 `readBodyLimited`：按流式累加，越界立刻 cancel。
 */
import { describe, expect, it } from 'vitest'

import { readBodyLimited, readJsonLimited } from '../src/util'

/**
 * 造一个「无限/定长」流式请求体，并记录是否被 cancel。
 * 没有 `Content-Length`，只能靠边读边判。
 */
function streamingBody(totalBytes: number): { request: Request; cancelled: () => boolean } {
  let sent = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(256 * 1024, totalBytes - sent)
      sent += size
      controller.enqueue(new Uint8Array(size))
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request('https://panel.example.com/api/v1/login', {
    method: 'POST',
    body,
    // Node 的 Request 对流式 body 要求显式声明半双工
    duplex: 'half',
  } as RequestInit)
  return { request, cancelled: () => cancelled }
}

describe('readBodyLimited', () => {
  it('无 Content-Length 的超大流式 body：越界即停并 cancel，不读完', async () => {
    const { request, cancelled } = streamingBody(4 * 1024 * 1024)
    const result = await readBodyLimited(request, 64 * 1024)
    expect(result).toBeNull()
    expect(cancelled()).toBe(true)
  })

  it('声明 Content-Length 超限时直接拒绝，一个字节都不读', async () => {
    const { request, cancelled } = streamingBody(4 * 1024 * 1024)
    const withLength = new Request(request.url, {
      method: 'POST',
      headers: { 'content-length': String(4 * 1024 * 1024) },
      body: request.body,
      duplex: 'half',
    } as RequestInit)
    expect(await readBodyLimited(withLength, 64 * 1024)).toBeNull()
    expect(cancelled()).toBe(false)
  })

  it('合规大小的正文原样返回', async () => {
    const request = new Request('https://panel.example.com/api/v1/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'pw' }),
    })
    const bytes = await readBodyLimited(request, 8 * 1024)
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes!)).toBe('{"password":"pw"}')
  })
})

describe('readJsonLimited', () => {
  it('超限 → tooLarge（与「不是合法 JSON」分开）', async () => {
    const request = new Request('https://panel.example.com/api/v1/config', {
      method: 'POST',
      body: JSON.stringify({ pad: 'x'.repeat(32 * 1024) }),
    })
    expect(await readJsonLimited(request, 16 * 1024)).toEqual({ ok: false, tooLarge: true })
  })

  it('非法 JSON → tooLarge=false', async () => {
    const request = new Request('https://panel.example.com/api/v1/config', {
      method: 'POST',
      body: 'not-json',
    })
    expect(await readJsonLimited(request, 16 * 1024)).toEqual({ ok: false, tooLarge: false })
  })
})
