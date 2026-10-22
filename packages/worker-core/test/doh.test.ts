import { describe, expect, it } from 'vitest'
import { splitHostPort } from '../src/outbound/doh'
import { isCloudflareAddress, coloToRegion, CLOUDFLARE_RANGE_COUNT } from '../src/outbound/colo-relay'

describe('splitHostPort', () => {
  it('解析 host:port', () => {
    expect(splitHostPort('1.2.3.4:443', 80)).toEqual({ host: '1.2.3.4', port: 443 })
  })

  it('缺省端口时使用默认值', () => {
    expect(splitHostPort('example.com', 443)).toEqual({ host: 'example.com', port: 443 })
  })

  it('IPv6 带方括号', () => {
    expect(splitHostPort('[2606:4700::1]:443', 80)).toEqual({ host: '2606:4700::1', port: 443 })
  })

  it('裸 IPv6 不按端口切分', () => {
    expect(splitHostPort('2606:4700::1', 443)).toEqual({ host: '2606:4700::1', port: 443 })
  })
})

describe('isCloudflareAddress', () => {
  it('识别官方 Cloudflare IPv4 网段', () => {
    expect(isCloudflareAddress('104.16.0.1')).toBe(true)
    expect(isCloudflareAddress('104.27.19.224')).toBe(true)
    expect(isCloudflareAddress('172.67.1.1')).toBe(true)
    expect(isCloudflareAddress('162.158.0.5')).toBe(true)
  })

  it('识别 Cloudflare IPv6 网段', () => {
    expect(isCloudflareAddress('2606:4700::1111')).toBe(true)
    expect(isCloudflareAddress('2400:cb00::1')).toBe(true)
  })

  it('非 Cloudflare 地址返回 false', () => {
    expect(isCloudflareAddress('8.8.8.8')).toBe(false)
    expect(isCloudflareAddress('1.1.1.1')).toBe(false)
    // 104.16.0.0/13 的边界：104.15.x 在外，104.16.x ~ 104.23.x 在内
    expect(isCloudflareAddress('104.15.255.255')).toBe(false)
    expect(isCloudflareAddress('104.16.0.0')).toBe(true)
    expect(isCloudflareAddress('104.23.255.255')).toBe(true)
    // 104.24.0.0/14 覆盖 104.24.x ~ 104.27.x
    expect(isCloudflareAddress('104.24.0.0')).toBe(true)
    expect(isCloudflareAddress('104.27.255.255')).toBe(true)
    expect(isCloudflareAddress('104.28.0.0')).toBe(false)
    expect(isCloudflareAddress('2001:4860:4860::8888')).toBe(false)
  })

  it('空串与非法输入返回 false', () => {
    expect(isCloudflareAddress('')).toBe(false)
    expect(isCloudflareAddress('not-an-ip')).toBe(false)
  })

  it('内置网段表非空', () => {
    expect(CLOUDFLARE_RANGE_COUNT).toBeGreaterThan(0)
  })
})

describe('coloToRegion', () => {
  it('常见机房映射到区域', () => {
    expect(coloToRegion('HKG')).toBe('HK')
    expect(coloToRegion('NRT')).toBe('JP')
    expect(coloToRegion('SIN')).toBe('SG')
    expect(coloToRegion('LAX')).toBe('US')
    expect(coloToRegion('FRA')).toBe('DE')
  })

  it('未知机房回落到 US', () => {
    expect(coloToRegion('ZZZ')).toBe('US')
    expect(coloToRegion('')).toBe('US')
  })
})
