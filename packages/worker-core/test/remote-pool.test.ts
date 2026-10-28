/**
 * 远程第三方优选订阅源（ADDAPI / ADDCSV）的端到端验证。
 *
 * ## 为什么要有这组测试
 *
 * 面板「出站与高级」页有一个「远程第三方优选订阅源（可选扩展）」卡片，
 * 配了 ADDAPI / ADDCSV 后订阅里应该多出这些节点。
 *
 * 这类「配了不知道有没有生效」的功能最容易变成**纯装饰** ——
 * UI 在、字段存了、但订阅里根本没多东西。
 *
 * 这组测试把整条链路钉死：
 *
 *   面板字段 → CONFIG → collectNodes 拉取 → 分池 → 合并 → **订阅输出**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { clearRemoteTextCache, collectNodes, renderBase64 } from '../src/sub-engine'
import type { UserConfig } from '../src/types'

/** 造一份最小可用的配置 */
function makeConfig(over: Partial<UserConfig> = {}): UserConfig {
  return {
    uuid: '11111111-2222-3333-4444-555555555555',
    trojanPassword: 'tp',
    wsPath: '/vless',
    trojanPath: '/trojan',
    xhttpPath: '/xhttp',
    add: '',
    addApi: '',
    addCsv: '',
    poolOfficial: false,
    officialCount: 0,
    poolDomain: false,
    domainCount: 0,
    poolManual: false,
    poolCountries: '',
    dls: 0,
    maxLatency: 0,
    maxNodes: 0,
    proxyIp: '',
    socks5: '',
    httpProxy: '',
    proxyMode: 'only',
    nat64: '',
    concurrentDial: true,
    relayPool: '',
    useBuiltinRelay: false,
    resolvePreferred: false,
    enableTrojan: true,
    enableXhttp: false,
    subDomain: '',
    subProtocol: 'both',
    subTransport: 'both',
    subVariants: 'vless-ws',
    subName: 'CFPilot',
    subPorts: '443',
    clientFingerprint: 'chrome',
    ech: false,
    echHost: 'cloudflare-ech.com',
    echDns: '',
    tlsFragment: false,
    tlsFragmentSize: '10-20',
    tlsFragmentDelay: '10-20',
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // 远程池文本缓存是模块级、跨用例存活的（生产上就该这样），
  // 这里显式清空：否则前一个用例拉过的 URL 会让后一个用例直接命中缓存，
  // 本文件里那些「重新打桩 fetch」的断言就失去意义了。
  clearRemoteTextCache()
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/ips.txt')) {
      return new Response('104.16.1.1:443#HKG\n104.16.2.2:443#SJC\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    if (url.includes('/result.csv')) {
      // CloudflareSpeedTest 风格的 CSV
      return new Response(
        'IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s)\n' +
          '104.16.3.3,100,100,0,50,9.5\n' +
          '104.16.4.4,100,100,0,800,0.2\n',
        { status: 200, headers: { 'Content-Type': 'text/plain' } }
      )
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('远程第三方优选订阅源（ADDAPI / ADDCSV）', () => {
  it('ADDAPI：远程 TXT 列表的节点会进入订阅', async () => {
    const result = await collectNodes(makeConfig({ addApi: 'https://example.test/ips.txt' }), '')

    const apiNodes = result.nodes.filter((n) => n.source === 'addapi')
    expect(apiNodes.length).toBe(2)
    expect(apiNodes.map((n) => n.ip)).toEqual(['104.16.1.1', '104.16.2.2'])
    expect(result.stats.addapi).toBe(2)
    expect(result.stats.errors).toEqual([])
  })

  it('ADDAPI 的节点会真的出现在订阅输出里（不是只统计不输出）', async () => {
    const result = await collectNodes(makeConfig({ addApi: 'https://example.test/ips.txt' }), '')
    const sub = renderBase64({
      nodes: result.nodes,
      groups: result.groups,
      config: makeConfig({ addApi: 'https://example.test/ips.txt' }),
      domain: 'cpdata.example.pages.dev',
      port: 443,
      ports: [443],
      protocol: 'vless',
      transport: 'ws',
    })
    const decoded = Buffer.from(sub, 'base64').toString('utf8')
    expect(decoded).toContain('104.16.1.1')
    expect(decoded).toContain('104.16.2.2')
  })

  it('ADDCSV：远程 CSV 的节点会进入订阅', async () => {
    const result = await collectNodes(makeConfig({ addCsv: 'https://example.test/result.csv' }), '')
    const csvNodes = result.nodes.filter((n) => n.source === 'addcsv')
    expect(csvNodes.length).toBe(2)
    expect(result.stats.addcsv).toBe(2)
  })

  it('DLS 与 MAX_LATENCY 会过滤 CSV 里的不合格节点', async () => {
    // 两条：延迟 50ms / 800ms，速度 9.5 / 0.2 MB/s
    const result = await collectNodes(makeConfig({
        addCsv: 'https://example.test/result.csv',
        dls: 5, // 速度下限 5 MB/s → 第二条（0.2）被过滤
        maxLatency: 200, // 延迟上限 200ms → 第二条（800）被过滤
      }), '')
    const csvNodes = result.nodes.filter((n) => n.source === 'addcsv')
    expect(csvNodes.length).toBe(1)
    expect(csvNodes[0]!.ip).toBe('104.16.3.3')
    expect(result.stats.filtered).toBe(1)
  })

  it('拉取失败会在 errors 里报出来（不会静默）', async () => {
    const result = await collectNodes(makeConfig({ addApi: 'https://example.test/missing.txt' }), '')
    expect(result.stats.addapi).toBe(0)
    expect(result.stats.errors.join(' ')).toContain('ADDAPI')
  })

  it('非 http(s) 的地址会被忽略（不发起请求）', async () => {
    const result = await collectNodes(
      makeConfig({ addApi: 'ftp://example.test/ips.txt\njavascript:alert(1)' }),
      ''
    )
    // 只允许出现「不是这两个地址」的调用（本用例不应有任何远程拉取）
    const called = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(called.some((u) => u.includes('example.test'))).toBe(false)
    expect(result.stats.addapi).toBe(0)
  })

  it('maxNodes 限制的是**合并后的总节点数**（不是只限远程池）', async () => {
    // 官方池 5 条 + 远程 2 条 = 7 条，上限 6 → 结果 6 条
    const result = await collectNodes(makeConfig({
        addApi: 'https://example.test/ips.txt',
        poolOfficial: true,
        officialCount: 5,
        maxNodes: 6,
      }), '')
    expect(result.nodes.length).toBe(6)
    // 远程的节点在合并后按优先级排在官方池之后 → 被上限截掉
    const apiNodes = result.nodes.filter((n) => n.source === 'addapi')
    expect(apiNodes.length).toBe(1)
  })

  it('远程池与三个来源勾选项无关 —— 配了就生效', async () => {
    // 三个都关掉，只配 addApi
    const result = await collectNodes(makeConfig({
        addApi: 'https://example.test/ips.txt',
        poolOfficial: false,
        poolDomain: false,
        poolManual: false,
    poolCountries: '',
      }), '')
    // 三个来源全不勾时，内核会**自动兜底** 20 官方 IP + 10 优选域名
    // （见 sub-engine.ts「三个来源都未勾选 → 自动兜底 20 + 10」）
    expect(result.stats.official).toBe(20)
    expect(result.stats.addapi).toBe(2)
    // 远程池是**额外**追加的，与三个勾选项无关
    expect(result.nodes.length).toBe(20 + 10 + 2)
  })
})
