import { describe, expect, it } from 'vitest'
import { parseProxyEntry, parseProxyPool } from '../src/outbound/proxy-pool'
import type { UserConfig } from '../src/types'

describe('代理池解析', () => {
  it('裸 host:port 默认按直连落地解析（ProxyIP 语义）', () => {
    const entry = parseProxyEntry('104.17.242.168:443')
    expect(entry).toEqual({ host: '104.17.242.168', port: 443, kind: 'direct' })
  })

  it('显式 socks5:// 前缀仍然是 SOCKS5', () => {
    const entry = parseProxyEntry('socks5://1.2.3.4:1080')
    expect(entry?.kind).toBe('socks5')
  })

  it('显式 http:// 前缀仍然是 HTTP CONNECT', () => {
    const entry = parseProxyEntry('http://1.2.3.4:8080')
    expect(entry?.kind).toBe('http')
  })

  it('显式 https:// 前缀解析为 HTTPS 代理（代理服务器本身走 TLS）', () => {
    const entry = parseProxyEntry('https://1.2.3.4:8443')
    expect(entry?.kind).toBe('https')
  })

  it('HTTP 代理配置里的裸 host:port 仍按 http 解析', () => {
    const entry = parseProxyEntry('1.2.3.4:8080', 'http')
    expect(entry?.kind).toBe('http')
  })

  it('SOCKS5 配置里的裸 host:port 仍按 SOCKS5 解析', () => {
    const entry = parseProxyEntry('1.2.3.4:1080', 'socks5')
    expect(entry?.kind).toBe('socks5')
  })

  it('带凭据的代理条目保留用户名密码', () => {
    const entry = parseProxyEntry('socks5://user:pass@1.2.3.4:1080')
    expect(entry).toMatchObject({ kind: 'socks5', username: 'user', password: 'pass' })
  })

  it('IPv6 地址可解析', () => {
    const entry = parseProxyEntry('[2606:4700::]:443')
    expect(entry).toMatchObject({ host: '2606:4700::', port: 443 })
  })

  it('多行多分隔符的池文本全部解析', () => {
    const pool = parseProxyPool('1.1.1.1:443\n2.2.2.2:443,3.3.3.3:443;4.4.4.4:443', 'direct')
    expect(pool.map((p) => p.host)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'])
  })
})

describe('数据面出站池汇总（逻辑与 routes/data.ts 的 collectProxies 一致）', () => {
  // 这里不直接 import routes/data：它经 protocols/websocket 牵出 protocols/websocket-self.ts，
  // 而后者静态 import 了 cloudflare:sockets，在 Node 测试环境里无法加载。
  // 因此在这里复现同样的汇总规则，锁定 PROXYIP 的解析语义。
  function collect(config: { proxyIp: string; socks5: string; httpProxy: string }) {
    return [
      ...parseProxyPool(config.proxyIp, 'direct'),
      ...parseProxyPool(config.socks5, 'socks5'),
      ...parseProxyPool(config.httpProxy, 'http'),
    ]
  }

  const base: UserConfig = {
    uuid: 'u',
    trojanPassword: 'p',
    wsPath: '/vless',
    trojanPath: '/trojan',
    xhttpPath: '/xhttp',
    add: '',
    addApi: '',
    addCsv: '',
    poolOfficial: true,
    officialCount: 20,
    poolDomain: true,
    domainCount: 10,
    poolManual: false,
    poolCountries: '',
    dls: 0,
    maxLatency: 0,
    maxNodes: 0,
    proxyIp: '',
    socks5: '',
    httpProxy: '',
    nat64: '',
    concurrentDial: true,
    resolvePreferred: true,
    relayPool: '',
    useBuiltinRelay: true,
    subVariants: 'vless-ws',
    subName: 'CFPilot',
    subPorts: '443',
    enableTrojan: true,
    enableXhttp: true,
    subDomain: '',
    subProtocol: 'vless',
    subTransport: 'ws',
    clientFingerprint: 'chrome',
    tlsFragment: false,
    tlsFragmentSize: '10-20',
    tlsFragmentDelay: '10-20',
    ech: false,
    echHost: 'cloudflare-ech.com',
    echDns: '',
  }

  it('PROXYIP 按直连落地汇总，SOCKS5/HTTP 各自按类型汇总', () => {
    const proxies = collect({
      proxyIp: '104.17.242.168:443',
      socks5: 'socks5://10.0.0.1:1080',
      httpProxy: 'http://10.0.0.2:8080',
    })
    expect(proxies).toEqual([
      { host: '104.17.242.168', port: 443, kind: 'direct' },
      { host: '10.0.0.1', port: 1080, kind: 'socks5' },
      { host: '10.0.0.2', port: 8080, kind: 'http' },
    ])
  })

  it('三个出站配置都为空时不产生代理项', () => {
    expect(collect({ proxyIp: '', socks5: '', httpProxy: '' })).toEqual([])
  })
})
