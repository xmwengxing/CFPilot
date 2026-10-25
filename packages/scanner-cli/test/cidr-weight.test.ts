/**
 * 网段可用率权重 —— 回归测试。
 *
 * 守护 2026-10-25 真机定位的缺陷：
 * Cloudflare 的 IPv4 空间大部分是区域/租户专用分配，对普通站点没有配置。
 * 真机实测（101 校验，每段 12 IP）：6 个官方网段 0/12 完全不可用，
 * 而 104.16/13 是 8/12。
 *
 * 若按网段大小比例分配采样预算，一半以上候选会来自 0% 可用的网段 ——
 * 真机表现为「阶段一过后只剩零星候选、阶段二全军覆没、优选 0 条」。
 *
 * 修复：预算按「大小 × 可用率权重」分配，0 权重的网段彻底不采。
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_IPV4_CIDRS,
  IPV4_CIDR_WEIGHTS,
  DEFAULT_CIDR_WEIGHT,
  cidrWeight,
  expandCidrs,
} from '../src/ip-ranges'

describe('cidrWeight：可用率权重查询', () => {
  it('精确匹配优先', () => {
    expect(cidrWeight('104.16.0.0/13')).toBe(1.0)
    expect(cidrWeight('104.24.0.0/14')).toBe(0.9)
    expect(cidrWeight('173.245.48.0/20')).toBe(0)
  })

  it('最长前缀匹配：细粒度覆盖粗粒度', () => {
    // 104.16.0.0/24 被表中的 104.16.0.0/13 覆盖 → 继承 1.0
    expect(cidrWeight('104.16.0.0/24')).toBe(1.0)
    // 162.159.0.0/16 显式给低权重，即使它被 162.158.0.0/15 覆盖
    expect(cidrWeight('162.159.0.0/16')).toBe(0.05)
  })

  it('未列入的网段用默认权重', () => {
    expect(cidrWeight('8.8.8.0/24')).toBe(DEFAULT_CIDR_WEIGHT)
    expect(cidrWeight('1.2.3.0/24')).toBe(DEFAULT_CIDR_WEIGHT)
  })

  it('IPv6 网段不加权（无实测数据），返回默认值', () => {
    expect(cidrWeight('2606:4700::/32')).toBe(DEFAULT_CIDR_WEIGHT)
  })

  it('非 IPv4 前缀（0/33）不崩溃', () => {
    expect(typeof cidrWeight('300.0.0.0/33')).toBe('number')
  })
})

describe('权重表自身的一致性', () => {
  it('所有权重都在 0~1 之间', () => {
    for (const [cidr, w] of Object.entries(IPV4_CIDR_WEIGHTS)) {
      expect(w, cidr).toBeGreaterThanOrEqual(0)
      expect(w, cidr).toBeLessThanOrEqual(1)
    }
  })

  it('162.159（管理/API 网段）必须是低权重而非 0', () => {
    // 真机实测：162.159.x.x 多数返回 HTTP 403，但**并非全部** ——
    // 用户实测 162.159.237.59 可用（2.8 MB/s），本地复测同样通过（SJC）。
    // 压到 0 会错杀可用 IP，因此给很低的权重（仍能采到少量候选）。
    const w = IPV4_CIDR_WEIGHTS['162.159.0.0/16']
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThan(0.1)
  })

  it('实测 0/12 的网段必须都是 0 权重', () => {
    const deadOnArrival = [
      '173.245.48.0/20',
      '103.22.200.0/22',
      '108.162.192.0/18',
      '197.234.240.0/22',
      '198.41.128.0/17',
      '131.0.72.0/22',
    ]
    for (const cidr of deadOnArrival) {
      expect(IPV4_CIDR_WEIGHTS[cidr], cidr).toBe(0)
    }
  })
})

describe('expandCidrs：按可用率加权分配', () => {
  it('0 权重的网段完全不采样', () => {
    // 只给两个网段：一个高权重、一个 0 权重
    const out = expandCidrs(['104.16.0.0/13', '173.245.48.0/20'], { sample: 500, seed: 24301 })
    expect(out.length).toBeGreaterThan(0)
    // 173.245.x 一个都不该出现
    expect(out.some((ip) => ip.startsWith('173.245.'))).toBe(false)
    // 104.16.x 应该有
    expect(out.some((ip) => ip.startsWith('104.16.'))).toBe(true)
  })

  it('高权重网段拿到更多候选', () => {
    const out = expandCidrs(BUILTIN_IPV4_CIDRS, { sample: 2000, seed: 24301 })
    const count = (prefix: string): number => out.filter((ip) => ip.startsWith(prefix)).length
    // 104.16~104.23（权重 1.0）应远多于 172.64（权重 0.1）
    const high = count('104.16.') + count('104.17.') + count('104.18.')
    const low = count('172.64.')
    expect(high).toBeGreaterThan(low * 3)
  })

  it('所有权重为 0 时退化为按大小分配（不返回空）', () => {
    // 构造一个全 0 权重的场景：用两个死网段
    const out = expandCidrs(['173.245.48.0/20', '198.41.128.0/17'], { sample: 100, seed: 24301 })
    // 退化逻辑保证不卡死用户：仍有候选产出
    expect(out.length).toBeGreaterThan(0)
  })

  it('单个可用网段时正常采样', () => {
    const out = expandCidrs(['104.16.0.0/13'], { sample: 100, seed: 24301 })
    expect(out.length).toBeGreaterThan(50)
    expect(out.every((ip) => ip.startsWith('104.1') || ip.startsWith('104.2'))).toBe(true)
  })
})

describe('跨权重区网段拆分（splitByWeight）', () => {
  it('162.158.0.0/15 拆成两半，权重各按自己的算', () => {
    // 官方返回的 /15 横跨两个权重区：162.158（0.2）与 162.159（0.05）。
    // 若不拆，均匀采样会让低权重区拿到与高权重区相同的候选数。
    const out = expandCidrs(['162.158.0.0/15'], { sample: 400, seed: 24301 })
    const n158 = out.filter((ip) => ip.startsWith('162.158')).length
    const n159 = out.filter((ip) => ip.startsWith('162.159')).length
    // 162.158 应明显多于 162.159（权重 0.2 vs 0.05，期望 4:1）
    expect(n158).toBeGreaterThan(n159 * 2)
    // 但 162.159 不该被完全排除（不错杀可用 IP，如用户实测的 162.159.237.59）
    expect(n159).toBeGreaterThan(0)
  })

  it('单权重区网段不拆（保持原样）', () => {
    const out = expandCidrs(['104.16.0.0/13'], { sample: 100, seed: 24301 })
    expect(
      out.every((ip) => {
        const o = ip.split('.').map(Number)
        return o[0] === 104 && o[1]! >= 16 && o[1]! <= 23
      })
    ).toBe(true)
  })

  it('低权重网段的保底数也随权重缩放（不被 minPerCidr 抬平）', () => {
    // 真机缺陷：minPerCidr=64 让 0.05 权重的 162.159 拿到与 1.0 权重相同的
    // 保底数，加权白做。缩放后低权重网段只留几个探针。
    const out = expandCidrs(BUILTIN_IPV4_CIDRS, { sample: 3000, seed: 24301 })
    const count = (p: string): number => out.filter((ip) => ip.startsWith(p)).length
    expect(count('104.16.')).toBeGreaterThan(count('162.159.') * 10)
  })
})
