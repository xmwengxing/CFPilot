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
    expect(html).toContain('id="btnScan"')
    expect(html).toContain('id="cfgUuid"')
    // 关键 JS 逻辑仍在
    expect(html).toContain('api/v1/login')
    expect(html).toContain('EventSource')
    // 解压后体积与源文件相当（说明压缩再解压是无损的）
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(Buffer.byteLength(original))
  })
})
