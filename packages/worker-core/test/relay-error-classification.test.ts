/**
 * 中继异常按「读上游 / 写目标」分开上报 —— 回归测试。
 *
 * 原先 `relay()` 用一个 catch 吞掉所有异常，客户端取消、上游重置、
 * 写入失败在诊断里完全无法区分。现在通过可选回调把阶段与错误对象传出去。
 */
import { describe, expect, it, vi } from 'vitest'
import { relay } from '../src/budget'

describe('relay 异常分类回调', () => {
  it('读上游抛错 → phase=read，且错误对象原样传出', async () => {
    const boom = new Error('upstream reset')
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw boom
      },
    })
    const sink = new WritableStream<Uint8Array>()
    const onError = vi.fn()

    await relay(source, sink, undefined, false, undefined, onError)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toBe('read')
    expect(onError.mock.calls[0]![0]).toBe(boom)
  })

  it('写目标抛错 → phase=write', async () => {
    const boom = new Error('broken pipe')
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      },
    })
    const sink = new WritableStream<Uint8Array>({
      write() {
        throw boom
      },
    })
    const onError = vi.fn()

    await relay(source, sink, undefined, false, undefined, onError)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toBe('write')
    expect(onError.mock.calls[0]![0]).toBe(boom)
  })

  it('正常结束不触发回调；不传回调时保持静默', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]))
        c.close()
      },
    })
    const sink = new WritableStream<Uint8Array>()
    const onError = vi.fn()

    await relay(source, sink, undefined, false, undefined, onError)
    expect(onError).not.toHaveBeenCalled()
    await expect(
      relay(
        new ReadableStream<Uint8Array>({ start(c) { c.close() } }),
        new WritableStream<Uint8Array>(),
        undefined,
        false
      )
    ).resolves.toBeUndefined()
  })
})
