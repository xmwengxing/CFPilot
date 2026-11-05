/**
 * Cloudflare 网段判定表重建 —— 回归测试。
 *
 * 旧表把「官方公告段」「实测补充段」「公共 DNS」「IANA 特殊段」混成一张表：
 * 漏了两条官方段，又把阿里公共 DNS 误标成 CF 网段（访问它会被导向
 * 只转发 CF 站点的反代入口）。这里把三类的边界钉住。
 */
import { describe, expect, it } from 'vitest'
import {
  CF_OFFICIAL_IPV4_RANGES,
  PUBLIC_DNS_IPV4_RANGES,
  isCloudflareIpv4,
  isPublicDnsIpv4,
} from '../src/outbound/route'

describe('官方 CF 网段判定', () => {
  it('官方公告段恰好 15 条，且每条的网络地址都命中', () => {
    expect(CF_OFFICIAL_IPV4_RANGES).toHaveLength(15)
    for (const [base] of CF_OFFICIAL_IPV4_RANGES) {
      expect(isCloudflareIpv4(base), `${base} 应命中`).toBe(true)
    }
  })

  it('重建后补齐的两条官方段命中', () => {
    expect(isCloudflareIpv4('173.245.48.1')).toBe(true)
    expect(isCloudflareIpv4('190.93.240.1')).toBe(true)
  })

  it('自家 Anycast DNS 与历史补充段保持降权行为不变', () => {
    expect(isCloudflareIpv4('1.1.1.1')).toBe(true)
    expect(isCloudflareIpv4('1.0.0.1')).toBe(true)
    expect(isCloudflareIpv4('192.0.2.1')).toBe(true)
  })

  it('普通公网地址与测试地址不被误判', () => {
    for (const ip of ['203.0.113.10', '198.51.100.7', '8.8.8.8', '93.184.216.34']) {
      expect(isCloudflareIpv4(ip), `${ip} 不应命中`).toBe(false)
    }
  })

  it('非 IPv4 字面量一律返回 false', () => {
    expect(isCloudflareIpv4('example.com')).toBe(false)
    expect(isCloudflareIpv4('999.1.1.1')).toBe(false)
    expect(isCloudflareIpv4('')).toBe(false)
  })
})

describe('公共 DNS 单独归类', () => {
  it('阿里公共 DNS 不再被当成 CF 网段', () => {
    expect(PUBLIC_DNS_IPV4_RANGES).toContainEqual(['223.5.5.0', 24])
    expect(isCloudflareIpv4('223.5.5.5')).toBe(false)
    expect(isPublicDnsIpv4('223.5.5.5')).toBe(true)
  })

  it('归类不影响其它公网地址', () => {
    expect(isPublicDnsIpv4('8.8.8.8')).toBe(false)
    expect(isPublicDnsIpv4('1.1.1.1')).toBe(false)
  })
})
