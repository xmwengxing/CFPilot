/**
 * 下行背压让步点 `awaitSendCapacity`。
 *
 * ## 这组用例真正要守住的是「不改变行为」
 *
 * 这是隧道下行热路径上唯一的新增调用，用户对它的唯一要求是
 * **不能影响原有转发性能**。所以断言的重点不是「它会让步」，
 * 而是「在所有正常情况下它**不引入任何宏任务**」——
 * 让步只该在缓冲真堆到阈值时发生。
 *
 * 判据用 `setTimeout(0)` 的触发顺序：
 *   先注册的定时器先跑；若被测函数内部也 `setTimeout(0)`，
 *   它注册得更晚，因此我们先注册的那个一定已经跑过 → `ticked === true`。
 */
import { describe, expect, it } from 'vitest'
import { awaitSendCapacity, DOWNLINK_HIGH_WATER } from '../src/protocols/stream'

describe('下行背压让步点', () => {
  it('阈值是 4MB —— 正常流量的瞬时缓冲达不到', () => {
    expect(DOWNLINK_HIGH_WATER).toBe(4 * 1024 * 1024)
  })

  it('缓冲低于阈值时同步返回，不引入宏任务', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 0)

    await awaitSendCapacity({ bufferedAmount: 0 })
    await awaitSendCapacity({ bufferedAmount: DOWNLINK_HIGH_WATER - 1 })

    // 恰好等于阈值也该返回（只有**超过**才让步）
    await awaitSendCapacity({ bufferedAmount: DOWNLINK_HIGH_WATER })

    expect(ticked).toBe(false)
  })

  it('运行时没实现 bufferedAmount（undefined）时同样同步返回', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 0)

    await awaitSendCapacity({})

    expect(ticked).toBe(false)
  })

  it('缓冲超过阈值时确实让步一次', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 0)

    await awaitSendCapacity({ bufferedAmount: DOWNLINK_HIGH_WATER + 1 })

    expect(ticked).toBe(true)
  })

  it('阈值可由调用方覆盖（便于按场景收紧或放宽）', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 0)

    // 用自定义阈值：1024 字节视为超限
    await awaitSendCapacity({ bufferedAmount: 2048 }, 1024)
    expect(ticked).toBe(true)

    let ticked2 = false
    setTimeout(() => {
      ticked2 = true
    }, 0)
    await awaitSendCapacity({ bufferedAmount: 512 }, 1024)
    expect(ticked2).toBe(false)
  })
})
