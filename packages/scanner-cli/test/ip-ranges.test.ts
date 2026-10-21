import { describe, expect, it } from 'vitest'
import { expandCidrs, parseCidr, readIpFile } from '../src/ip-ranges'

describe('parseCidr', () => {
  it('解析 IPv4 网段', () => {
    const parsed = parseCidr('104.16.0.0/13')
    expect(parsed?.family).toBe(4)
    expect(parsed?.prefix).toBe(13)
    expect(parsed?.size).toBe(524288n)
  })

  it('解析 IPv6 网段', () => {
    const parsed = parseCidr('2606:4700::/32')
    expect(parsed?.family).toBe(6)
    expect(parsed?.prefix).toBe(32)
    // IPv6 /32 共有 2^96 个地址
    expect(parsed?.size).toBe(2n ** 96n)
    expect(parsed?.base).toBe(0x26064700000000000000000000000000n)
  })

  it('拒绝非法输入', () => {
    expect(parseCidr('not-an-ip')).toBeNull()
    expect(parseCidr('1.2.3.4/99')).toBeNull()
  })
})

describe('expandCidrs', () => {
  it('小网段全量枚举', () => {
    const list = expandCidrs(['1.2.3.0/30'])
    expect(list).toEqual(['1.2.3.0', '1.2.3.1', '1.2.3.2', '1.2.3.3'])
  })

  it('大网段按采样数收敛', () => {
    const list = expandCidrs(['104.16.0.0/13'], { sample: 500, seed: 1 })
    expect(list.length).toBeLessThanOrEqual(500)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((ip) => ip.startsWith('104.'))).toBe(true)
  })

  it('相同种子产出相同结果', () => {
    const a = expandCidrs(['104.16.0.0/13'], { sample: 200, seed: 42 })
    const b = expandCidrs(['104.16.0.0/13'], { sample: 200, seed: 42 })
    expect(a).toEqual(b)
  })

  it('忽略非法网段', () => {
    expect(expandCidrs(['garbage'])).toEqual([])
  })
})

describe('readIpFile', () => {
  it('读取纯 IP、IP:端口与 CSV 行', () => {
    const text = ['# 注释', '1.2.3.4', '5.6.7.8:443', '9.9.9.9,1,2,3', ''].join('\n')
    expect(readIpFile(text)).toEqual(['1.2.3.4', '5.6.7.8', '9.9.9.9'])
  })

  it('保留 IPv6', () => {
    expect(readIpFile('2606:4700::1')).toEqual(['2606:4700::1'])
  })

  it('清洗 #备注 与 [IPv6]:端口 写法', () => {
    expect(readIpFile('1.2.3.4:443#SJC_12_33.5')).toEqual(['1.2.3.4'])
    expect(readIpFile('[2606:4700::1]:443#LAX')).toEqual(['2606:4700::1'])
    expect(readIpFile('2606:4700::1#备注')).toEqual(['2606:4700::1'])
  })
})
