/**
 * 订阅名下发格式 —— 回归测试。
 *
 * ## 真实报障（2026-10-28）
 *
 * 用户把 Clash 订阅加进客户端后，卡片名显示成 `\"CFPilot\`（带引号与反斜杠）。
 * 根因是 `Content-Disposition: inline; filename="CFPilot"` 里的**引号被客户端原样保留**，
 * 名称里若再含 `/`、`|` 之类字符，有的客户端还会二次截断。
 *
 * 修法三条：
 *   1. 名称里禁止出现任何 URL / 路径 / 响应头分隔符（`sanitizeSubName`）；
 *   2. 纯 ASCII token 的名称**不加引号**下发，并额外给 RFC 5987 的 `filename*=`；
 *   3. `Profile-Title` 非 ASCII 时按 RFC 2047 编码。
 */
import { describe, expect, it } from 'vitest'
import {
  rfc5987Encode,
  sanitizeSubName,
  subContentDisposition,
  subProfileTitle,
} from '../src/sub-engine'

describe('sanitizeSubName', () => {
  it('剔除引号 / 反斜杠 / 斜杠 / 管道符等分隔符', () => {
    expect(sanitizeSubName('CFPilot')).toBe('CFPilot')
    expect(sanitizeSubName('"CFPilot"')).toBe('CFPilot')
    expect(sanitizeSubName('\\"CFPilot\\')).toBe('CFPilot')
    expect(sanitizeSubName('CFPilot/优选|节点')).toBe('CFPilot优选节点')
    expect(sanitizeSubName('a;b:c&d?e#f%g')).toBe('abcdefg')
  })

  it('压缩空白、去控制字符、空值回落 CFPilot', () => {
    expect(sanitizeSubName('  CFPilot   Pro  ')).toBe('CFPilot Pro')
    expect(sanitizeSubName('\u0000\u0007')).toBe('CFPilot')
    expect(sanitizeSubName('')).toBe('CFPilot')
    expect(sanitizeSubName('   ')).toBe('CFPilot')
  })

  it('限长 64 且不留下尾部空格', () => {
    const long = 'A'.repeat(80)
    expect(sanitizeSubName(long).length).toBe(64)
    expect(sanitizeSubName(`${'A'.repeat(63)} `).length).toBe(63)
  })
})

describe('subContentDisposition', () => {
  it('纯 ASCII token 名称不带引号（客户端不会把引号当名字）', () => {
    const value = subContentDisposition('CFPilot')
    expect(value).toBe("inline; filename=CFPilot; filename*=UTF-8''CFPilot")
    expect(value.includes('"')).toBe(false)
  })

  it('含空格的名称用引号包裹，同时提供 RFC 5987 变体', () => {
    const value = subContentDisposition('CFPilot Pro')
    expect(value.startsWith('inline; filename="CFPilot Pro"; filename*=UTF-8\'\'')).toBe(true)
    expect(value).toContain('CFPilot%20Pro')
  })

  it('中文名百分号编码，且 filename= 里不再出现原始中文（避免响应头非 ASCII）', () => {
    const value = subContentDisposition('优选节点')
    expect(value).toContain("filename*=UTF-8''")
    expect(value).toContain(rfc5987Encode('优选节点'))
    expect(value.includes('优选节点')).toBe(false)
  })

  it('用户输入的引号/斜杠不会穿透到响应头', () => {
    const value = subContentDisposition('"CFPilot"/x')
    expect(value.includes('"/x"')).toBe(false)
    expect(value).toContain('CFPilotx')
  })
})

describe('subProfileTitle', () => {
  it('纯 ASCII 原样返回', () => {
    expect(subProfileTitle('CFPilot')).toBe('CFPilot')
  })

  it('含中文时按 RFC 2047 Base64 编码', () => {
    const value = subProfileTitle('优选节点')
    expect(value.startsWith('=?UTF-8?B?')).toBe(true)
    expect(value.endsWith('?=')).toBe(true)
    // 解码应与清洗后的名称一致
    const base64 = value.slice('=?UTF-8?B?'.length, -2)
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe('优选节点')
  })
})

describe('rfc5987Encode', () => {
  it('保留 RFC 5987 允许的字符集，其余百分号编码', () => {
    expect(rfc5987Encode('abc-._~')).toBe('abc-._~')
    expect(rfc5987Encode("a'b(c)d*e")).toBe('a%27b%28c%29d%2Ae')
    expect(rfc5987Encode('中')).toBe('%E4%B8%AD')
  })
})
