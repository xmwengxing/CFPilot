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

  it('app 子域走 r: 固定反代（跳过重拨竞速），裸域仍走 Fastly 固定落地', () => {
    // ⚠️ 不能用「固定落地 IP 通配」覆盖 app 子域 —— Fastly 不服务 API，
    // 会把 app 请求全打到 404（2026-11-15 实测事故）。必须是 r: 反代形态。
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'api.x.com', 443)).toEqual([
      { ip: '155.248.181.189', port: 443 },
    ])
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'pbs.twimg.com', 443)).toEqual([
      { ip: '155.248.181.189', port: 443 },
    ])
    expect(pinnedIpsFor(DEFAULT_CONFIG.pinnedHosts, 'x.com', 443)).toEqual([
      { ip: '151.101.194.146', port: 443 },
    ])
    // 出厂值里绝不能再出现「固定落地 IP 通配」那条有害配置
    expect(DEFAULT_CONFIG.pinnedHosts).not.toContain('*.x.com=151.101.194.146')
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

describe('出厂 relayPool（反代入口池）', () => {
  it('出厂值非空且逐行是 IP / 域名形态', () => {
    const pool = DEFAULT_CONFIG.relayPool.split('\n').filter(Boolean)
    expect(pool.length).toBeGreaterThanOrEqual(5)
    for (const line of pool) expect(line).toMatch(/^[\w.:-]+$/)
  })

  it('用户只配自己的入口 → 出厂可用入口仍保留', () => {
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, relayPool: DEFAULT_CONFIG.relayPool },
      { relayPool: 'my-relay.example.com:443' }
    )
    const lines = merged.relayPool.split('\n')
    expect(lines[0]).toBe('my-relay.example.com:443')
    expect(lines.length).toBeGreaterThanOrEqual(6)
  })

  it('用户重复的行不重复保留', () => {
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, relayPool: DEFAULT_CONFIG.relayPool },
      { relayPool: DEFAULT_CONFIG.relayPool.split('\n')[0] }
    )
    const hits = merged.relayPool.split('\n').filter((l) => l === DEFAULT_CONFIG.relayPool.split('\n')[0])
    expect(hits.length).toBe(1)
  })
})

describe('用户删除的条目不得复活（jable.tv 回归）', () => {
  it('用户删掉自己的条目保存后，出厂兜底补充但它不会回来', () => {
    // KV 用户层原为「jable.tv + x.com」（用户先填过），现在面板删掉 jable.tv 只剩 x.com
    const merged = mergeConfig(DEFAULT_CONFIG, { pinnedHosts: 'x.com=151.101.194.146' })
    expect(merged.pinnedHosts).not.toContain('jable.tv')
    expect(merged.pinnedHosts).toContain('x.com=151.101.194.146')
    // 出厂兜底仍在
    expect(merged.pinnedHosts).toContain('cloudflare.com=r:45.76.246.192')
  })

  it('relayPool 同理：删掉的旧条目不复活', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { relayPool: 'my-relay.example.com:443' })
    expect(merged.relayPool).toContain('my-relay.example.com:443')
    expect(merged.relayPool).toContain('155.248.181.189')
  })
})
