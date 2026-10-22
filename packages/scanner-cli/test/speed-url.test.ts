/**
 * 测速地址模块的单元测试。
 *
 * 只测纯函数与确定性行为；不测真实网络请求（依赖外网，会让 CI 不稳定）。
 */
import { describe, expect, it } from 'vitest'
import {
  parseSpeedUrl,
  withBytes,
  schemeForPort,
  SPEED_URL_PRESETS,
  DEFAULT_SPEED_URL,
} from '../src/speed-url'

describe('parseSpeedUrl', () => {
  it('接受不带协议前缀的写法', () => {
    const r = parseSpeedUrl('speed.cloudflare.com/__down?bytes=1000000')
    expect(r.scheme).toBe('https')
    expect(r.host).toBe('speed.cloudflare.com')
    expect(r.path).toBe('/__down?bytes=1000000')
  })

  it('接受带协议前缀的写法', () => {
    const r = parseSpeedUrl('https://example.com/big.bin')
    expect(r.scheme).toBe('https')
    expect(r.host).toBe('example.com')
    expect(r.path).toBe('/big.bin')
  })

  it('接受 // 开头的写法并按回退协议补全', () => {
    const r = parseSpeedUrl('//example.com/a', 'http')
    expect(r.scheme).toBe('http')
    expect(r.host).toBe('example.com')
  })

  it('路径为空时补成 /', () => {
    const r = parseSpeedUrl('example.com')
    expect(r.path).toBe('/')
  })

  it('拒绝空值、非法协议与缺少域名', () => {
    expect(() => parseSpeedUrl('')).toThrow(/为空/)
    expect(() => parseSpeedUrl('ftp://example.com/a')).toThrow(/协议/)
    expect(() => parseSpeedUrl('https://')).toThrow()
  })
})

describe('withBytes', () => {
  it('替换已有的 bytes 参数', () => {
    const r = parseSpeedUrl('speed.cloudflare.com/__down?bytes=1000')
    expect(withBytes(r, 5000)).toBe('/__down?bytes=5000')
  })

  it('没有 bytes 参数时追加', () => {
    const r = parseSpeedUrl('example.com/big.bin')
    expect(withBytes(r, 5000)).toBe('/big.bin?bytes=5000')
  })

  it('已有其它 query 时用 & 追加', () => {
    const r = parseSpeedUrl('example.com/big.bin?token=abc')
    expect(withBytes(r, 5000)).toBe('/big.bin?token=abc&bytes=5000')
  })
})

describe('schemeForPort', () => {
  it('CF 的 TLS 端口用 https', () => {
    for (const port of [443, 2053, 2083, 2087, 2096, 8443]) {
      expect(schemeForPort(port)).toBe('https')
    }
  })

  it('其它端口用 http', () => {
    for (const port of [80, 8080, 8880]) {
      expect(schemeForPort(port)).toBe('http')
    }
  })
})

describe('内置测速地址', () => {
  it('预设都能被解析', () => {
    expect(SPEED_URL_PRESETS.length).toBeGreaterThan(0)
    for (const preset of SPEED_URL_PRESETS) {
      const parsed = parseSpeedUrl(preset.url)
      expect(parsed.host.length).toBeGreaterThan(0)
      expect(parsed.path.startsWith('/')).toBe(true)
    }
  })

  it('默认地址在预设列表里', () => {
    expect(SPEED_URL_PRESETS.some((p) => p.url === DEFAULT_SPEED_URL)).toBe(true)
  })
})