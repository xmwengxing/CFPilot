/**
 * 公网地址校验 —— 回归测试。
 *
 * 守护 借鉴 cfnew `isPublicAddress` 的增强：
 * 把私网 / 保留 / CGNAT / fake-ip / 组播地址从候选里剔除，
 * 避免浪费探测配额在毫无意义的地址上。
 */
import { describe, expect, it } from 'vitest'
import { isPublicAddress, isFakeIp } from '../src/net-env'
import { normalizeCandidateList } from '../src/candidates'

describe('isPublicAddress：IPv4 公网地址', () => {
  it('放行普通公网 IP', () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true)
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('104.16.0.1')).toBe(true)
    expect(isPublicAddress('172.66.0.1')).toBe(true)
    expect(isPublicAddress('223.5.5.5')).toBe(true)
  })

  it('拒绝环回 / 本网络', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('127.255.255.255')).toBe(false)
    expect(isPublicAddress('0.0.0.0')).toBe(false)
    expect(isPublicAddress('0.1.2.3')).toBe(false)
  })

  it('拒绝私网三段', () => {
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('10.255.255.255')).toBe(false)
    expect(isPublicAddress('172.16.0.1')).toBe(false)
    expect(isPublicAddress('172.31.255.255')).toBe(false)
    expect(isPublicAddress('192.168.1.1')).toBe(false)
  })

  it('拒绝 172.32（私网上界之外，属公网）', () => {
    expect(isPublicAddress('172.32.0.1')).toBe(true)
    expect(isPublicAddress('172.15.0.1')).toBe(true)
  })

  it('拒绝链路本地', () => {
    expect(isPublicAddress('169.254.1.1')).toBe(false)
    expect(isPublicAddress('169.254.169.254')).toBe(false) // 云元数据地址
  })

  it('拒绝 CGNAT 100.64.0.0/10', () => {
    expect(isPublicAddress('100.64.0.1')).toBe(false)
    expect(isPublicAddress('100.127.255.255')).toBe(false)
    // 边界外属公网
    expect(isPublicAddress('100.63.0.1')).toBe(true)
    expect(isPublicAddress('100.128.0.1')).toBe(true)
  })

  it('拒绝 fake-ip 198.18.0.0/15', () => {
    expect(isPublicAddress('198.18.0.1')).toBe(false)
    expect(isPublicAddress('198.19.255.255')).toBe(false)
  })

  it('拒绝组播与保留段', () => {
    expect(isPublicAddress('224.0.0.1')).toBe(false)
    expect(isPublicAddress('239.255.255.255')).toBe(false)
    expect(isPublicAddress('240.0.0.1')).toBe(false)
    expect(isPublicAddress('255.255.255.255')).toBe(false)
  })

  it('拒绝格式非法的值', () => {
    expect(isPublicAddress('')).toBe(false)
    expect(isPublicAddress('abc')).toBe(false)
    expect(isPublicAddress('1.2.3')).toBe(false)
    expect(isPublicAddress('1.2.3.4.5')).toBe(false)
    expect(isPublicAddress('999.1.1.1')).toBe(false)
    expect(isPublicAddress('1.2.3.-1')).toBe(false)
  })

  it('接受带空格的输入（trim）', () => {
    expect(isPublicAddress('  1.1.1.1  ')).toBe(true)
  })
})

describe('isPublicAddress：IPv6', () => {
  it('放行全局单播 2000::/3', () => {
    expect(isPublicAddress('2606:4700::1111')).toBe(true)
    expect(isPublicAddress('2a00:1450::1')).toBe(true)
    expect(isPublicAddress('2400:cb00::1')).toBe(true)
    expect(isPublicAddress('3fff:ffff::1')).toBe(true) // 上界
  })

  it('拒绝链路本地 / 唯一本地 / 环回', () => {
    expect(isPublicAddress('fe80::1')).toBe(false)
    expect(isPublicAddress('fc00::1')).toBe(false)
    expect(isPublicAddress('fd00::1')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
  })

  it('拒绝文档段 2001:db8::/32', () => {
    expect(isPublicAddress('2001:db8::1')).toBe(false)
  })

  it('IPv4-mapped IPv6 按内层 IPv4 判', () => {
    expect(isPublicAddress('::ffff:1.1.1.1')).toBe(true)
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicAddress('::ffff:192.168.1.1')).toBe(false)
  })
})

describe('isFakeIp 与 isPublicAddress 的一致性', () => {
  it('fake-ip 一定不是公网地址', () => {
    for (const ip of ['198.18.0.1', '198.18.1.1', '198.19.0.1']) {
      expect(isFakeIp(ip)).toBe(true)
      expect(isPublicAddress(ip)).toBe(false)
    }
  })
})

describe('normalizeCandidateList：私网地址过滤', () => {
  it('剔除私网 / 保留地址', () => {
    const out = normalizeCandidateList([
      '104.16.1.1',
      '127.0.0.1',
      '192.168.1.1',
      '10.0.0.1',
      '172.16.0.1',
      '100.64.0.1',
      '198.18.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '8.8.8.8',
    ])
    expect(out).toEqual(['104.16.1.1', '8.8.8.8'])
  })

  it('带端口和备注的行也正确过滤', () => {
    const out = normalizeCandidateList([
      '104.16.1.1:443#LAX',
      '192.168.1.1:443#home',
      '10.0.0.5:8443#lan',
    ])
    expect(out).toEqual(['104.16.1.1'])
  })

  it('IPv6 字面量放行', () => {
    const out = normalizeCandidateList(['[2606:4700::1111]:443', '[fe80::1]:443'])
    expect(out).toContain('2606:4700::1111')
    expect(out).not.toContain('fe80::1')
  })

  it('原有去重与顺序保持不回归', () => {
    const out = normalizeCandidateList(['1.1.1.1', '2.2.2.2', '1.1.1.1', '3.3.3.3'])
    expect(out).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3'])
  })

  it('空输入 / 非字符串输入不报错', () => {
    expect(normalizeCandidateList(undefined)).toEqual([])
    expect(normalizeCandidateList([])).toEqual([])
    expect(normalizeCandidateList([123 as unknown as string])).toEqual([])
  })

  it('域名条目不过滤（无法在此解析）', () => {
    // readIpFile 保留域名；isPublicAddress 只过滤字面量 IP
    const out = normalizeCandidateList(['cf.example.com', '104.16.1.1'])
    expect(out).toContain('cf.example.com')
    expect(out).toContain('104.16.1.1')
  })
})
