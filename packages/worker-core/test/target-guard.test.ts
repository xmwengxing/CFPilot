/**
 * 出站目标地址策略（SSRF 黑名单）—— 判定与接线测试。
 *
 * ## 两条边界（必须同时成立）
 *
 * 1. **直连私网目标立即失败**，且不产生任何出站连接尝试 ——
 *    不能先花一次 DoH 解析 + 5s 超时才说「连不上」；
 * 2. **配了落地代理时照常走代理** ——「用代理回家里的 NAS」是合法用法，
 *    拦掉就等于让用户的功能直接不可用。
 *
 * 另外钉住失败分级：策略拦截必须是 `policy`，不能混进 `blocked`
 * （后者意味着「被平台拒绝 / 目标在 CF 网段」，处理方式完全不同）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { blockedTarget, TargetBlockedError } from '../src/outbound/guard'
import { classifyDialFailure } from '../src/outbound/route'
import { dial } from '../src/outbound/dial'

const HTTP_OK = new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n')

let connectedHosts: string[] = []

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    connectedHosts.push(address.hostname)
    return {
      opened: Promise.resolve(),
      readable: new ReadableStream({
        start(c) {
          c.enqueue(HTTP_OK)
          c.close()
        },
      }),
      writable: new WritableStream(),
      close: () => {},
    }
  },
}))

beforeEach(() => {
  connectedHosts = []
})

describe('blockedTarget（直连目标黑名单）', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.10.20.30', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'ula'],
    ['fd12:3456::1', 'ula'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:192.168.1.1', 'private'],
    ['localhost', 'loopback'],
    ['nas.localhost', 'loopback'],
    ['printer.local', 'internal-name'],
    ['metadata.google.internal', 'internal-name'],
  ] as const)('%s → %s', (host, kind) => {
    expect(blockedTarget(host)?.kind).toBe(kind)
  })

  it.each([
    '8.8.8.8',
    '203.0.113.10', // 文档 / 测试地址，不是私网
    '172.32.0.1', // 172.16/12 之外
    '100.128.0.1', // 100.64/10 之外
    '1.1.1.1', // Cloudflare 公共 DNS：由选路降权，不是策略拦截
    '2606:4700::1111',
    '2001:db8::1',
    'example.com',
    'www.example.com',
    'nas.example.com', // 域名解析结果不预判（见 guard.ts 的边界说明）
  ])('%s 放行', (host) => {
    expect(blockedTarget(host)).toBeNull()
  })
})

describe('dial（策略接线）', () => {
  it('直连私网目标立即失败，且不发起任何出站连接', async () => {
    const failure = await dial({ hostname: '192.168.1.1', port: 80 }).catch((err) => err)

    expect(failure).toBeInstanceOf(TargetBlockedError)
    expect(connectedHosts).toEqual([])
  })

  it('配了落地代理时，私网目标仍照常经代理访问', async () => {
    const result = await dial({
      hostname: '192.168.1.1',
      port: 80,
      proxies: [{ kind: 'http', host: 'proxy.example.com', port: 8080 }],
    })

    expect(result.via).toBe('http')
    // 连的是代理，不是目标本身
    expect(connectedHosts).toEqual(['proxy.example.com'])
  })

  it('公网目标不受影响', async () => {
    const result = await dial({ hostname: '8.8.8.8', port: 80 })
    expect(result.via).toBe('direct')
    expect(connectedHosts).toEqual(['8.8.8.8'])
  })

  it('反代入口拨号可显式跳过策略（它接的是我们自己选的落地服务器）', async () => {
    const result = await dial({
      hostname: '10.0.0.9',
      port: 8443,
      skipTargetPolicy: true,
    })
    expect(result.endpoint).toBe('10.0.0.9:8443')
  })
})

describe('失败分级', () => {
  it('策略拦截归类为 policy，不混进 blocked', () => {
    const blocked = blockedTarget('127.0.0.1')!
    const failure = classifyDialFailure(
      new TargetBlockedError('127.0.0.1', blocked),
      '直连 127.0.0.1:80'
    )
    expect(failure.kind).toBe('policy')
  })

  it('竞速聚合错误里也能认出策略拦截', () => {
    const blocked = blockedTarget('10.0.0.1')!
    const original = new TargetBlockedError('10.0.0.1', blocked)
    const aggregate = new Error(`本批 2 个候选全部失败：${original.message}`, { cause: original })
    expect(classifyDialFailure(aggregate, '直连').kind).toBe('policy')
  })
})
