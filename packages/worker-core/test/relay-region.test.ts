/**
 * 反代入口地区排序 —— 回归测试。
 *
 * 守护 借鉴 cfnew 的改进：反代入口带 regionCode，
 * 并按「当前地区 → 地理/线路邻近 → 其余」排序。
 *
 * 为什么需要：旧实现按内置表顺序轮转（HK → JP → SG → US → …），
 * 美国用户会先碰香港反代再碰新加坡，而新加坡与美国互通通常更好。
 * 邻接表让排序符合实际线路。
 */
import { describe, expect, it } from 'vitest'
import {
  REGION_ADJACENCY,
  REGION_ORDER,
  UNKNOWN_REGION,
  rankRegions,
  regionOfEntry,
  selectRelayDomains,
  sortEndpointsByRegion,
  type RelayEndpoint,
} from '../src/outbound/relay'

/** 构造测试用入口 */
function ep(ip: string, regionCode: string): RelayEndpoint {
  return { ip, port: 443, label: ip, regionCode }
}

describe('rankRegions：地区邻接排序', () => {
  it('当前地区排第一，其余是邻接 → 其他', () => {
    const rank = rankRegions('US')
    expect(rank[0]).toBe('US')
    // 邻接：SG / JP / KR
    expect(rank.slice(1, 4)).toEqual(['SG', 'JP', 'KR'])
  })

  it('欧洲地区邻接到其他欧洲地区', () => {
    const rank = rankRegions('DE')
    expect(rank[0]).toBe('DE')
    expect(rank.slice(1, 5)).toEqual(['NL', 'GB', 'SE', 'FI'])
  })

  it('未知地区时退化为固定顺序', () => {
    expect(rankRegions('')).toEqual([...REGION_ORDER])
    expect(rankRegions(undefined)).toEqual([...REGION_ORDER])
    expect(rankRegions(null)).toEqual([...REGION_ORDER])
  })

  it('不在邻接表里的地区：本地区第一，其余按 REGION_ORDER', () => {
    const rank = rankRegions('HK') // HK 不在邻接表里
    expect(rank[0]).toBe('HK')
    // 其余按 REGION_ORDER 顺序（去掉 HK 自己）
    expect(rank.slice(1)).toEqual(REGION_ORDER.filter((r) => r !== 'HK'))
  })

  it('大小写不敏感', () => {
    expect(rankRegions('us')).toEqual(rankRegions('US'))
  })

  it('结果无重复且覆盖全部已知地区', () => {
    for (const region of ['US', 'DE', 'JP']) {
      const rank = rankRegions(region)
      expect(new Set(rank).size).toBe(rank.length)
      for (const r of REGION_ORDER) expect(rank).toContain(r)
    }
  })
})

describe('sortEndpointsByRegion', () => {
  const endpoints = [
    ep('1.1.1.1', 'FI'),
    ep('2.2.2.2', 'US'),
    ep('3.3.3.3', 'HK'),
    ep('4.4.4.4', 'SG'),
    ep('5.5.5.5', 'DE'),
  ]

  it('美国机房：US → SG → JP/KR → 欧洲 → 未知', () => {
    const sorted = sortEndpointsByRegion(endpoints, 'US')
    expect(sorted.map((e) => e.regionCode)).toEqual(['US', 'SG', 'DE', 'FI', 'HK'])
  })

  it('德国机房：DE → NL/GB/SE/FI → 其他', () => {
    const sorted = sortEndpointsByRegion(endpoints, 'DE')
    // DE 第一，然后邻接 FI，再按 REGION_ORDER 的 US/SG，HK 未知排最后
    expect(sorted[0]!.regionCode).toBe('DE')
    expect(sorted[1]!.regionCode).toBe('FI')
    expect(sorted[sorted.length - 1]!.regionCode).toBe('HK') // 未知地区垫底
  })

  it('未知地区（??）总是排最后', () => {
    const withUnknown = [...endpoints, ep('6.6.6.6', UNKNOWN_REGION)]
    const sorted = sortEndpointsByRegion(withUnknown, 'US')
    expect(sorted[sorted.length - 1]!.regionCode).toBe(UNKNOWN_REGION)
  })

  it('同地区内保持传入顺序（稳定排序）', () => {
    const same = [ep('a', 'US'), ep('b', 'US'), ep('c', 'SG')]
    const sorted = sortEndpointsByRegion(same, 'US')
    expect(sorted.map((e) => e.ip)).toEqual(['a', 'b', 'c'])
  })

  it('空列表不报错', () => {
    expect(sortEndpointsByRegion([], 'US')).toEqual([])
  })

  it('不改原数组', () => {
    const original = [...endpoints]
    sortEndpointsByRegion(endpoints, 'US')
    expect(endpoints).toEqual(original)
  })
})

describe('regionOfEntry：从入口字符串推断地区', () => {
  it('内置域名 → 对应地区码', () => {
    expect(regionOfEntry('proxyip.hk.cmliussss.net')).toBe('HK')
    expect(regionOfEntry('proxyip.us.cmliussss.net')).toBe('US')
    expect(regionOfEntry('proxyip.jp.cmliussss.net')).toBe('JP')
  })

  it('大小写不敏感', () => {
    expect(regionOfEntry('ProxyIP.HK.CMLiussss.net')).toBe('HK')
  })

  it('带端口的域名也能识别', () => {
    expect(regionOfEntry('proxyip.sg.cmliussss.net:443')).toBe('SG')
  })

  it('IP 字面量 → 未知', () => {
    expect(regionOfEntry('1.2.3.4')).toBe(UNKNOWN_REGION)
    expect(regionOfEntry('2606:4700::1')).toBe(UNKNOWN_REGION)
  })

  it('陌生域名 → 未知', () => {
    expect(regionOfEntry('my-relay.example.com')).toBe(UNKNOWN_REGION)
  })
})

describe('selectRelayDomains：按地区邻接选域名', () => {
  it('美国机房：美国域名排第一', () => {
    const domains = selectRelayDomains('LAX', 3)
    expect(domains[0]).toBe('proxyip.us.cmliussss.net')
  })

  it('香港机房：香港域名排第一', () => {
    const domains = selectRelayDomains('HKG', 3)
    expect(domains[0]).toBe('proxyip.hk.cmliussss.net')
  })

  it('limit=1 只返回当前地区', () => {
    const domains = selectRelayDomains('SIN', 1)
    expect(domains).toEqual(['proxyip.sg.cmliussss.net'])
  })

  it('未知机房时仍返回完整列表（顺序为表顺序）', () => {
    const domains = selectRelayDomains(undefined, 100)
    expect(domains.length).toBeGreaterThan(0)
    expect(new Set(domains).size).toBe(domains.length) // 无重复
  })

  it('limit=0 返回空', () => {
    expect(selectRelayDomains('LAX', 0)).toEqual([])
  })
})

describe('REGION_ADJACENCY 自身一致性', () => {
  it('邻接项都是已知地区', () => {
    for (const [region, adjacent] of Object.entries(REGION_ADJACENCY)) {
      expect(REGION_ORDER).toContain(region)
      for (const a of adjacent) expect(REGION_ORDER, `${region} → ${a}`).toContain(a)
    }
  })

  it('不把自己列为邻接', () => {
    for (const [region, adjacent] of Object.entries(REGION_ADJACENCY)) {
      expect(adjacent).not.toContain(region)
    }
  })

  it('邻接项无重复', () => {
    for (const [region, adjacent] of Object.entries(REGION_ADJACENCY)) {
      expect(new Set(adjacent).size, region).toBe(adjacent.length)
    }
  })
})
