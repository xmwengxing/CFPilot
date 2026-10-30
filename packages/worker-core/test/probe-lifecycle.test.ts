/**
 * 探测连接的空闲截止
 *
 * 探针端点必须免鉴权（本地优选器要能匿名用），所以「只握手、不发 PING」
 * 的连接必须被服务端主动回收 —— 否则任何人都能零成本占用并发连接。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

import { armProbeIdleClose } from '../src/probe'

afterEach(() => {
  vi.useRealTimers()
})

describe('armProbeIdleClose', () => {
  it('到点后关闭连接', () => {
    vi.useFakeTimers()
    const closed: Array<{ code: number; reason: string }> = []
    armProbeIdleClose((code, reason) => closed.push({ code, reason }), 5000)

    vi.advanceTimersByTime(4999)
    expect(closed).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(closed).toEqual([{ code: 1000, reason: 'Probe idle timeout' }])
  })

  it('cancel 之后不再关闭', () => {
    vi.useFakeTimers()
    const closed: unknown[] = []
    const idle = armProbeIdleClose((code, reason) => closed.push({ code, reason }), 5000)

    vi.advanceTimersByTime(1000)
    idle.cancel()
    vi.advanceTimersByTime(10_000)
    expect(closed).toHaveLength(0)
  })

  it('重复 cancel 不会抛错', () => {
    vi.useFakeTimers()
    const idle = armProbeIdleClose(() => {}, 1000)
    idle.cancel()
    expect(() => idle.cancel()).not.toThrow()
  })

  it('关闭回调抛错不影响流程', () => {
    vi.useFakeTimers()
    armProbeIdleClose(() => {
      throw new Error('socket already closed')
    }, 1000)
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
  })
})
