import { describe, it, expect } from 'vitest'
import { validateCallbackUrl } from '../src/scan/server'

describe('validateCallbackUrl（SSRF 防护）', () => {
  it('允许公网 https 地址', () => {
    expect(validateCallbackUrl('https://cpmanager.pages.dev/api/v1/preferred-ips').ok).toBe(true)
    expect(validateCallbackUrl('https://panel.example.com/api/v1/preferred-ips').ok).toBe(true)
  })

  it('允许空值（不传就不回填）', () => {
    expect(validateCallbackUrl(undefined).ok).toBe(true)
    expect(validateCallbackUrl('').ok).toBe(true)
    expect(validateCallbackUrl('   ').ok).toBe(true)
  })

  it('拒绝 http 明文', () => {
    const r = validateCallbackUrl('http://cpmanager.pages.dev/api')
    expect(r.ok).toBe(false)
  })

  it('拒绝非 URL', () => {
    expect(validateCallbackUrl('not a url').ok).toBe(false)
  })

  it('拒绝 localhost 与回环地址', () => {
    expect(validateCallbackUrl('https://localhost/api').ok).toBe(false)
    expect(validateCallbackUrl('https://127.0.0.1/api').ok).toBe(false)
    expect(validateCallbackUrl('https://[::1]/api').ok).toBe(false)
  })

  it('拒绝 RFC1918 内网地址', () => {
    expect(validateCallbackUrl('https://10.0.0.5/api').ok).toBe(false)
    expect(validateCallbackUrl('https://192.168.1.1/api').ok).toBe(false)
    expect(validateCallbackUrl('https://172.16.0.1/api').ok).toBe(false)
    expect(validateCallbackUrl('https://172.31.255.254/api').ok).toBe(false)
  })

  it('拒绝链路本地与 CGNAT', () => {
    expect(validateCallbackUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false)
    expect(validateCallbackUrl('https://100.64.0.1/api').ok).toBe(false)
  })

  it('拒绝 .local / .internal 域名', () => {
    expect(validateCallbackUrl('https://foo.local/api').ok).toBe(false)
    expect(validateCallbackUrl('https://foo.internal/api').ok).toBe(false)
  })

  it('172.32 段是公网，不应被误判为内网', () => {
    expect(validateCallbackUrl('https://172.32.0.1/api').ok).toBe(true)
  })
})
