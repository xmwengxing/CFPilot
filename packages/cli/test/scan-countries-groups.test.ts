/**
 * 机房国家的分组筛选（取消选择 / 亚洲组 / 美国组）。
 *
 * ## 这组测试在防什么
 *
 * 分组表在 CLI（countries.ts）与 Go 版（countries.go）各有一份，
 * 界面按钮又直接按展开后的机房码选中。任何一边漂移，
 * 用户点「亚洲组」选到的国家集合就不一样 —— 属于静默的行为不一致。
 */
import { describe, expect, it } from 'vitest'
import {
  COUNTRY_COLOS,
  REGION_GROUPS,
  REGION_GROUP_NAMES,
  SUPPORTED_COUNTRIES,
  countryOfColo,
  isRegionGroup,
  normalizeCountryFilter,
} from '../src/scan/countries'

describe('分组关键字', () => {
  it('ASIA / US 被识别为分组，国家码不是分组', () => {
    expect(isRegionGroup('ASIA')).toBe(true)
    expect(isRegionGroup('asia')).toBe(true)
    expect(isRegionGroup('US')).toBe(true)
    expect(isRegionGroup('JP')).toBe(false)
    expect(isRegionGroup('')).toBe(false)
  })

  it('分组名与界面按钮文案一致', () => {
    expect(REGION_GROUP_NAMES.ASIA).toBe('亚洲组')
    expect(REGION_GROUP_NAMES.US).toBe('美国组')
  })

  it('分组里只放国家代码（机房码由 COUNTRY_COLOS 展开，避免两份机房表）', () => {
    for (const countries of Object.values(REGION_GROUPS)) {
      for (const country of countries) {
        expect(SUPPORTED_COUNTRIES).toContain(country)
        expect(COUNTRY_COLOS[country]?.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('normalizeCountryFilter 展开分组', () => {
  const asia = REGION_GROUPS.ASIA ?? []

  it('ASIA 展开成全部亚洲国家', () => {
    const out = normalizeCountryFilter(['ASIA'])
    // 东亚 / 东南亚 / 南亚 / 西亚
    expect(out).toEqual(
      expect.arrayContaining(['HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'ID', 'PH', 'IN', 'AE', 'IL'])
    )
    expect(out).toHaveLength(asia.length)
  })

  it('ASIA 不含大洋洲，也不含横跨欧亚的 TR / RU 与美国', () => {
    const out = normalizeCountryFilter(['ASIA'])
    for (const notAsia of ['AU', 'NZ', 'TR', 'RU', 'US']) {
      expect(out).not.toContain(notAsia)
    }
  })

  it('US 组就是美国（与 --countries US 等价）', () => {
    expect(normalizeCountryFilter(['US'])).toEqual(['US'])
    expect(normalizeCountryFilter(['USGROUP'])).toEqual([]) // 非法码仍被丢弃
  })

  it('两个分组可以都选', () => {
    const out = normalizeCountryFilter(['ASIA', 'US'])
    expect(out).toContain('HK')
    expect(out).toContain('US')
    expect(out).toHaveLength(asia.length + 1)
  })

  it('分组与国家码混写时去重', () => {
    const out = normalizeCountryFilter(['ASIA', 'HK', 'asia'])
    expect(out.filter((c) => c === 'HK')).toHaveLength(1)
  })

  it('不选 = 全部：空输入与非法输入都返回空数组', () => {
    expect(normalizeCountryFilter([])).toEqual([])
    expect(normalizeCountryFilter(undefined)).toEqual([])
    expect(normalizeCountryFilter(['NOPE', ''])).toEqual([])
  })

  it('机房三字码归一成国家码（与 Go 版选择单位一致）', () => {
    // 同国家的多个机房只留一个国家码
    expect(normalizeCountryFilter(['HKG'])).toEqual(['HK'])
    expect(normalizeCountryFilter(['NRT', 'KIX'])).toEqual(['JP'])
    // 与国家码 / 分组混写时去重
    expect(normalizeCountryFilter(['ASIA', 'SIN', 'SG'])).toEqual(normalizeCountryFilter(['ASIA']))
    // 未知三字码仍被丢弃，不能因为长度像机房码就放过
    expect(normalizeCountryFilter(['ZZZ'])).toEqual([])
  })

  it('展开出的国家都有机房码，且机房码能映射回该国家', () => {
    for (const countries of Object.values(REGION_GROUPS)) {
      for (const country of countries) {
        const colos = COUNTRY_COLOS[country] ?? []
        expect(colos.length).toBeGreaterThan(0)
        for (const colo of colos) expect(countryOfColo(colo)).toBe(country)
      }
    }
  })
})
