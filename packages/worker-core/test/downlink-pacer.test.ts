/**
 * 下行主动让步节流器 —— 回归测试。
 *
 * 平台不提供 `bufferedAmount` / drain，因此转发路径不再依赖运行时属性，
 * 改为按累计字节周期性让出事件循环。这里钉住「不让步 / 让步一次 / 计数重置」。
 */
import { describe, expect, it, vi } from 'vitest'
import { DownlinkPacer, DOWNLINK_YIELD_BYTES } from '../src/protocols/stream'

describe('DownlinkPacer 按累计字节让步', () => {
  it('默认阈值 1 MiB，且累计未达阈值时完全不让步', async () => {
    const yieldFn = vi.fn(async () => {})
    const pacer = new DownlinkPacer(DOWNLINK_YIELD_BYTES, yieldFn)
    expect(DOWNLINK_YIELD_BYTES).toBe(1024 * 1024)

    await pacer.onChunk(64 * 1024)
    await pacer.onChunk(128 * 1024)
    expect(yieldFn).not.toHaveBeenCalled()
    expect(pacer.yieldCount).toBe(0)
  })

  it('累计达到阈值只让步一次，之后计数归零', async () => {
    const yieldFn = vi.fn(async () => {})
    const pacer = new DownlinkPacer(1000, yieldFn)

    await pacer.onChunk(600)
    await pacer.onChunk(400) // 恰好到阈值
    expect(yieldFn).toHaveBeenCalledTimes(1)
    expect(pacer.yieldCount).toBe(1)

    await pacer.onChunk(999)
    expect(yieldFn).toHaveBeenCalledTimes(1) // 归零后重新累计
    await pacer.onChunk(1)
    expect(yieldFn).toHaveBeenCalledTimes(2)
  })

  it('单块就超过阈值时也只让步一次，不按块大小成倍让步', async () => {
    const yieldFn = vi.fn(async () => {})
    const pacer = new DownlinkPacer(100, yieldFn)

    await pacer.onChunk(4096)
    expect(yieldFn).toHaveBeenCalledTimes(1)
    expect(pacer.yieldCount).toBe(1)
  })

  it('零字节块不推进累计', async () => {
    const yieldFn = vi.fn(async () => {})
    const pacer = new DownlinkPacer(10, yieldFn)
    for (let i = 0; i < 20; i++) await pacer.onChunk(0)
    expect(yieldFn).not.toHaveBeenCalled()
  })
})
