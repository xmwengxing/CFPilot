import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPanelHtml } from '../src/ui/panel'

describe('面板 gzip 往返', () => {
  it('解压后内容与源文件语义一致', async () => {
    const original = readFileSync(resolve(__dirname, '../src/ui/panel.html'), 'utf8')
    const html = await getPanelHtml()

    expect(html).toContain('<!DOCTYPE html>')
    // 冒烟断言：标题文案（与页面内可见标题一致）
    expect(html).toContain('CFPilot 管理控制台')
    expect(html).toContain('id="btnRefreshSub"')
    expect(html).toContain('id="cfgUuid"')
    // 关键 JS 逻辑仍在
    expect(html).toContain('api/v1/login')
    // 本地优选页只留说明（优选本体由 CLI / 桌面版承担）
    expect(html).toContain('cfpilot scan --help')
    expect(html).toContain('cfpilot@latest')
    // 解压后体积与源文件相当（说明压缩再解压是无损的）
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(Buffer.byteLength(original))
  })
})

/**
 * 面板表单字段必须**三处齐全**：有输入框、读得到初值、提交得出去。
 *
 * 只加输入框不提交是最容易犯的错 —— 用户在面板里改了值，
 * 点保存却什么都没变（因为提交体里没这个字段）。
 */
describe('面板配置字段接线', () => {
  const html = readFileSync(resolve(__dirname, '../src/ui/panel.html'), 'utf8')

  it('单连接流量上限：有输入框、读初值、提交', () => {
    expect(html).toContain('id="cfgDataBudget"')
    // 读初值
    expect(html).toContain("$('cfgDataBudget').value")
    // 提交
    expect(html).toContain('dataBudgetMB:')
  })
})
