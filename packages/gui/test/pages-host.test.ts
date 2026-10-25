/**
 * Pages 域名规整 —— 回归测试。
 *
 * 守护 2026-10-25 用户反馈的真 bug：
 * 「自动识别域名」在未绑定自定义域名时填出了 `cpdata.pages.dev.pages.dev`（双后缀）。
 *
 * 根因：Cloudflare API 的 `project.subdomain` 有时返回纯名字（`cpdata`），
 * 有时已经带后缀（`cpdata.pages.dev`）。老代码无条件拼 `.pages.dev`，
 * 遇到后者就变成双后缀 —— 这个域名不存在，拿去优选必然全部失败。
 */
import { describe, expect, it } from 'vitest'
import { normalizePagesHost } from '../src/main/pages-host'

describe('normalizePagesHost：Pages 域名规整', () => {
  it('纯项目名补一个后缀', () => {
    expect(normalizePagesHost('cpdata')).toBe('cpdata.pages.dev')
  })

  it('已带后缀的不重复拼（真 bug 回归）', () => {
    expect(normalizePagesHost('cpdata.pages.dev')).toBe('cpdata.pages.dev')
  })

  it('双后缀被修正为单后缀', () => {
    expect(normalizePagesHost('cpdata.pages.dev.pages.dev')).toBe('cpdata.pages.dev')
  })

  it('三重后缀也能修正', () => {
    expect(normalizePagesHost('a.pages.dev.pages.dev.pages.dev')).toBe('a.pages.dev')
  })

  it('去掉协议前缀', () => {
    expect(normalizePagesHost('https://cpdata.pages.dev')).toBe('cpdata.pages.dev')
    expect(normalizePagesHost('http://cpdata')).toBe('cpdata.pages.dev')
  })

  it('去掉尾部斜杠', () => {
    expect(normalizePagesHost('cpdata/')).toBe('cpdata.pages.dev')
    expect(normalizePagesHost('cpdata.pages.dev/')).toBe('cpdata.pages.dev')
  })

  it('大小写归一为小写', () => {
    expect(normalizePagesHost('CPData.PAGES.DEV')).toBe('cpdata.pages.dev')
  })

  it('前后空白被裁掉', () => {
    expect(normalizePagesHost('  cpdata.pages.dev  ')).toBe('cpdata.pages.dev')
  })

  it('空输入返回空串', () => {
    expect(normalizePagesHost('')).toBe('')
    expect(normalizePagesHost(undefined)).toBe('')
    expect(normalizePagesHost(null)).toBe('')
    expect(normalizePagesHost('   ')).toBe('')
  })

  it('只有后缀没有名字时返回空串（避免产出 .pages.dev）', () => {
    expect(normalizePagesHost('.pages.dev')).toBe('')
  })

  it('带连字符的项目名正常', () => {
    expect(normalizePagesHost('cfpilot-dp-rnjw')).toBe('cfpilot-dp-rnjw.pages.dev')
  })
})
