/**
 * 远程优选池（ADDAPI / ADDCSV）文本缓存与请求头验证。
 *
 * ## 为什么要有这组测试
 *
 * 远程池是**外部 URL**，客户端侧对订阅的拉取是突发的（Clash 切换配置、
 * 多设备同时更新、面板预览后再导入），没有缓存时同一波重拉会把第三方
 * 订阅接口打 N 次：外部一慢整条订阅就超时，CSV 还要全量重解析（吃 CPU）。
 *
 * 这条缓存有几个容易做错、且做错了**用户几乎无感知**的点，必须钉住：
 *
 * 1. 命中缓存时不能再 `fetch`（否则缓存等于没加）；
 * 2. 失败**不能**缓存（否则一次抖动会在缓存期内变成「持续故障」）；
 * 3. TTL 到点必须过期（否则用户改完远端池永远看不到新数据）；
 * 4. 面板预览要能 `bypassRemoteCache` 强制刷新（逃生口不能被缓存挡住）；
 * 5. 条数上限 32，超出淘汰最旧（防 URL 列表无限增长占内存）。
 *
 * 另外顺手钉住 User-Agent：远程池请求不能再用 `CFPilot/x.y (+仓库地址)`，
 * 那既是项目指纹，也容易被 CDN 风控按「非浏览器 UA」直接 403。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { clearRemoteTextCache, collectNodes } from '../src/sub-engine'
import type { UserConfig } from '../src/types'

const API_URL = 'https://example.test/ips.txt'
const CSV_URL = 'https://example.test/result.csv'

/** 造一份最小可用的配置（与 remote-pool.test.ts 保持一致） */
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

/** 某个 URL 被真正 fetch 了几次（缓存命中不计） */
function callsFor(url: string): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === url).length
}

beforeEach(() => {
  // 缓存是模块级、跨用例存活的（生产上就该这样），每个用例前显式清空避免串味
  clearRemoteTextCache()
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('.csv')) {
      return new Response(
        'IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s)\n' +
          '104.16.3.3,100,100,0,50,9.5\n' +
          '104.16.4.4,100,100,0,800,0.2\n',
        { status: 200, headers: { 'Content-Type': 'text/plain' } }
      )
    }
    if (url.endsWith('.txt')) {
      return new Response('104.16.1.1:443#HKG\n104.16.2.2:443#SJC\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearRemoteTextCache()
})

describe('远程池文本缓存', () => {
  it('同一个 URL 连续两次 collectNodes 只 fetch 一次（缓存命中）', async () => {
    const config = makeConfig({ addApi: API_URL })

    const first = await collectNodes(config, '')
    const second = await collectNodes(config, '')

    expect(first.stats.addapi).toBe(2)
    expect(second.stats.addapi).toBe(2)
    expect(callsFor(API_URL)).toBe(1)
    expect(second.stats.errors).toEqual([])
  })

  it('ADDCSV 同样走缓存', async () => {
    const config = makeConfig({ addCsv: CSV_URL })

    const first = await collectNodes(config, '')
    const second = await collectNodes(config, '')

    expect(first.stats.addcsv).toBe(2)
    expect(second.stats.addcsv).toBe(2)
    expect(callsFor(CSV_URL)).toBe(1)
  })

  it('bypassRemoteCache: true 会绕过缓存重新拉取（ADDAPI）', async () => {
    const config = makeConfig({ addApi: API_URL })

    await collectNodes(config, '')
    await collectNodes(config, '')
    expect(callsFor(API_URL)).toBe(1) // 命中缓存

    // 面板预览场景：要看到最新数据
    const bypassed = await collectNodes(config, '', { bypassRemoteCache: true })
    expect(callsFor(API_URL)).toBe(2)
    expect(bypassed.stats.addapi).toBe(2)
  })

  it('bypassRemoteCache: true 对 ADDCSV 同样生效', async () => {
    const config = makeConfig({ addCsv: CSV_URL })

    await collectNodes(config, '')
    expect(callsFor(CSV_URL)).toBe(1)

    await collectNodes(config, '', { bypassRemoteCache: true })
    expect(callsFor(CSV_URL)).toBe(2)
  })

  it('拉取失败不会被缓存：下一次调用会真的重新 fetch', async () => {
    const config = makeConfig({ addApi: API_URL })
    fetchMock.mockRejectedValueOnce(new Error('临时网络故障'))

    const first = await collectNodes(config, '')
    expect(first.stats.addapi).toBe(0)
    // 失败必须在 errors 里报出来，不能静默
    expect(first.stats.errors.join(' ')).toContain('ADDAPI 拉取失败')
    expect(first.stats.errors.join(' ')).toContain('临时网络故障')
    expect(callsFor(API_URL)).toBe(1)

    const second = await collectNodes(config, '')
    // 失败没写缓存 → 第二次必然重试（临时故障可自愈）
    expect(callsFor(API_URL)).toBe(2)
    expect(second.stats.addapi).toBe(2)
    expect(second.stats.errors).toEqual([])
  })

  it('HTTP 非 2xx（404）同样不缓存', async () => {
    const config = makeConfig({ addApi: 'https://example.test/missing' })

    const first = await collectNodes(config, '')
    expect(first.stats.errors.join(' ')).toContain('HTTP 404')

    const second = await collectNodes(config, '')
    expect(callsFor('https://example.test/missing')).toBe(2)
  })

  it('clearRemoteTextCache() 之后会重新 fetch', async () => {
    const config = makeConfig({ addApi: API_URL })

    await collectNodes(config, '')
    expect(callsFor(API_URL)).toBe(1)

    clearRemoteTextCache()

    await collectNodes(config, '')
    expect(callsFor(API_URL)).toBe(2)
  })

  it('超过 120 秒 TTL 后会重新拉取', async () => {
    // 只伪造 Date：AbortSignal.timeout 的定时器保持真实，避免假时钟干扰超时逻辑
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = new Date('2026-10-28T00:00:00Z')
    vi.setSystemTime(start)

    const config = makeConfig({ addApi: API_URL })

    await collectNodes(config, '')
    expect(callsFor(API_URL)).toBe(1)

    // 还差 1 秒到期 → 仍应命中缓存
    vi.setSystemTime(new Date(start.getTime() + 119_000))
    await collectNodes(config, '')
    expect(callsFor(API_URL)).toBe(1)

    // 越过 120 秒 → 缓存过期，必须重新拉取
    vi.setSystemTime(new Date(start.getTime() + 121_000))
    await collectNodes(config, '')
    expect(callsFor(API_URL)).toBe(2)
  })

  it('缓存上限 32 条：超出后淘汰最旧的一条', async () => {
    const urls = Array.from({ length: 33 }, (_, index) => `https://example.test/pool/${index}.txt`)

    // 逐条拉取，保证插入顺序确定
    for (const url of urls) {
      await collectNodes(makeConfig({ addApi: url }), '')
    }
    expect(urls.every((url) => callsFor(url) === 1)).toBe(true)

    // 第 1 条在插入第 33 条时被淘汰 → 再拉会重新 fetch
    await collectNodes(makeConfig({ addApi: urls[0]! }), '')
    expect(callsFor(urls[0]!)).toBe(2)

    // 最后一条还在缓存里 → 不会重新 fetch
    await collectNodes(makeConfig({ addApi: urls[32]! }), '')
    expect(callsFor(urls[32]!)).toBe(1)
  })

  it('远程池请求使用通用浏览器 UA，不带项目特征', async () => {
    await collectNodes(makeConfig({ addApi: API_URL }), '')

    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    const userAgent = init?.headers?.['User-Agent'] ?? ''

    expect(userAgent).toContain('Mozilla/5.0')
    expect(userAgent).toContain('Chrome/126.0.0.0')
    // 不能把项目特征写进每一次外部请求
    expect(userAgent).not.toContain('CFPilot')
    expect(userAgent).not.toContain('github.com')
  })
})
