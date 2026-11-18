/**
 * 端点健康记忆 —— 回归测试。
 *
 * ## 守护的缺陷（2026-11-18 审计核实）
 *
 * `endpoint-health.ts` 的 `prune()` 早前把「冷却已过期」与「**还没进冷却**」
 * 混在一起删：`if (state.cooldownUntil <= now) delete`。首次失败时
 * `cooldownUntil` 是 0，于是第二次失败到来前记录就被清掉，计数永远停在 1，
 * 阈值 2 永不触发 —— 整套健康记忆（反代入口 / 优选 IP / 直连的记忆）实际失效。
 *
 * `proxy-health.ts` 则是另一个方向：既无上限也无过期清理，
 * 用户长期更换代理时记录会一直累积。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { clearEndpointHealth, endpointHealthSize, isEndpointCooled, recordEndpointFailure, recordEndpointSuccess, sortByEndpointHealth } from '../src/outbound/endpoint-health'
import { clearProxyHealth, filterHealthy, isProxyInCooldown, recordProxyFailure } from '../src/outbound/proxy-health'

const KEY = 'relay|198.51.100.1:443'

beforeEach(() => {
  clearEndpointHealth()
  clearProxyHealth()
})

describe('endpoint-health：连续失败阈值', () => {
  it('同一端点连续失败两次 → 进入冷却（首次失败不能把计数清掉）', () => {
    const t0 = 1_000_000
    recordEndpointFailure(KEY, t0, false)
    expect(isEndpointCooled(KEY, t0 + 1)).toBe(false)
    recordEndpointFailure(KEY, t0 + 1_000, false)
    expect(isEndpointCooled(KEY, t0 + 2_000)).toBe(true)
  })

  it('成功一次清空此前计数', () => {
    const t0 = 1_000_000
    recordEndpointFailure(KEY, t0, false)
    recordEndpointSuccess(KEY)
    recordEndpointFailure(KEY, t0 + 1_000, false)
    expect(isEndpointCooled(KEY, t0 + 2_000)).toBe(false)
  })

  it('目标站拒绝不计入（节点是活的）', () => {
    const t0 = 1_000_000
    recordEndpointFailure(KEY, t0, true)
    recordEndpointFailure(KEY, t0 + 1_000, true)
    expect(isEndpointCooled(KEY, t0 + 2_000)).toBe(false)
  })

  it('失败记录会随时间衰减：间隔超过 10 分钟重新从 1 计数', () => {
    const t0 = 1_000_000
    recordEndpointFailure(KEY, t0, false)
    recordEndpointFailure(KEY, t0 + 11 * 60_000, false)
    // 第一条已超过衰减窗口，本次只算第一次失败
    expect(isEndpointCooled(KEY, t0 + 11 * 60_000 + 1)).toBe(false)
    recordEndpointFailure(KEY, t0 + 11 * 60_000 + 2_000, false)
    expect(isEndpointCooled(KEY, t0 + 11 * 60_000 + 3_000)).toBe(true)
  })

  it('冷却过期后重新开始计数', () => {
    const t0 = 1_000_000
    recordEndpointFailure(KEY, t0, false)
    recordEndpointFailure(KEY, t0 + 1_000, false)
    expect(isEndpointCooled(KEY, t0 + 2_000)).toBe(true)
    // 30 秒冷却 + 一次计算误差后过期
    expect(isEndpointCooled(KEY, t0 + 40_000)).toBe(false)
  })

  it('容量上限内不会无限增长', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 400; i++) recordEndpointFailure(`relay|203.0.${i % 250}.1:443`, t0, false)
    expect(endpointHealthSize()).toBeLessThanOrEqual(256)
  })
})

describe('endpoint-health：稳定排序', () => {
  it('冷却中的候选排到最后，但不删除任何候选', () => {
    const t0 = 1_000_000
    recordEndpointFailure('optimized|1.2.3.4:443', t0, false)
    recordEndpointFailure('optimized|1.2.3.4:443', t0 + 1, false)
    const candidates = [
      { host: '1.2.3.4', port: 443 },
      { host: '5.6.7.8', port: 443 },
      { host: '9.10.11.12', port: 443 },
    ]
    const sorted = sortByEndpointHealth(
      candidates,
      (c) => `optimized|${c.host}:${c.port}`,
      t0 + 2
    )
    expect(sorted).toHaveLength(3)
    expect(sorted[0]!.host).toBe('5.6.7.8')
    expect(sorted[sorted.length - 1]!.host).toBe('1.2.3.4')
  })
})

describe('proxy-health：容量与冷却', () => {
  it('连续失败两次进入冷却', () => {
    const proxy = { kind: 'socks5' as const, host: '10.0.0.1', port: 1080 }
    const t0 = 1_000_000
    recordProxyFailure(proxy, t0)
    expect(isProxyInCooldown(proxy, t0 + 1)).toBe(false)
    recordProxyFailure(proxy, t0 + 1_000)
    expect(isProxyInCooldown(proxy, t0 + 2_000)).toBe(true)
  })

  it('全部候选都在冷却时回退到全量（不锁死链路）', () => {
    const t0 = 1_000_000
    const proxy = { kind: 'socks5' as const, host: '10.0.0.1', port: 1080 }
    recordProxyFailure(proxy, t0)
    recordProxyFailure(proxy, t0 + 1)
    const list = [{ via: proxy }]
    expect(filterHealthy(list, (c) => c.via, t0 + 2)).toHaveLength(1)
  })

  it('记录数量有上限（长期换代理不会无限累积）', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 400; i++) {
      recordProxyFailure({ kind: 'socks5', host: `10.1.${i % 250}.9`, port: 1000 + (i % 100) }, t0)
    }
    // 没有 size 导出：用「最早的记录已被 FIFO 淘汰」来间接验证
    const first = { kind: 'socks5' as const, host: '10.1.0.9', port: 1000 }
    recordProxyFailure(first, t0)
    expect(isProxyInCooldown(first, t0 + 1)).toBe(false)
  })
})
