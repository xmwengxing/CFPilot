/**
 * `ByteStream` 的取消语义。
 *
 * 回归点：构造函数会 `getReader()` 锁定原始流，之后调用方再 `body.cancel()`
 * 会抛 TypeError（被吞掉），底层的 `reader.read()` 仍然挂起 ——
 * XHTTP 头解析超时后请求体没有被真正取消，扫描器发半截 VLESS 头即可持续占用资源。
 * 必须由持有 reader 的 `ByteStream` 自己取消。
 */
import { describe, expect, it } from 'vitest'

import { ByteStream } from '../src/protocols/stream'

describe('ByteStream.cancel', () => {
  it('取消会传递到底层流', async () => {
    let cancelledWith: unknown = null
    const source = new ReadableStream<Uint8Array>({
      start() {
        /* 永不入队也不关闭：模拟客户端只发了半截数据 */
      },
      cancel(reason) {
        cancelledWith = reason
      },
    })

    const stream = new ByteStream(source)
    // 挂起一个读取，取消后它必须结束而不是永远等下去
    const pending = stream.readExactly(10)
    await stream.cancel('header timeout')

    expect(cancelledWith).toBe('header timeout')
    await expect(pending).resolves.toBeNull()
  })

  it('原始流被锁定，调用方直接 cancel 是无效的（这就是必须由 ByteStream 取消的原因）', async () => {
    const source = new ReadableStream<Uint8Array>({
      start() {
        /* 保持打开 */
      },
    })
    const stream = new ByteStream(source)
    expect(source.locked).toBe(true)

    await expect(source.cancel()).rejects.toThrow()

    // ByteStream 自己的取消是有效的
    await stream.cancel()
  })

  it('重复取消是幂等的', async () => {
    let calls = 0
    const source = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        calls += 1
      },
    })
    const stream = new ByteStream(source)
    await stream.cancel('first')
    await stream.cancel('second')
    expect(calls).toBe(1)
  })
})
