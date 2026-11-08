/**
 * 登录限速 Map 的容量淘汰策略回归。
 *
 * 全量清空会让 500 个 IP 的限速记录一次性失效 —— 攻击者持续灌不同来源 IP
 * 就能把暴力破解防御整体抹掉。现在改成「先删过期，仍满则 FIFO 淘汰最旧一条」。
 */
import { describe, expect, it } from 'vitest'
import { pruneLoginFailures } from '../src/api'

type Entry = { count: number; resetAt: number }

const NOW = 1_000_000
const alive = (): Entry => ({ count: 1, resetAt: NOW + 60_000 })
const expired = (): Entry => ({ count: 1, resetAt: NOW - 1 })

describe('登录限速 Map 的容量淘汰', () => {
  it('未满时不动表', () => {
    const map = new Map<string, Entry>()
    for (let i = 0; i < 10; i++) map.set(`ip-${i}`, alive())
    pruneLoginFailures(map, NOW, 500)
    expect(map.size).toBe(10)
  })

  it('满表时优先清过期项，不误删未过期项', () => {
    const map = new Map<string, Entry>()
    for (let i = 0; i < 500; i++) map.set(`ip-${i}`, i % 2 === 0 ? expired() : alive())
    pruneLoginFailures(map, NOW, 500)
    expect(map.size).toBe(250)
    expect(map.has('ip-0')).toBe(false)
    expect(map.has('ip-1')).toBe(true)
    expect(map.has('ip-499')).toBe(true)
  })

  it('全未过期时按 FIFO 只淘汰最旧一条，绝不清空', () => {
    const map = new Map<string, Entry>()
    for (let i = 0; i < 500; i++) map.set(`ip-${i}`, alive())
    pruneLoginFailures(map, NOW, 500)
    expect(map.size).toBe(499)
    expect(map.has('ip-0')).toBe(false)
    expect(map.has('ip-499')).toBe(true)

    // 再插一条仍稳定在上限内，且新条目一定在
    map.set('ip-500', alive())
    pruneLoginFailures(map, NOW, 500)
    expect(map.size).toBe(499)
    expect(map.has('ip-1')).toBe(false)
    expect(map.has('ip-500')).toBe(true)
  })
})
