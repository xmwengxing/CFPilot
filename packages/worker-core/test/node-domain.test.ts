import { describe, expect, it } from 'vitest'
import { normalizeNodeDomain } from '../src/routes/control'

/**
 * `DATA_HOST` / `subDomain` 会被原样用作订阅节点的 SNI / host。
 * 用户手填完整 URL 是真实发生过的坑，
 * 这里守住「进去的必须是裸域名」。
 */
describe('normalizeNodeDomain', () => {
  it('裸域名原样返回', () => {
    expect(normalizeNodeDomain('ck12akov.pages.dev')).toBe('ck12akov.pages.dev')
  })

  it('剥掉 https:// 前缀', () => {
    expect(normalizeNodeDomain('https://ck12akov.pages.dev')).toBe('ck12akov.pages.dev')
  })

  it('剥掉 http:// 前缀（大小写不敏感）', () => {
    expect(normalizeNodeDomain('HTTP://ck12akov.pages.dev')).toBe('ck12akov.pages.dev')
  })

  it('剥掉尾斜杠——用户手填 URL 的典型形态', () => {
    expect(normalizeNodeDomain('https://ck12akov.pages.dev/')).toBe('ck12akov.pages.dev')
  })

  it('剥掉路径 / query / hash', () => {
    expect(normalizeNodeDomain('https://ck12akov.pages.dev/sub?token=x#frag')).toBe('ck12akov.pages.dev')
  })

  it('剥掉端口', () => {
    expect(normalizeNodeDomain('ck12akov.pages.dev:8443')).toBe('ck12akov.pages.dev')
    expect(normalizeNodeDomain('https://ck12akov.pages.dev:443/')).toBe('ck12akov.pages.dev')
  })

  it('IPv6 带端口只去端口', () => {
    expect(normalizeNodeDomain('[2606:4700::1]:443')).toBe('2606:4700::1')
  })

  it('裸 IPv6 不动', () => {
    expect(normalizeNodeDomain('2606:4700::1')).toBe('2606:4700::1')
  })

  it('用户信息部分剥掉', () => {
    expect(normalizeNodeDomain('https://user@ck12akov.pages.dev/')).toBe('ck12akov.pages.dev')
  })

  it('空值安全', () => {
    expect(normalizeNodeDomain('')).toBe('')
    expect(normalizeNodeDomain('   ')).toBe('')
  })

  it('前后空白清理', () => {
    expect(normalizeNodeDomain('  ck12akov.pages.dev  ')).toBe('ck12akov.pages.dev')
  })
})
