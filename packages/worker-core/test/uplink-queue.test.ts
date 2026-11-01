/**
 * 上行写入串行链（UplinkQueue）—— 顺序回归测试。
 *
 * ## 这个测试在防什么
 *
 * 2026-10-31 代码核对发现的真实窗口：反代重拨时先 `await` 写入重放数据，
 * **之后**才补写「重拨期间缓存的新帧」。若客户端在重放写入未完成时又发来一帧，
 * 它会看到 writer 已就绪而直接排队，于是补写的旧帧反而排在后面 ——
 * 上行字节顺序变成「重放, 新帧, 旧帧」。
 *
 * TLS 记录一旦换序就是 `bad_record_mac` / 连接被重置，而这恰好发生在
 * 直连假活 → 反代重拨这种本就脆弱的时刻，真机上极难复现与定位。
 *
 * 因此这里用「首块写入人为延迟」的假 writer 直接断言写入序列：
 * 先入队的必须先进 writer，与谁先 `await` 无关。
 */
import { describe, expect, it } from 'vitest'
import { UplinkQueue, type UplinkWriter } from '../src/protocols/uplink-queue'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 记录写入顺序的假 writer；`delayFirstMs` 让首块写入变慢，制造插队窗口 */
function makeWriter(options: { delayFirstMs?: number; failOn?: number } = {}): {
  writer: UplinkWriter
  order: number[]
} {
  const order: number[] = []
  let count = 0
  const writer: UplinkWriter = {
    async write(chunk: Uint8Array): Promise<void> {
      count += 1
      if (options.failOn === count) throw new Error('模拟写入失败')
      if (count === 1 && options.delayFirstMs) await sleep(options.delayFirstMs)
      order.push(chunk[0]!)
    },
  }
  return { writer, order }
}

describe('UplinkQueue（上行顺序）', () => {
  it('首块写入未完成时入队的后续块仍然排在它后面', async () => {
    const { writer, order } = makeWriter({ delayFirstMs: 30 })
    const queue = new UplinkQueue()

    const first = queue.write(() => writer, new Uint8Array([0x44])) // 'D'
    const second = queue.write(() => writer, new Uint8Array([0x45])) // 'E'

    await Promise.all([first, second])
    expect(order).toEqual([0x44, 0x45])
  })

  it('「重放 + 补写」作为一个任务入队时，期间到达的新帧不会被插到中间', async () => {
    const { writer, order } = makeWriter({ delayFirstMs: 30 })
    const queue = new UplinkQueue()

    // 模拟重拨：重放（首块，慢）+ 补写缓存帧 D
    const transition = queue.run(async () => {
      await writer.write(new Uint8Array([0x52])) // 'R' = 重放
      await writer.write(new Uint8Array([0x44])) // 'D' = 补写缓存
    })
    // 重拨期间客户端又发来一帧 E —— 它只能排在整段切换任务之后
    const live = queue.write(() => writer, new Uint8Array([0x45]))

    await Promise.all([transition, live])
    expect(order).toEqual([0x52, 0x44, 0x45])
  })

  it('执行时写入器未就绪则跳过，不抛错也不阻塞后续任务', async () => {
    const { writer, order } = makeWriter()
    const queue = new UplinkQueue()

    // 先占住链，保证 skip 任务在执行时写入器仍未就绪
    const hold = queue.run(() => sleep(10))
    const skipped = queue.write(() => null, new Uint8Array([0x53]))
    const written = queue.write(() => writer, new Uint8Array([0x54]))

    await hold
    await expect(skipped).resolves.toBeUndefined()
    await written
    expect(order).toEqual([0x54])
  })

  it('一次写入失败不会让链断掉，后续写入照常执行', async () => {
    const { writer, order } = makeWriter({ failOn: 1 })
    const queue = new UplinkQueue()

    await expect(queue.write(() => writer, new Uint8Array([0x41]))).rejects.toThrow('模拟写入失败')
    await queue.write(() => writer, new Uint8Array([0x42]))
    expect(order).toEqual([0x42])
  })

  it('写入器在执行时才解析（数据只会写到执行那一刻的 socket）', async () => {
    const first = makeWriter()
    const second = makeWriter()
    const queue = new UplinkQueue()

    let current: UplinkWriter = first.writer
    const pending = queue.write(() => current, new Uint8Array([0x41]))
    // 任务尚未执行（微任务之前）就换了 socket —— 写入跟随当前写入器
    current = second.writer

    await pending
    expect(second.order).toEqual([0x41])
    expect(first.order).toEqual([])
  })
})
