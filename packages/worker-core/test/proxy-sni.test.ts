/**
 * HTTPS 代理的 SNI / 证书名校验推导。
 *
 * ## 背景（2026-10-23 真机实测）
 *
 * Cloudflare 边缘的 TLS 握手**校验证书链 + 主机名**：
 * workerd 的 TLS 能力只有 `TlsOptions = { expectedServerHostname?: string }`，
 * **无法指定自有 CA** —— 自签证书必然失败（服务端收到
 * 「remote error: tls: unknown certificate authority」）。
 *
 * 因此 HTTPS 代理必须：
 *   1. 用**域名**连接（IP 无法匹配证书）；
 *   2. 证书由**公信 CA** 签发；
 *   3. SNI 与证书里的域名一致。
 *
 * 而代理地址常常只能写成 IP（用户不知道域名），
 * 所以要支持 `#sni=example.com` 显式指定握手用的名字。
 */
import { describe, expect, it } from 'vitest'
import { parseProxyEntry, parseProxyPool } from '../src/outbound/proxy-pool'

describe('HTTPS 代理的 SNI 推导', () => {
  it('域名形式的 HTTPS 代理自动把 host 当作 SNI', () => {
    const entry = parseProxyEntry('https://proxy.example.com:8443')
    expect(entry).toMatchObject({
      kind: 'https',
      host: 'proxy.example.com',
      port: 8443,
      serverName: 'proxy.example.com',
    })
  })

  it('IP 形式的 HTTPS 代理不推导 SNI（证书不可能签给 IP）', () => {
    const entry = parseProxyEntry('https://1.2.3.4:8443')
    expect(entry).toMatchObject({ kind: 'https', host: '1.2.3.4', port: 8443 })
    expect(entry?.serverName).toBeUndefined()
  })

  it('#sni= 显式指定 SNI（代理写 IP、证书签给域名时用）', () => {
    const entry = parseProxyEntry('https://1.2.3.4:8443#sni=proxy.example.com')
    expect(entry).toMatchObject({
      kind: 'https',
      host: '1.2.3.4',
      port: 8443,
      serverName: 'proxy.example.com',
    })
  })

  it('#sni= 与凭据同时使用', () => {
    const entry = parseProxyEntry('https://user:pass@1.2.3.4:8443#sni=proxy.example.com')
    expect(entry).toMatchObject({
      kind: 'https',
      host: '1.2.3.4',
      port: 8443,
      username: 'user',
      password: 'pass',
      serverName: 'proxy.example.com',
    })
  })

  it('#sni= 放在域名条目上可覆盖自动推导', () => {
    const entry = parseProxyEntry('https://a.example.com:8443#sni=b.example.com')
    expect(entry).toMatchObject({ host: 'a.example.com', serverName: 'b.example.com' })
  })

  it('非 HTTPS 代理不带 SNI', () => {
    expect(parseProxyEntry('socks5://proxy.example.com:1080')?.serverName).toBeUndefined()
    expect(parseProxyEntry('http://proxy.example.com:8080')?.serverName).toBeUndefined()
  })

  it('池文本里的 #sni= 逐条生效', () => {
    const pool = parseProxyPool(
      'https://1.1.1.1:8443#sni=a.example.com\nhttps://2.2.2.2:8443#sni=b.example.com',
      'http'
    )
    expect(pool.map((p) => p.serverName)).toEqual(['a.example.com', 'b.example.com'])
  })
})
