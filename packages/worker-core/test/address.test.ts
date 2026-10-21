import { describe, expect, it } from 'vitest'
import { encodeAddress, isDomain, isIpv4, isIpv6, readAddress } from '../src/protocols/address'

describe('地址类型判定', () => {
  it('识别 IPv4', () => {
    expect(isIpv4('1.2.3.4')).toBe(true)
    expect(isIpv4('1.2.3.256')).toBe(false)
    expect(isIpv4('example.com')).toBe(false)
  })

  it('识别 IPv6', () => {
    expect(isIpv6('2606:4700::1')).toBe(true)
    expect(isIpv6('1.2.3.4')).toBe(false)
  })

  it('识别域名', () => {
    expect(isDomain('example.com')).toBe(true)
    expect(isDomain('localhost')).toBe(false)
  })
})

describe('readAddress', () => {
  it('解析 VLESS 风格域名地址（类型 2）', () => {
    const bytes = new Uint8Array([0x02, 0x0b, ...new TextEncoder().encode('example.com')])
    const result = readAddress(bytes, 0, 2, true)
    expect(result?.hostname).toBe('example.com')
    expect(result?.next).toBe(13)
  })

  it('解析 Trojan 风格域名地址（类型 3）', () => {
    const bytes = new Uint8Array([0x03, 0x0b, ...new TextEncoder().encode('example.com')])
    const result = readAddress(bytes, 0, 3, false)
    expect(result?.hostname).toBe('example.com')
  })

  it('解析 IPv4 地址', () => {
    const bytes = new Uint8Array([0x01, 104, 16, 132, 20])
    const result = readAddress(bytes, 0, 1, true)
    expect(result?.hostname).toBe('104.16.132.20')
    expect(result?.next).toBe(5)
  })

  it('解析 IPv6 地址并压缩零段', () => {
    const bytes = new Uint8Array([0x03, 0x26, 0x06, 0x47, 0x00, ...new Uint8Array(10), 0x00, 0x01])
    const result = readAddress(bytes, 0, 3, true)
    expect(result?.hostname).toBe('2606:4700::1')
    expect(result?.next).toBe(17)
  })

  it('数据不足时返回 null', () => {
    expect(readAddress(new Uint8Array([0x02, 0x0b, 0x65]), 0, 2, true)).toBeNull()
  })
})

describe('encodeAddress', () => {
  it('IPv4 往返一致', () => {
    const encoded = encodeAddress('1.2.3.4', 443, true)
    expect(encoded[0]).toBe(0x01)
    const parsed = readAddress(encoded, 0, 1, true)
    expect(parsed?.hostname).toBe('1.2.3.4')
    expect((encoded[encoded.length - 2]! << 8) | encoded[encoded.length - 1]!).toBe(443)
  })

  it('域名往返一致', () => {
    const encoded = encodeAddress('example.com', 8443, true)
    expect(encoded[0]).toBe(0x02)
    const parsed = readAddress(encoded, 0, 2, true)
    expect(parsed?.hostname).toBe('example.com')
  })

  it('IPv6 往返一致', () => {
    const encoded = encodeAddress('2606:4700::1', 443, true)
    expect(encoded[0]).toBe(0x03)
    const parsed = readAddress(encoded, 0, 3, true)
    expect(parsed?.hostname).toBe('2606:4700::1')
    expect((encoded[encoded.length - 2]! << 8) | encoded[encoded.length - 1]!).toBe(443)
  })
})
