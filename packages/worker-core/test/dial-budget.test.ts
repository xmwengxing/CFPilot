/**
 * 拨号预算 / 反代精选 / DoH 截止时间 —— 回归测试。
 *
 * 守护 2026-10-23 真机定位的三个缺陷：
 *
 * ① **子请求超限**：内置反代 14 域名全解析（每域名 TXT 3 提供商 + A）
 *    ≈ 56~84 次 DoH，加 32 个并发连接，必然超过 Worker 免费计划
 *    50 次/调用 的上限 —— 真机实测 CF 网段目标 100% 报
 *    `Too many subrequests by single Worker invocation`。
 *    修复：精选 3 个域名（当前地区 + 2 备用，与 vendor 同构）、
 *    跳过反代域名的 TXT、批次降到 8。
 *
 * ② **DoH 马拉松不受拨号超时保护**：`timeoutMs` 只覆盖 connect()，
 *    DoH 最坏 36s/域名完全失控。修复：`budgetMs` 总预算 +
 *    `deadline` 贯穿 DoH / 连接。
 *
 * ③ **预算耗尽仍发起连接**：修复：attemptOf 在剩余时间为零时直接抛错。
 */
import { describe, expect, it, vi } from 'vitest'
import { clearDnsCache, resolveEndpointIps } from '../src/outbound/doh'
import { dial } from '../src/outbound/dial'
import {
  BUILTIN_RELAY_DOMAINS,
  RELAY_DOMAIN_LIMIT,
  RELAY_BATCH_SIZE,
  clearRelayCache,
  selectRelayDomains,
} from '../src/outbound/relay'

describe('内置反代域名精选（子请求预算）', () => {
  it('默认只选 3 个域名（与 vendor 同构，不是 14 个全上）', () => {
    expect(RELAY_DOMAIN_LIMIT).toBe(3)
    expect(selectRelayDomains('HKG')).toHaveLength(3)
    expect(selectRelayDomains(undefined)).toHaveLength(3)
  })

  it('当前 colo 地区排最前', () => {
    const picked = selectRelayDomains('HKG')
    expect(picked[0]).toBe('proxyip.hk.cmliussss.net')
    // 备用域名不能与当前地区重复
    expect(new Set(picked).size).toBe(3)
    expect(picked.every((d) => BUILTIN_RELAY_DOMAINS.includes(d))).toBe(true)
  })

  it('日本机房优先 JP，美国机房优先 US', () => {
    expect(selectRelayDomains('NRT')[0]).toBe('proxyip.jp.cmliussss.net')
    expect(selectRelayDomains('LAX')[0]).toBe('proxyip.us.cmliussss.net')
  })

  it('未知机房回落到 US 地区', () => {
    expect(selectRelayDomains('ZZZ')[0]).toBe('proxyip.us.cmliussss.net')
  })

  it('limit 可覆盖（测试 / 调试用）', () => {
    expect(selectRelayDomains('HKG', 1)).toEqual(['proxyip.hk.cmliussss.net'])
    expect(selectRelayDomains('HKG', 99)).toHaveLength(BUILTIN_RELAY_DOMAINS.length)
  })

  it('连接批次 ≤8：32 个并发 connect 会顶穿子请求上限', () => {
    expect(RELAY_BATCH_SIZE).toBeLessThanOrEqual(8)
  })
})

describe('DoH 截止时间（deadline）', () => {
  it('deadline 已过期时不发起任何 DoH 查询', async () => {
    clearDnsCache()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await resolveEndpointIps('example.com', 443, {
        deadline: Date.now() - 1000,
      })
      expect(result).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('IP 字面量不受 deadline 影响（无需查询）', async () => {
    const result = await resolveEndpointIps('1.2.3.4', 443, { deadline: Date.now() - 1000 })
    expect(result).toEqual([{ hostname: '1.2.3.4', port: 443 }])
  })
})

describe('拨号总预算（budgetMs）', () => {
  it('预算耗尽时直接抛错，不发起连接', async () => {
    const started = Date.now()
    // budgetMs=0 → deadline 已过 → attemptOf 立刻抛「拨号预算已用尽」
    // （不会走到 getConnect()，Node 测试环境里那个动态导入必然失败）
    await expect(
      dial({ hostname: '203.0.113.10', port: 443, budgetMs: 0, timeoutMs: 8000 })
    ).rejects.toThrow(/拨号预算已用尽/)
    // 关键是「快」：不能真的去等一次 8s 连接超时
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('预算为负同样立即失败', async () => {
    await expect(
      dial({ hostname: '203.0.113.10', port: 443, budgetMs: -1 })
    ).rejects.toThrow(/拨号预算已用尽/)
  })
})

describe('反代缓存清理', () => {
  it('clearRelayCache 可调用（测试隔离用）', () => {
    clearRelayCache()
    expect(true).toBe(true)
  })
})
