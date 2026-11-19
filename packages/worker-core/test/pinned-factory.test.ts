import { describe, expect, it } from 'vitest'

// 出厂 pinnedHosts 的合并语义（2026-11-19 调整后）。
//
// 早前内置了 `x.com=151.101.194.146` 与 `cloudflare.com=r:45.76.246.192`
// 两条固定值，但这类 IP 会失效 —— 失效后被 pin 的域名完全断掉
// （真机：cloudflare.com 无法访问）。现已移除，改由内置反代池处理。
//
// 保留的 3 条 `r:` 通配是手机 app 子域的实测修复（api.x.com 等解析到 CF 网段，
// 直连被 TCP Loop 拒绝并拖超时），不属于被移除的「两个网址」。

import { DEFAULT_CONFIG, configFromEnv, mergeConfig } from '../src/config'
import { pinnedIpsFor, pinnedRelaysFor } from '../src/outbound/pinned'

describe('出厂 pinnedHosts 默认值（两个固定值已移除）', () => {
  it('x.com 裸域不再固定落地 IP，由内置反代池处理', () => {
    expect(pinnedIpsFor(DEFAULT_CONFIG.pinnedHosts, 'x.com', 443)).toEqual([])
    expect(DEFAULT_CONFIG.pinnedHosts).not.toContain('151.101.194.146')
  })

  it('cloudflare.com 不再固定反代 IP，由内置反代池处理', () => {
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'cloudflare.com', 443)).toEqual([])
    expect(DEFAULT_CONFIG.pinnedHosts).not.toContain('45.76.246.192')
  })

  it('app 子域的 r: 固定反代仍保留（手机 app 实测修复）', () => {
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'api.x.com', 443)).toEqual([
      { ip: '155.248.181.189', port: 443 },
    ])
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'pbs.twimg.com', 443)).toEqual([
      { ip: '155.248.181.189', port: 443 },
    ])
  })

  it('出厂值里绝不能再出现「固定落地 IP 通配」那条有害配置', () => {
    expect(DEFAULT_CONFIG.pinnedHosts).not.toContain('*.x.com=151.101.194.146')
  })

  it('configFromEnv 未设 PINNED_HOSTS 时保留出厂值（app 子域 r:）', () => {
    const cfg = configFromEnv({})
    expect(pinnedRelaysFor(cfg.pinnedHosts, 'api.x.com', 443)).toHaveLength(1)
  })
})

describe('pinnedHosts 按域名合并（用户条目优先）', () => {
  const base = DEFAULT_CONFIG.pinnedHosts

  it('用户没配置 → 出厂值（app 子域）原样生效', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG }, { pinnedHosts: '' })
    expect(pinnedRelaysFor(merged.pinnedHosts, 'api.x.com', 443)).toHaveLength(1)
  })

  it('用户只配别的站点 → 出厂 app 子域修复仍生效', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG, pinnedHosts: base }, { pinnedHosts: 'jable.tv=159.60.146.82' })
    expect(pinnedIpsFor(merged.pinnedHosts, 'jable.tv', 443)).toEqual([
      { ip: '159.60.146.82', port: 443 },
    ])
    expect(pinnedRelaysFor(merged.pinnedHosts, 'api.x.com', 443)).toHaveLength(1)
  })

  it('用户覆盖同域名条目 → 以用户为准，不再带出厂条目', () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG, pinnedHosts: base }, { pinnedHosts: 'x.com=203.0.113.9' })
    expect(pinnedIpsFor(merged.pinnedHosts, 'x.com', 443)).toEqual([
      { ip: '203.0.113.9', port: 443 },
    ])
  })

  it('用户覆盖同域名反代条目 → 用户反代优先，出厂 r: 不再保留', () => {
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, pinnedHosts: base },
      { pinnedHosts: 'api.x.com=r:198.51.100.7' }
    )
    expect(pinnedRelaysFor(merged.pinnedHosts, 'api.x.com', 443)).toEqual([
      { ip: '198.51.100.7', port: 443 },
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
    // KV 用户层原为「jable.tv + api.x.com」（用户先填过），现在面板删掉 jable.tv
    const merged = mergeConfig(DEFAULT_CONFIG, { pinnedHosts: 'api.x.com=r:155.248.181.189' })
    expect(merged.pinnedHosts).not.toContain('jable.tv')
    expect(merged.pinnedHosts).toContain('api.x.com=r:155.248.181.189')
    // 出厂兜底仍在（app 子域 r:）
    expect(merged.pinnedHosts).toContain('*.twimg.com=r:155.248.181.189')
  })

  it('relayPool 同理：删掉的旧条目不复活', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { relayPool: 'my-relay.example.com:443' })
    expect(merged.relayPool).toContain('my-relay.example.com:443')
    expect(merged.relayPool).toContain('155.248.181.189')
  })
})

describe('旧用户 KV 残留的失效固定值必须被清理', () => {
  it('mergeConfig 剔除用户 KV 里残留的两条失效出厂 pin', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      pinnedHosts: 'x.com=151.101.194.146\ncloudflare.com=r:45.76.246.192\njable.tv=159.60.146.82',
    })
    expect(merged.pinnedHosts).not.toContain('151.101.194.146')
    expect(merged.pinnedHosts).not.toContain('45.76.246.192')
    expect(merged.pinnedHosts).toContain('jable.tv=159.60.146.82')
    expect(pinnedIpsFor(merged.pinnedHosts, 'x.com', 443)).toEqual([])
    expect(pinnedRelaysFor(merged.pinnedHosts, 'cloudflare.com', 443)).toEqual([])
  })

  it('configFromEnv 从环境变量读到的失效固定值也剔除', () => {
    const cfg = configFromEnv({ PINNED_HOSTS: 'x.com=151.101.194.146\ncloudflare.com=r:45.76.246.192' } as never)
    expect(cfg.pinnedHosts).not.toContain('151.101.194.146')
    expect(cfg.pinnedHosts).not.toContain('45.76.246.192')
  })

  it('用户主动配的其它域名固定值不受影响', () => {
    const cfg = configFromEnv({ PINNED_HOSTS: 'my.site=203.0.113.9' } as never)
    expect(cfg.pinnedHosts).toContain('my.site=203.0.113.9')
  })
})
