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

  it('小采样时不再有每网段 64 下限（--sample 修复回归）', () => {
    // 历史 bug：Math.max(64, ratio) 让 --sample 300 在 15+ 个网段上产出 1400+，
    // 采样数形同虚设。现在 sample ≤ 1000 时下限为 1，总数必须贴近采样数。
    const cidrs = [
      '173.245.48.0/20',
      '103.21.244.0/22',
      '103.22.200.0/22',
      '103.31.4.0/22',
      '141.101.64.0/18',
      '108.162.192.0/18',
      '190.93.240.0/20',
      '188.114.96.0/20',
      '197.234.240.0/22',
      '198.41.128.0/17',
      '162.158.0.0/15',
      '104.16.0.0/13',
      '104.24.0.0/14',
      '172.64.0.0/13',
      '131.0.72.0/22',
    ]
    const list = expandCidrs(cidrs, { sample: 300, seed: 7 })
    expect(list.length).toBeLessThanOrEqual(300)
    expect(list.length).toBeGreaterThan(250)
  })

  it('默认大采样仍保持每网段 64 下限（覆盖均匀）', () => {
    const list = expandCidrs(['104.16.0.0/13', '1.2.0.0/16'], { sample: 20000, seed: 3 })
    // 两个网段都至少 64 个候选
    const v4 = list.filter((ip) => ip.startsWith('104.'))
    const small = list.filter((ip) => ip.startsWith('1.2.'))
    expect(v4.length).toBeGreaterThanOrEqual(64)
    expect(small.length).toBeGreaterThanOrEqual(64)
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
