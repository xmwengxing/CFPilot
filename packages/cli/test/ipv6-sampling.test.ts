import { describe, expect, it } from 'vitest'
import {
  IPV6_ACTIVE_PREFIXES,
  IPV6_DEAD_PREFIXES,
  cidrWeight,
  expandCidrs,
  makeWeightFn,
} from '../src/scan/ip-ranges'
import { networkBucket } from '../src/scan/network-profile'

describe('IPv6 网段权重表', () => {
  it('活跃 /48 权重 > 0，死段与未知段权重为 0', () => {
    expect(cidrWeight('2606:4700:3035::/48')).toBeGreaterThan(0)
    expect(cidrWeight('2606:4700:3030::/48')).toBeGreaterThan(0)
    // 2400:cb00:2048 实测 0/4 超时；2400:cb00:2049 TCP/TLS 通但 WS101 回 403
    expect(cidrWeight('2400:cb00:2048::/48')).toBe(0)
    expect(cidrWeight('2400:cb00:2049::/48')).toBe(0)
    // 没实测过的一律不采（默认 0，与 IPv4 的 0.2 相反）
    expect(cidrWeight('2606:4700:beef::/48')).toBe(0)
  })

  it('活跃 /48 内的更细前缀继承权重（最长前缀匹配按 128 位右移）', () => {
    expect(cidrWeight('2606:4700:3035:1234::/64')).toBe(cidrWeight('2606:4700:3035::/48'))
    expect(cidrWeight('2606:4700:3035:1234::1/128')).toBe(cidrWeight('2606:4700:3035::/48'))
  })

  it('IPv4 权重行为保持不变（默认 0.2，精确匹配优先）', () => {
    expect(cidrWeight('104.16.0.0/13')).toBe(0.9)
    expect(cidrWeight('103.22.200.0/22')).toBe(0)
    expect(cidrWeight('1.2.3.0/24')).toBe(0.2)
    // 跨权重区网段的最长前缀匹配
    expect(cidrWeight('162.158.0.0/15')).toBe(0.2)
    expect(cidrWeight('162.158.1.0/24')).toBe(0.3)
  })

  it('活跃段与死段清单由权重表派生，二者不相交', () => {
    expect(IPV6_ACTIVE_PREFIXES.length).toBeGreaterThan(0)
    expect(IPV6_DEAD_PREFIXES.length).toBeGreaterThan(0)
    for (const cidr of IPV6_ACTIVE_PREFIXES) expect(cidrWeight(cidr)).toBeGreaterThan(0)
    for (const cidr of IPV6_DEAD_PREFIXES) expect(cidrWeight(cidr)).toBe(0)
    expect(IPV6_ACTIVE_PREFIXES.filter((c) => IPV6_DEAD_PREFIXES.includes(c))).toEqual([])
  })
})

describe('IPv6 采样只落在活跃 /48 内', () => {
  it('在公布聚合段里采样，结果全部落在活跃 /48 内', () => {
    const out = expandCidrs(['2606:4700::/32'], { sample: 200, seed: 7 })
    expect(out.length).toBeGreaterThan(0)
    for (const ip of out) {
      expect(IPV6_ACTIVE_PREFIXES).toContain(networkBucket(ip))
    }
  })

  it('完全未知的段不产出任何候选（不再按原始大小兜底）', () => {
    // ⚠️ 必须用 /48：`2606:4700:beef::/32` 会被解析成 `2606:4700::/32`
    //   （/32 只看前 32 位），那样反而覆盖了活跃段。
    expect(expandCidrs(['2606:4700:beef::/48'], { sample: 100, seed: 1 })).toEqual([])
  })

  it('实测死段不产出候选', () => {
    expect(expandCidrs(['2400:cb00:2048::/48'], { sample: 100, seed: 1 })).toEqual([])
    expect(expandCidrs(['2400:cb00:2049::/48'], { sample: 100, seed: 1 })).toEqual([])
  })

  it('整段公布网段里一个活跃前缀都没有时，v6 一个候选都不出', () => {
    // 2c0f:f248::/32 是官方公布段，但本机实测没有任何已知活跃 /48 落在里面
    expect(expandCidrs(['2c0f:f248::/32'], { sample: 100, seed: 1 })).toEqual([])
  })

  it('同种子结果可复现', () => {
    const a = expandCidrs(['2606:4700::/32'], { sample: 50, seed: 99 })
    const b = expandCidrs(['2606:4700::/32'], { sample: 50, seed: 99 })
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('候选不重复', () => {
    const out = expandCidrs(['2606:4700::/32', '2a06:98c1::/29'], { sample: 300, seed: 11 })
    expect(new Set(out).size).toBe(out.length)
  })

  it('运行期发现的活跃前缀（AAAA 展开）能参与采样', () => {
    const unknown = '2606:4700:beef::/48'
    expect(expandCidrs([unknown], { sample: 10, seed: 1 })).toEqual([])

    const out = expandCidrs([unknown], { sample: 10, seed: 1, extraWeights: { [unknown]: 1 } })
    expect(out.length).toBeGreaterThan(0)
    for (const ip of out) expect(networkBucket(ip)).toBe(unknown)
  })

  /**
   * 修掉一个预算泄漏：IPv6 权重表默认 0，公布段里的死 /48 会留在待采样列表里。
   * 若按「存在另一族就算混合」来分预算，v4 会白白只拿一半 —— 而那些死段一个候选都产不出来。
   */
  it('v6 全是死段时，v4 仍拿到完整预算', () => {
    const v4only = expandCidrs(['104.16.1.0/24'], { sample: 100, seed: 5 })
    // 2c0f:f248::/32 是公布段但无任何已知活跃前缀 → 一个候选都产不出来
    const withDeadV6 = expandCidrs(['104.16.1.0/24', '2c0f:f248::/32'], { sample: 100, seed: 5 })
    expect(v4only.length).toBe(100)
    expect(withDeadV6.length).toBe(v4only.length)
    expect(withDeadV6.every((ip) => !ip.includes(':'))).toBe(true)
  })

  it('两族都有可用段时，各拿一半预算', () => {
    const out = expandCidrs(['104.16.1.0/24', '2606:4700:3035::/48'], { sample: 100, seed: 5 })
    const v6 = out.filter((ip) => ip.includes(':'))
    const v4 = out.filter((ip) => !ip.includes(':'))
    expect(v6.length).toBeGreaterThan(0)
    expect(v4.length).toBeGreaterThan(0)
    expect(Math.abs(v6.length - v4.length)).toBeLessThanOrEqual(2)
  })

  it('中性采样同样只放行权重非 0 的段', () => {
    const out = expandCidrs(['2606:4700:beef::/48'], { sample: 100, seed: 1, neutral: true })
    expect(out).toEqual([])
  })

  it('makeWeightFn 在没有额外前缀时等价于 cidrWeight', () => {
    expect(makeWeightFn()('104.16.0.0/13')).toBe(cidrWeight('104.16.0.0/13'))
    expect(makeWeightFn({})('2606:4700:3035::/48')).toBe(cidrWeight('2606:4700:3035::/48'))
  })

  it('makeWeightFn 的额外前缀对 IPv4 不生效', () => {
    const fn = makeWeightFn({ '104.16.1.0/24': 1 })
    expect(fn('104.16.1.0/24')).toBe(cidrWeight('104.16.1.0/24'))
    expect(fn('2606:4700:beef::/48')).toBe(0)
  })
})
