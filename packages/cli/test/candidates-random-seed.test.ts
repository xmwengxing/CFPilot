/**
 * 候选采样的「每次不同」——回归测试。
 *
 * ## 真实问题（2026-10-28 用户报「怎么测都慢」）
 *
 * `--seed` 的默认值曾写死 `24301`，而采样是确定性的（mulberry32）：
 * **只要 `--sample` 不变，每次运行得到的候选 IP 列表 100% 一模一样**。
 * 抽到的那批 IP 恰好落在本地运营商的劣质路由段上时，
 * 重跑一百次、换多少时间段，测出来的永远是同一批慢 IP ——
 * 用户只会得出「优选出来的都慢」的结论，实际是样本池僵死。
 *
 * 现在：不传 seed → 每次随机（`randomSeed()`）；传了就固定、可复现。
 */
import { describe, expect, it } from 'vitest'
import { expandCidrs, IPV4_CIDR_WEIGHTS, BUILTIN_IPV4_CIDRS, cidrWeight } from '../src/scan/ip-ranges'
import { randomSeed } from '../src/scan/candidates'

describe('随机种子', () => {
  it('randomSeed 每次都不同且是合法 uint32', () => {
    const seeds = new Set<number>()
    for (let i = 0; i < 20; i++) {
      const s = randomSeed()
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(2 ** 32)
      seeds.add(s)
    }
    // 20 次里不允许出现大量重复（碰撞概率极低）
    expect(seeds.size).toBeGreaterThan(15)
  })

  it('不同种子 → 不同候选列表（样本池不再僵死）', () => {
    const a = expandCidrs(['104.16.0.0/13'], { sample: 200, seed: 111 })
    const b = expandCidrs(['104.16.0.0/13'], { sample: 200, seed: 222 })
    expect(a.length).toBe(b.length)
    const overlap = a.filter((ip) => b.includes(ip)).length
    // 200 个样本从 52 万地址里抽，重叠应当极少（远小于一半）
    expect(overlap).toBeLessThan(20)
  })

  it('相同种子 → 结果完全一致（可复现性不能丢）', () => {
    const a = expandCidrs(['104.16.0.0/13'], { sample: 200, seed: 24301 })
    const b = expandCidrs(['104.16.0.0/13'], { sample: 200, seed: 24301 })
    expect(a).toEqual(b)
  })
})

describe('网段权重表（2026-10-28 复测后）', () => {
  it('复测发现被低估的两段必须有权重（不能压到 0）', () => {
    // 188.114.96.0/20 复测 9/12、172.64.0.0/13 复测 5/12 —— 旧表给 0.3 / 0.1
    expect(cidrWeight('188.114.96.0/20')).toBeGreaterThanOrEqual(0.5)
    expect(cidrWeight('172.64.0.0/13')).toBeGreaterThanOrEqual(0.3)
  })

  it('TCP 层不可达的网段保持 0（不浪费采样预算）', () => {
    for (const cidr of ['103.22.200.0/22', '197.234.240.0/22', '198.41.128.0/17', '131.0.72.0/22', '108.162.192.0/18']) {
      expect(cidrWeight(cidr)).toBe(0)
    }
  })

  it('权重都在 [0,1] 且内置网段都能查到（最长前缀匹配生效）', () => {
    for (const [cidr, w] of Object.entries(IPV4_CIDR_WEIGHTS)) {
      expect(w).toBeGreaterThanOrEqual(0)
      expect(w).toBeLessThanOrEqual(1)
      expect(cidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
    }
    for (const cidr of BUILTIN_IPV4_CIDRS) {
      expect(typeof cidrWeight(cidr)).toBe('number')
    }
  })

  it('/16 子段能命中更具体的 /16 规则（162.158 vs 162.159 不同权重）', () => {
    expect(cidrWeight('162.158.0.0/16')).toBeGreaterThan(cidrWeight('162.159.0.0/16'))
  })
})
