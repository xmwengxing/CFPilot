/**
 * 订阅格式识别与 Clash YAML 兼容性测试。
 *
 * ## 为什么要按 User-Agent 识别
 *
 * 客户端导入订阅时**只给订阅 URL，不会加 `?target=clash`**，
 * 而是靠自己的 User-Agent 表明身份：
 *   - Clash Verge / Clash / mihomo → `clash-verge/…`、`ClashforWindows/…`
 *   - sing-box → `sing-box/…`
 *   - v2rayN / Shadowrocket 等 → `v2rayNG/…`
 *
 * 只认 URL 参数的话，Clash Verge 导入拿到的是 base64 分享链接集合，
 * 按 YAML 解析必然失败 —— 表现为「浏览器里能读到 YAML 文本，
 * 但 Clash Verge 导入报错」。
 */
import { describe, expect, it } from 'vitest'
import { resolveFormat, resolveFormatByUserAgent } from '../src/routes/shared'

describe('订阅格式：按 User-Agent 识别', () => {
  it('Clash Verge / mihomo 系识别为 clash', () => {
    const uas = [
      'clash-verge/v1.6.6',
      'clash-verge/v2.0.0',
      'ClashforWindows/0.20.39',
      'ClashX/1.0.0',
      'mihomo/1.18.0',
      'FlClash/v0.8.80',
      'Stash/2.5.0 Clash',
    ]
    for (const ua of uas) {
      expect(resolveFormatByUserAgent(ua), ua).toBe('clash')
    }
  })

  it('sing-box 识别为 singbox', () => {
    expect(resolveFormatByUserAgent('sing-box 1.11.0')).toBe('singbox')
    expect(resolveFormatByUserAgent('SFA/1.0.0 sing-box')).toBe('singbox')
  })

  it('传统分享链接客户端识别为 base64', () => {
    for (const ua of ['v2rayNG/1.8.5', 'Shadowrocket/1993 CFNetwork', 'NekoBox/1.0', 'Surge/2726']) {
      expect(resolveFormatByUserAgent(ua), ua).toBe('base64')
    }
  })

  it('无法识别时返回 null（不猜）', () => {
    expect(resolveFormatByUserAgent('')).toBeNull()
    expect(resolveFormatByUserAgent(null)).toBeNull()
    expect(resolveFormatByUserAgent('Mozilla/5.0 (Windows NT 10.0)')).toBeNull()
  })

  it('显式 URL 参数仍然优先，语义不变', () => {
    expect(resolveFormat('clash')).toBe('clash')
    expect(resolveFormat('mihomo')).toBe('clash')
    expect(resolveFormat('yaml')).toBe('clash')
    expect(resolveFormat('singbox')).toBe('singbox')
    expect(resolveFormat('sing-box')).toBe('singbox')
    expect(resolveFormat('json')).toBe('singbox')
    expect(resolveFormat('v2ray')).toBe('v2ray')
    expect(resolveFormat('base64')).toBe('base64')
    expect(resolveFormat(null)).toBe('base64')
    expect(resolveFormat('乱写')).toBe('base64')
  })
})
