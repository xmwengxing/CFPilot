/**
 * `relay()` 的写流关闭语义测试。
 *
 * 守护的是 真机发现的缺陷：
 * 对 `cloudflare:sockets` 的 writable 调用 `close()` 会**关闭整个 TCP 连接**
 * （目标站收到 RST，来不及把响应发回来），
 * 表现为「XHTTP 节点延迟全是 -1」，而服务端看不出任何错误。
 *
 * 对比：WebSocket 入站路径只 `releaseLock()` 不 `close()`，是正常的。
 */
import { describe, expect, it } from 'vitest'
import { relay } from '../src/budget'

/** 收集写入内容的 writable */
function collectingSink(): { stream: WritableStream<Uint8Array>; text: () => string; closed: () => boolean } {
  const chunks: Uint8Array[] = []
  let closed = false
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
    close() {
      closed = true
    },
  })
  return {
    stream,
    text: () => new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))),
    closed: () => closed,
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('relay 的目标写流关闭语义', () => {
  it('默认会关闭目标写流（HTTP 响应体等普通流的正确语义）', async () => {
    const sink = collectingSink()
    await relay(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc('hello'))
          c.close()
        },
      }),
      sink.stream
    )
    expect(sink.text()).toBe('hello')
    expect(sink.closed()).toBe(true)
  })

  it('closeTarget=false 时不关闭目标写流（socket 场景）', async () => {
    const sink = collectingSink()
    await relay(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc('hello'))
          c.close()
        },
      }),
      sink.stream,
      undefined,
      false
    )
    expect(sink.text()).toBe('hello')
    expect(sink.closed()).toBe(false)
  })

  it('closeTarget=false 时数据照常写入', async () => {
    const sink = collectingSink()
    await relay(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc('a'))
          c.enqueue(enc('b'))
          c.close()
        },
      }),
      sink.stream,
      undefined,
      false
    )
    expect(sink.text()).toBe('ab')
  })
})
