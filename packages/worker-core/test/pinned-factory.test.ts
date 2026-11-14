import { describe, expect, it } from 'vitest'

// 出厂固定落地 / 固定反代入口的合并语义（2026-11-14）。
//
// 守护的行为：内核内置的 x.com / cloudflare.com 出厂修复，
// 不能被用户在面板写的其它站点映射整体顶掉 —— 否则所有只配了自己
// 站点的用户会静默退回「x.com 时好时坏 / cloudflare.com 无法访问」。

import { DEFAULT_CONFIG, configFromEnv, mergeConfig } from '../src/config'
import { pinnedIpsFor, pinnedRelaysFor } from '../src/outbound/pinned'

describe('出厂 pinnedHosts 默认值', () => {
  it('默认值含 x.com 直连与 cloudflare.com 反代入口', () => {
    expect(pinnedIpsFor(DEFAULT_CONFIG.pinnedHosts, 'x.com', 443)).toEqual([
      { ip: '151.101.194.146', port: 443 },
    ])
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'cloudflare.com', 443)).toEqual([
      { ip: '45.76.246.192', port: 443 },
    ])
  })

  it('configFromEnv 未设 PINNED_HOSTS 时保留出厂值', () => {
    const cfg = configFromEnv({})
    expect(pinnedIpsFor(cfg.pinnedHosts, 'x.com', 443)).toHaveLength(1)
  })
})

describe('pinnedHosts 按域名合并（用户条目优先）', () => {
  const base = DEFAULT_CONFIG.pinnedHosts

  it('用户没配置 → 出厂值原样生效', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG }, { pinnedHosts: '' })
    expect(pinnedIpsFor(merged.pinnedHosts, 'x.com', 443)).toEqual([
      { ip: '151.101.194.146', port: 443 },
    ])
  })

  it('用户只配别的站点 → 出厂修复仍然生效', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG, pinnedHosts: base }, { pinnedHosts: 'jable.tv=159.60.146.82' })
    expect(pinnedIpsFor(merged.pinnedHosts, 'jable.tv', 443)).toEqual([
      { ip: '159.60.146.82', port: 443 },
    ])
    expect(pinnedIpsFor(merged.pinnedHosts, 'x.com', 443)).toEqual([
      { ip: '151.101.194.146', port: 443 },
    ])
    expect(pinnedRelaysFor(merged.pinnedHosts, 'cloudflare.com', 443)).toEqual([
      { ip: '45.76.246.192', port: 443 },
    ])
  })

  it('用户覆盖同域名条目 → 以用户为准，不再带出厂条目', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG, pinnedHosts: base }, { pinnedHosts: 'x.com=203.0.113.9' })
    expect(pinnedIpsFor(merged.pinnedHosts, 'x.com', 443)).toEqual([
      { ip: '203.0.113.9', port: 443 },
    ])
    // 出厂值里只有 x.com 与 cloudflare.com：x.com 被用户接管，cloudflare.com 保留
    expect(pinnedRelaysFor(merged.pinnedHosts, 'cloudflare.com', 443)).toEqual([
      { ip: '45.76.246.192', port: 443 },
    ])
  })

  it('用户覆盖同域名反代条目 → 用户反代优先，出厂反代不再保留', () => {
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, pinnedHosts: base },
      { pinnedHosts: 'cloudflare.com=r:198.51.100.7' }
    )
    expect(pinnedRelaysFor(merged.pinnedHosts, 'cloudflare.com', 443)).toEqual([
      { ip: '198.51.100.7', port: 443 },
    ])
  })

  it('直连形态与反代形态是不同条目键：用户改为直连形态时出厂反代兜底保留', () => {
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, pinnedHosts: base },
      { pinnedHosts: 'cloudflare.com=203.0.113.77' }
    )
    expect(pinnedIpsFor(merged.pinnedHosts, 'cloudflare.com', 443)).toEqual([
      { ip: '203.0.113.77', port: 443 },
    ])
    expect(pinnedRelaysFor(merged.pinnedHosts, 'cloudflare.com', 443)).toEqual([
      { ip: '45.76.246.192', port: 443 },
    ])
  })

  it('合并结果仍是合法配置（逐行可解析）', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG, pinnedHosts: base }, { pinnedHosts: 'a.example=1.2.3.4' })
    for (const line of merged.pinnedHosts.split('\n')) {
      expect(() => pinnedIpsFor(line, 'zzz.example', 443)).not.toThrow()
    }
  })
})
