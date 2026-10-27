/**
 * 反代入口池测试。
 *
 * 守护的是自研数据面补齐 vendor 核心能力的关键逻辑：
 * **Cloudflare 网段目标必须能通过第三方反代出去**。
 *
 * 对照实验（真实 Cloudflare，16 轮交替采样，真实 TLS 客户端首包）：
 *   目标 example.com:443（全 CF 网段）
 *     vendor（有反代入口）→ 成功 100%
 *     self （无反代入口）→ 成功 0%
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  BUILTIN_RELAY_DOMAINS,
  BUILTIN_RELAY_REGION,
  clearRelayCache,
  coloToCountry,
  collectRelayEndpoints,
  resolveRelayEntry,
} from '../src/outbound/relay'
import { buildRouteCandidates, groupCandidates } from '../src/outbound/route'

describe('反代入口解析', () => {
  beforeEach(() => {
    clearRelayCache()
  })

  it('IP 字面量直接可用，无需解析', async () => {
    const result = await resolveRelayEntry('1.2.3.4')
    expect(result).toEqual([{ ip: '1.2.3.4', port: 443, label: '1.2.3.4', regionCode: '??' }])
  })

  it('IP 带端口时按给定端口', async () => {
    const result = await resolveRelayEntry('1.2.3.4:8443')
    expect(result[0]).toMatchObject({ ip: '1.2.3.4', port: 8443 })
  })

  it('IPv6 字面量可用', async () => {
    const result = await resolveRelayEntry('2606:4700::1')
    expect(result[0]!.ip).toBe('2606:4700::1')
  })

  it('空条目返回空数组', async () => {
    expect(await resolveRelayEntry('')).toEqual([])
    expect(await resolveRelayEntry('   ')).toEqual([])
  })

  it('域名解析失败时返回空数组而不是抛异常', async () => {
    const result = await resolveRelayEntry('this-does-not-exist-cfpilot.invalid')
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('反代入口池汇总', () => {
  beforeEach(() => {
    clearRelayCache()
  })

  it('用户自配入口优先于内置表', async () => {
    const result = await collectRelayEndpoints({
      userEntries: '1.1.1.1\n2.2.2.2:8443',
      useBuiltin: false,
    })
    expect(result.map((r) => r.ip)).toEqual(['1.1.1.1', '2.2.2.2'])
    expect(result[1]!.port).toBe(8443)
  })

  it('useBuiltin 为 false 时不引入任何第三方入口', async () => {
    const result = await collectRelayEndpoints({ useBuiltin: false })
    expect(result).toEqual([])
  })

  it('内置表非空且与 vendor 同构', () => {
    expect(BUILTIN_RELAY_DOMAINS.length).toBeGreaterThan(0)
    // 这组域名即内置反代表
    expect(BUILTIN_RELAY_DOMAINS).toContain('proxyip.hk.cmliussss.net')
    expect(BUILTIN_RELAY_DOMAINS).toContain('proxyip.jp.cmliussss.net')
  })

  it('去重：同一 IP 不重复出现', async () => {
    const result = await collectRelayEndpoints({
      userEntries: '1.1.1.1\n1.1.1.1\n1.1.1.1:443',
      useBuiltin: false,
    })
    expect(result).toHaveLength(1)
  })
})

describe('反代候选进入选路', () => {
  const relay = [
    { ip: '38.190.210.250', port: 443, label: 'proxyip.hk → 38.190.210.250' },
    { ip: '43.132.231.159', port: 443, label: 'proxyip.hk → 43.132.231.159' },
  ]

  it('默认作兜底（降权组）', () => {
    const list = buildRouteCandidates({
      targetHost: 'example.com',
      targetPort: 443,
      relay,
    })
    const groups = groupCandidates(list)
    expect(groups.direct.some((c) => c.source === 'relay')).toBe(false)
    expect(groups.fallback.filter((c) => c.source === 'relay')).toHaveLength(2)
  })

  it('relayAsPrimary 时参与主竞速', () => {
    const list = buildRouteCandidates({
      targetHost: 'example.com',
      targetPort: 443,
      relay,
      relayAsPrimary: true,
      deprioritizeDirect: true,
    })
    const groups = groupCandidates(list)
    expect(groups.direct.filter((c) => c.source === 'relay')).toHaveLength(2)
  })

  it('反代候选在代理之后（用户显式配置的代理优先）', () => {
    const list = buildRouteCandidates({
      targetHost: 'example.com',
      targetPort: 443,
      relay,
      relayAsPrimary: true,
      proxies: [{ host: 'p.example', port: 1080, kind: 'socks5' }],
    })
    expect(list[0]!.source).toBe('proxy')
  })

  it('反代候选标注来源便于诊断', () => {
    const list = buildRouteCandidates({ targetHost: 'example.com', targetPort: 443, relay })
    const r = list.find((c) => c.source === 'relay')!
    expect(r.label).toContain('反代')
    expect(r.label).toContain('38.190.210.250')
  })
})

describe('colo → 地区映射（与 vendor 的 _Zc 同构）', () => {
  it('常见机房映射到国家码', () => {
    expect(coloToCountry('HKG')).toBe('HK')
    expect(coloToCountry('SIN')).toBe('SG')
    expect(coloToCountry('NRT')).toBe('JP')
    expect(coloToCountry('LAX')).toBe('US')
    expect(coloToCountry('FRA')).toBe('DE')
  })

  it('大小写不敏感', () => {
    expect(coloToCountry('hkg')).toBe('HK')
    expect(coloToCountry('Sin')).toBe('SG')
  })

  it('未知机房回落到 US', () => {
    expect(coloToCountry('ZZZ')).toBe('US')
    expect(coloToCountry('')).toBe('US')
    expect(coloToCountry(undefined)).toBe('US')
  })

  it('已是国家码时原样返回', () => {
    expect(coloToCountry('JP')).toBe('JP')
    expect(coloToCountry('SG')).toBe('SG')
  })
})
