import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearProxyHealth,
  filterHealthy,
  isProxyInCooldown,
  recordProxyFailure,
  recordProxySuccess,
  TargetRejectedError,
} from '../src/outbound/proxy-health'

/**
 * 出站代理健康记忆。
 *
 * ## 守的是什么
 *
 * 落地代理组是**顺序故障转移** —— 第一个失败才试第二个。
 * 于是一个已经宕机的节点会让**每个请求都白等一次完整的代理超时**。
 *
 * 健康记忆让连续失败的节点进入冷却，冷却期内直接跳过。
 *
 * ## 两条容易做错的边界
 *
 * 1. **「目标站拒绝」不算节点失败** —— 那说明代理是活的。
 * 2. **全部节点都在冷却时必须回退到全量** —— 否则整条链路被锁死。
 */
const A = { kind: 'socks5' as const, host: '10.0.0.1', port: 1080 }
const B = { kind: 'socks5' as const, host: '10.0.0.2', port: 1080 }
const C = { kind: 'http' as const, host: '10.0.0.3', port: 8080 }

describe('出站代理健康记忆', () => {
  beforeEach(() => {
    clearProxyHealth()
  })

  it('一次失败不进冷却（避免把瞬时抖动当死节点）', () => {
    recordProxyFailure(A, 1000)
    expect(isProxyInCooldown(A, 1000)).toBe(false)
  })

  it('连续失败到阈值后进入冷却', () => {
    recordProxyFailure(A, 1000)
    recordProxyFailure(A, 1000)
    expect(isProxyInCooldown(A, 1000)).toBe(true)
    // 冷却期内
    expect(isProxyInCooldown(A, 1000 + 29_000)).toBe(true)
    // 冷却期满后自动恢复（半开，可以再试）
    expect(isProxyInCooldown(A, 1000 + 31_000)).toBe(false)
  })

  it('连续失败越多，冷却越久（翻倍，上限 5 分钟）', () => {
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    expect(isProxyInCooldown(A, 0 + 29_000)).toBe(true)

    clearProxyHealth()
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    // 第三次失败 ⇒ 冷却翻倍到 60 秒
    expect(isProxyInCooldown(A, 0 + 59_000)).toBe(true)
    expect(isProxyInCooldown(A, 0 + 61_000)).toBe(false)
  })

  it('成功一次清零（节点恢复后立刻回到候选池）', () => {
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    expect(isProxyInCooldown(A, 0)).toBe(true)
    recordProxySuccess(A)
    expect(isProxyInCooldown(A, 0)).toBe(false)
  })

  it('不同节点互不影响', () => {
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    expect(isProxyInCooldown(A, 0)).toBe(true)
    expect(isProxyInCooldown(B, 0)).toBe(false)
  })

  it('同地址不同协议是不同节点', () => {
    recordProxyFailure({ ...A, kind: 'socks5' }, 0)
    recordProxyFailure({ ...A, kind: 'socks5' }, 0)
    expect(isProxyInCooldown({ ...A, kind: 'socks5' }, 0)).toBe(true)
    expect(isProxyInCooldown({ ...A, kind: 'http' }, 0)).toBe(false)
  })
})

describe('按健康记忆过滤候选', () => {
  beforeEach(() => {
    clearProxyHealth()
  })

  it('冷却中的节点被跳过', () => {
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    const kept = filterHealthy([A, B, C], (c) => c, 0)
    expect(kept).toEqual([B, C])
  })

  it('全部节点都在冷却时回退到全量（不能把链路锁死）', () => {
    for (const node of [A, B, C]) {
      recordProxyFailure(node, 0)
      recordProxyFailure(node, 0)
    }
    const kept = filterHealthy([A, B, C], (c) => c, 0)
    expect(kept).toHaveLength(3)
  })

  it('取不到身份的候选一律保留', () => {
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    const kept = filterHealthy([A, undefined, B], (c) => c, 0)
    expect(kept).toEqual([undefined, B])
  })

  it('单个候选不做过滤（没有「换一个」的意义）', () => {
    recordProxyFailure(A, 0)
    recordProxyFailure(A, 0)
    expect(filterHealthy([A], (c) => c, 0)).toEqual([A])
  })
})

describe('目标站拒绝的判定', () => {
  it('TargetRejectedError 与普通失败是可区分的', () => {
    // 「代理回了应答但拒绝目标」必须能与「代理连不上」区分开 ——
    // 前者说明代理是活的，不该被拉黑。
    const rejected = new TargetRejectedError('SOCKS5 CONNECT 失败：0x02')
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).toBeInstanceOf(TargetRejectedError)
    expect(new Error('超时')).not.toBeInstanceOf(TargetRejectedError)
  })
})
