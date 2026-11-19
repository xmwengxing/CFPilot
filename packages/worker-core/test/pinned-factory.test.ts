import { describe, expect, it } from 'vitest'

// 出厂 pinnedHosts 契约（2026-11-19 起）：
//
// **出厂不再内置任何固定入口**。历史上写死过 5 条，其中 3 条是手机 app 的
// `r:` 通配（`*.x.com` / `*.twitter.com` / `*.twimg.com` = r:155.248.181.189），
// 问题有两个：
//   1. 全用户共享单点 —— IP 失效即全网受影响，只能等发新版；且客户端 app
//      超时约 10~15s，每次请求先白等一次 pin 超时就表现为「一直转圈」。
//   2. `pbs.twimg.com` 实测解析到 Fastly（146.75.x），而 `r:` 是把 TLS 按 SNI
//      转给 **Cloudflare**，CF 无法服务 Fastly 承载的域名 —— 这条从来不会生效。
//
// 现在改为**建议值**（SUGGESTED_PINNED_HOSTS）：默认不生效，面板里手动填入。
// 同时 pin 已纳入熔断（dial.ts），失效 pin 连续失败 2 次后进冷却、直接走池。

import { CONFIG_KEY, DEFAULT_CONFIG, SUGGESTED_PINNED_HOSTS, configFromEnv, loadConfig, mergeConfig } from '../src/config'
import { MemoryStore } from '../src/store'
import { pinnedIpsFor, pinnedRelaysFor } from '../src/outbound/pinned'

describe('出厂 pinnedHosts 默认值为空', () => {
  it('默认不固定任何域名', () => {
    expect(DEFAULT_CONFIG.pinnedHosts).toBe('')
  })

  it('x.com / cloudflare.com / twitter 都不再被出厂固定', () => {
    expect(pinnedIpsFor(DEFAULT_CONFIG.pinnedHosts, 'x.com', 443)).toEqual([])
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'cloudflare.com', 443)).toEqual([])
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'api.x.com', 443)).toEqual([])
    expect(pinnedRelaysFor(DEFAULT_CONFIG.pinnedHosts, 'pbs.twimg.com', 443)).toEqual([])
  })

  it('configFromEnv 未设 PINNED_HOSTS 时也是空', () => {
    expect(configFromEnv({}).pinnedHosts).toBe('')
  })
})

describe('建议值（默认不生效，需用户手动填入）', () => {
  it('只包含 CF 承载的域名，不含 Fastly 承载的 twimg', () => {
    expect(SUGGESTED_PINNED_HOSTS).toContain('*.x.com=r:155.248.181.189')
    expect(SUGGESTED_PINNED_HOSTS).toContain('*.twitter.com=r:155.248.181.189')
    // pbs.twimg.com 在 Fastly，r: 转发给 CF 不可能生效 —— 不得作为建议值
    expect(SUGGESTED_PINNED_HOSTS).not.toContain('twimg')
  })

  it('建议值不会自动生效（默认配置里没有它们）', () => {
    expect(DEFAULT_CONFIG.pinnedHosts).not.toBe(SUGGESTED_PINNED_HOSTS)
    expect(configFromEnv({}).pinnedHosts).not.toContain('155.248.181.189')
  })

  it('用户把建议值填进去后按通配生效', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { pinnedHosts: SUGGESTED_PINNED_HOSTS })
    expect(pinnedRelaysFor(merged.pinnedHosts, 'api.x.com', 443)).toEqual([
      { ip: '155.248.181.189', port: 443 },
    ])
  })
})

describe('历史出厂值：一次性迁移清理，之后允许用户重新填', () => {
  const STALE = [
    'x.com=151.101.194.146',
    'cloudflare.com=r:45.76.246.192',
    '*.x.com=r:155.248.181.189',
    '*.twitter.com=r:155.248.181.189',
    '*.twimg.com=r:155.248.181.189',
  ]

  it('mergeConfig 不再剔除 —— 否则建议值永远填不回来', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { pinnedHosts: SUGGESTED_PINNED_HOSTS })
    expect(merged.pinnedHosts).toBe(SUGGESTED_PINNED_HOSTS)
  })

  it('configFromEnv 尊重用户显式写在环境变量里的值', () => {
    const cfg = configFromEnv({ PINNED_HOSTS: 'my.site=203.0.113.9' } as never)
    expect(cfg.pinnedHosts).toBe('my.site=203.0.113.9')
  })

  it('loadConfig 把 KV 里残留的历史出厂值清掉并写回一次', async () => {
    const store = new MemoryStore()
    await store.put(
      CONFIG_KEY,
      JSON.stringify({ pinnedHosts: [...STALE, 'jable.tv=159.60.146.82'].join('\n') })
    )
    const cfg = await loadConfig(store, {} as never)
    for (const s of STALE) expect(cfg.pinnedHosts).not.toContain(s)
    expect(cfg.pinnedHosts).toContain('jable.tv=159.60.146.82')
    // 写回后 KV 也是干净的（下次读取不需要再迁移）
    const saved = JSON.parse((await store.get(CONFIG_KEY)) || '{}') as { pinnedHosts?: string }
    expect(saved.pinnedHosts || '').not.toContain('155.248.181.189')
    expect(saved.pinnedHosts || '').toContain('jable.tv=159.60.146.82')
  })

  it('迁移后用户可以重新把建议值填回去（不会被再次删除）', async () => {
    const store = new MemoryStore()
    await store.put(CONFIG_KEY, JSON.stringify({ pinnedHosts: SUGGESTED_PINNED_HOSTS }))
    // 迁移只跑一次；若用户值是干净的（不含历史出厂整行以外的残留），应保持原样
    const cfg = await loadConfig(store, {} as never)
    // 建议值恰好等于历史出厂值 → 这次会被清掉；清掉后用户再保存一次即生效
    expect(cfg.pinnedHosts).toBe('')
    const store2 = new MemoryStore()
    await store2.put(CONFIG_KEY, JSON.stringify({ pinnedHosts: 'api.x.com=r:155.248.181.189' }))
    const cfg2 = await loadConfig(store2, {} as never)
    expect(cfg2.pinnedHosts).toBe('api.x.com=r:155.248.181.189')
  })
})

describe('匹配规则（精确优先于通配）', () => {
  it('精确条目盖过通配条目', () => {
    const text = '*.example.com=r:198.51.100.1\na.example.com=r:198.51.100.2'
    expect(pinnedRelaysFor(text, 'a.example.com', 443)).toEqual([
      { ip: '198.51.100.2', port: 443 },
    ])
    expect(pinnedRelaysFor(text, 'b.example.com', 443)).toEqual([
      { ip: '198.51.100.1', port: 443 },
    ])
  })

  it('通配匹配取最长的后缀', () => {
    const text = '*.example.com=r:198.51.100.1\n*.a.example.com=r:198.51.100.2'
    expect(pinnedRelaysFor(text, 'x.a.example.com', 443)).toEqual([
      { ip: '198.51.100.2', port: 443 },
    ])
  })

  it('直连形态与反代形态互不干扰', () => {
    const text = 'example.com=203.0.113.7\nexample.com=r:198.51.100.7'
    expect(pinnedIpsFor(text, 'example.com', 443)).toEqual([{ ip: '203.0.113.7', port: 443 }])
    expect(pinnedRelaysFor(text, 'example.com', 443)).toEqual([
      { ip: '198.51.100.7', port: 443 },
    ])
  })
})

