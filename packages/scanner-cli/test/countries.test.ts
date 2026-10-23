import { describe, expect, it } from 'vitest'
import { COUNTRY_COLOS, countryOfColo, isKnownCountry, normalizeCountryFilter, SUPPORTED_COUNTRIES } from '../src/countries'

describe('countryOfColo', () => {
  it('映射已知机房', () => {
    expect(countryOfColo('HKG')).toBe('HK')
    expect(countryOfColo('LAX')).toBe('US')
    expect(countryOfColo('FRA')).toBe('DE')
  })

  it('大小写不敏感', () => {
    expect(countryOfColo('hkg')).toBe('HK')
  })

  it('未知机房返回空串', () => {
    expect(countryOfColo('UNK')).toBe('')
    expect(countryOfColo('')).toBe('')
  })
})

describe('isKnownCountry', () => {
  it('识别受支持的国家', () => {
    expect(isKnownCountry('HK')).toBe(true)
    expect(isKnownCountry('us')).toBe(true)
    expect(isKnownCountry('ZZ')).toBe(false)
  })
})

describe('SUPPORTED_COUNTRIES', () => {
  it('与 COUNTRY_COLOS 键一致且非空', () => {
    expect(SUPPORTED_COUNTRIES.length).toBe(Object.keys(COUNTRY_COLOS).length)
    expect(SUPPORTED_COUNTRIES.length).toBeGreaterThan(20)
  })
})

describe('normalizeCountryFilter', () => {
  it('大写、去重、丢弃无效代码', () => {
    expect(normalizeCountryFilter(['hk', 'HK', 'jp', 'ZZ', ''])).toEqual(['HK', 'JP'])
  })

  it('空输入得到空列表', () => {
    expect(normalizeCountryFilter([])).toEqual([])
    expect(normalizeCountryFilter(undefined as unknown as string[])).toEqual([])
  })
})
