/**
 * 固定落地 IP 映射的解析与选路回归测试。
 *
 * 守护真机定位的问题：站点权威 DNS 把流量分散到多家 CDN 时，逐家 DoH
 * 轮询或运行时解析会让落点漂移（刷新时好时坏）。用户写明落地 IP 后，
 * 该域名应跳过解析、只用固定地址。
 */
import { describe, expect, it } from 'vitest'
import {
  parsePinnedHosts,
  pinnedIpsFor,
  pinnedRelaysFor,
  validatePinnedHosts,
} from '../src/outbound/pinned'
import { buildRouteCandidates, groupCandidates } from '../src/outbound/route'

describe('固定落地 IP 解析', () => {
  it('基本格式：域名=IP', () => {
    expect(pinnedIpsFor('example.com=203.0.113.10', 'example.com', 443)).toEqual([
      { ip: '203.0.113.10', port: 443 },
    ])
  })

  it('支持端口、多个 IP、注释与大小写', () => {
    const text = [
      '# 注释',
      'Example.COM=203.0.113.10:8443,203.0.113.11',
      '  other.example=198.51.100.7  ',
    ].join('\n')
    expect(pinnedIpsFor(text, 'example.com', 443)).toEqual([
      { ip: '203.0.113.10', port: 8443 },
      { ip: '203.0.113.11', port: 443 },
    ])
    expect(pinnedIpsFor(text, 'other.example', 80)).toEqual([
      { ip: '198.51.100.7', port: 80 },
    ])
  })

  it('通配 *. 生效，精确条目优先于通配', () => {
    const text = '*.example.com=203.0.113.20\na.example.com=203.0.113.30'
    expect(pinnedIpsFor(text, 'a.example.com', 443)).toEqual([
      { ip: '203.0.113.30', port: 443 },
    ])
    expect(pinnedIpsFor(text, 'b.example.com', 443)).toEqual([
      { ip: '203.0.113.20', port: 443 },
    ])
  })

  it('未命中返回空，不改变既有行为', () => {
    expect(pinnedIpsFor('example.com=203.0.113.10', 'other.com', 443)).toEqual([])
    expect(pinnedIpsFor('', 'example.com', 443)).toEqual([])
  })

  it('拒绝非法 IP / 域名，保留合法行', () => {
    const text = [
      'ok.example=203.0.113.10',
      'bad.example=999.1.1.1',
      'also-bad.example=not-an-ip',
      'bad host=203.0.113.11',
      'noequals',
    ].join('\n')
    const parsed = parsePinnedHosts(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.host).toBe('ok.example')
    expect(validatePinnedHosts(text)).toEqual([2, 3, 4, 5])
  })

  it('同域名多行合并去重', () => {
    const text = 'a.example=203.0.113.10\na.example=203.0.113.10,203.0.113.11'
    expect(pinnedIpsFor(text, 'a.example', 443)).toEqual([
      { ip: '203.0.113.10', port: 443 },
      { ip: '203.0.113.11', port: 443 },
    ])
  })
})

describe('固定反代入口（r: 前缀）', () => {
  it('r: 条目进反代池，不进直连落地', () => {
    const text = 'cloudflare.com=r:198.51.100.7'
    expect(pinnedRelaysFor(text, 'cloudflare.com', 443)).toEqual([
      { ip: '198.51.100.7', port: 443 },
    ])
    expect(pinnedIpsFor(text, 'cloudflare.com', 443)).toEqual([])
  })

  it('直连与反代条目互不串池', () => {
    const text = [
      'cf.com=r:198.51.100.7:8443',
      'direct.com=203.0.113.10',
    ].join('\n')
    expect(pinnedRelaysFor(text, 'cf.com', 443)).toEqual([{ ip: '198.51.100.7', port: 8443 }])
    expect(pinnedIpsFor(text, 'direct.com', 443)).toEqual([{ ip: '203.0.113.10', port: 443 }])
    expect(pinnedIpsFor(text, 'cf.com', 443)).toEqual([])
    expect(pinnedRelaysFor(text, 'direct.com', 443)).toEqual([])
  })

  it('一行混写两类时只保留先出现的那类', () => {
    const text = 'mixed.com=r:198.51.100.7,203.0.113.10'
    expect(pinnedRelaysFor(text, 'mixed.com', 443)).toEqual([{ ip: '198.51.100.7', port: 443 }])
    // 反过来先直连后反代
    const text2 = 'mixed2.com=203.0.113.10,r:198.51.100.7'
    expect(pinnedIpsFor(text2, 'mixed2.com', 443)).toEqual([{ ip: '203.0.113.10', port: 443 }])
    expect(pinnedRelaysFor(text2, 'mixed2.com', 443)).toEqual([])
  })

  it('非法 r: 值（非 IPv4）被拒绝', () => {
    const text = 'bad.com=r:not-an-ip'
    expect(pinnedRelaysFor(text, 'bad.com', 443)).toEqual([])
    expect(validatePinnedHosts(text)).toEqual([1])
  })
})

describe('固定落地 IP 进入选路', () => {
  it('命中映射且把域名直连降权后，主竞速只剩固定 IP', () => {
    const list = buildRouteCandidates({
      targetHost: 'example.com',
      targetPort: 443,
      optimizedIps: [
        { ip: '203.0.113.10', port: 443 },
        { ip: '203.0.113.11', port: 443 },
      ],
      deprioritizeDirect: true,
    })
    const groups = groupCandidates(list)
    expect(groups.direct.map((c) => c.host)).toEqual(['203.0.113.10', '203.0.113.11'])
    expect(groups.fallback.some((c) => c.source === 'direct')).toBe(true)
  })
})
