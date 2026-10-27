import { describe, it, expect } from 'vitest'
import { compareSemver, parseVersion } from '../src/shared/version-util'

describe('compareSemver', () => {
  it('相等的版本返回 0', () => {
    expect(compareSemver('0.7.6', '0.7.6')).toBe(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('主版本不同：大的更大', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareSemver('0.9.9', '1.0.0')).toBeLessThan(0)
  })

  it('次版本不同：大的更大', () => {
    expect(compareSemver('0.8.0', '0.7.9')).toBeGreaterThan(0)
    expect(compareSemver('0.7.9', '0.8.0')).toBeLessThan(0)
  })

  it('修订号不同：大的更大', () => {
    expect(compareSemver('0.7.10', '0.7.9')).toBeGreaterThan(0)
    expect(compareSemver('0.7.9', '0.7.10')).toBeLessThan(0)
  })

  it('接受 v 前缀（tag 形态）', () => {
    expect(compareSemver('v0.7.6', '0.7.6')).toBe(0)
    expect(compareSemver('v0.7.7', 'v0.7.6')).toBeGreaterThan(0)
  })

  it('缺省段按 0 处理：0.7 等价于 0.7.0', () => {
    expect(compareSemver('0.7', '0.7.0')).toBe(0)
    expect(compareSemver('1', '1.0.0')).toBe(0)
  })

  it('构建元数据（+xxx）不影响优先级', () => {
    expect(compareSemver('0.7.6+20261028', '0.7.6')).toBe(0)
    expect(compareSemver('0.7.6+build1', '0.7.6+build2')).toBe(0)
  })

  it('预发布版本旧于同号正式版', () => {
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0)
  })

  it('预发布版本之间按标识逐段比较', () => {
    expect(compareSemver('1.0.0-rc2', '1.0.0-rc1')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-beta', '1.0.0-rc1')).toBeLessThan(0)
    // 标识更多的更新：1.0.0-rc.1 > 1.0.0-rc
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc')).toBeGreaterThan(0)
  })

  it('纯数字标识优先级低于字母数字标识', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareSemver('1.0.0-2', '1.0.0-1')).toBeGreaterThan(0)
  })

  it('解析不出来的一方视为更旧', () => {
    // a 解析不出、b 能解析 → a 更旧
    expect(compareSemver('abc', '1.0.0')).toBeLessThan(0)
    // a 能解析、b 解析不出 → a 更新
    expect(compareSemver('1.0.0', 'abc')).toBeGreaterThan(0)
  })

  it('两边都解析不出来时返回 0', () => {
    expect(compareSemver('', '')).toBe(0)
    expect(compareSemver('abc', 'def')).toBe(0)
    expect(compareSemver('   ', 'not-a-version')).toBe(0)
  })

  it('空串算解析不出来', () => {
    expect(compareSemver('', '0.0.1')).toBeLessThan(0)
  })

  it('尾部有非法字符算解析不出来', () => {
    expect(compareSemver('0.7.6abc', '0.7.6')).toBeLessThan(0)
  })
})

describe('parseVersion', () => {
  it('解析出三段数字', () => {
    expect(parseVersion('0.7.6')).toEqual({
      major: 0,
      minor: 7,
      patch: 6,
      prerelease: [],
    })
  })

  it('缺省段按 0 处理', () => {
    expect(parseVersion('1.2')).toEqual({
      major: 1,
      minor: 2,
      patch: 0,
      prerelease: [],
    })
    expect(parseVersion('1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: [],
    })
  })

  it('解析预发布标识', () => {
    expect(parseVersion('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1'])
  })

  it('解析不出来时返回 null', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('0.7.6abc')).toBeNull()
  })
})
