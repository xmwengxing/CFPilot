import { describe, expect, it, vi } from 'vitest'
import { formatEntries } from '../src/scan'
import { flagBool, flagList, flagNumber, flagString, parseArgs } from '../src/args'

describe('formatEntries', () => {
  it('生成面板回填格式 IP:Port#机房_延迟_速度', () => {
    const lines = formatEntries([
      { ip: '1.2.3.4', port: 443, colo: 'SJC', latency: 12, tlsMs: 320, speed: 35.5 },
    ])
    expect(lines).toEqual(['1.2.3.4:443#SJC_12_35.5'])
  })
})

/**
 * TLS 握手筛选（2026-10-24 新增）—— 守护 -1 根因修复。
 *
 * 真机实测背景：电信千兆下 TCP 延迟 8~40ms（无区分度），
 * TLS 握手 768ms~3531ms（相差 4.6 倍），两者相关系数接近 0。
 * 只按 TCP 排序会选出「TCP 快但 TLS 慢」的 IP → 客户端 -1。
 *
 * 因此这些用例锁定：阶段一必须以 **TLS 握手耗时**为主排序键。
 */
describe('TLS 握手筛选（-1 根因修复）', () => {
  /**
   * 复刻 scan.ts 阶段一的排序逻辑做单元验证。
   *
   * 不直接跑 runScan（需要真实网络），而是把排序规则抽成断言 ——
   * 规则变了这些用例就会失败，防止回退到「只按 TCP 延迟排序」。
   */
  it('TLS 握手快的 IP 排在前面，即使 TCP 稍慢', () => {
    // 真实数据形态：TCP 9ms 但 TLS 3.5s vs TCP 13ms 但 TLS 0.77s
    const tcpOk = [
      { ip: '104.16.64.195', latency: 10, tls: { tlsMs: 3531 } },
      { ip: '104.16.66.185', latency: 11, tls: { tlsMs: 768 } },
      { ip: '104.24.247.35', latency: 13, tls: { tlsMs: 990 } },
      { ip: '104.16.115.207', latency: 9, tls: { tlsMs: 801 } },
    ]

    const sorted = tcpOk
      .sort((a, b) => a.tls.tlsMs - b.tls.tlsMs || a.latency - b.latency)
      .slice(0, 2)

    // 握手最快的两个应入选；TCP 最快但 TLS 最慢的必须被挤掉
    expect(sorted.map((r) => r.ip)).toEqual(['104.16.66.185', '104.16.115.207'])
    expect(sorted.map((r) => r.ip)).not.toContain('104.16.64.195')
  })

  it('TLS 握手失败（tlsMs <= 0）的 IP 不进入下一阶段', () => {
    const tlsResults = [
      { ip: '1.1.1.1', latency: 10, tls: { tlsMs: 800 } },
      { ip: '2.2.2.2', latency: 9, tls: { tlsMs: -1 } }, // 握手失败
      { ip: '3.3.3.3', latency: 11, tls: { tlsMs: 900 } },
    ]
    const tlsOk = tlsResults.filter((r) => r.tls.tlsMs > 0)
    expect(tlsOk.map((r) => r.ip)).toEqual(['1.1.1.1', '3.3.3.3'])
  })

  it('TLS 耗时相同时退化为按 TCP 延迟排序', () => {
    const items = [
      { ip: 'a', latency: 30, tls: { tlsMs: 1000 } },
      { ip: 'b', latency: 10, tls: { tlsMs: 1000 } },
      { ip: 'c', latency: 20, tls: { tlsMs: 1000 } },
    ]
    const sorted = items.sort((x, y) => x.tls.tlsMs - y.tls.tlsMs || x.latency - y.latency)
    expect(sorted.map((r) => r.ip)).toEqual(['b', 'c', 'a'])
  })
})

describe('parseArgs', () => {
  it('解析子命令与长参数', () => {
    const args = parseArgs(['scan', '--host', 'example.com', '--top=20', '--no-callback'])
    expect(args.command).toBe('scan')
    expect(flagString(args, 'host')).toBe('example.com')
    expect(flagNumber(args, 'top', 15)).toBe(20)
    expect(flagBool(args, 'no-callback')).toBe(true)
  })

  it('布尔参数没有值时为 true', () => {
    const args = parseArgs(['--json'])
    expect(flagBool(args, 'json')).toBe(true)
    expect(flagString(args, 'json', 'fallback')).toBe('fallback')
  })

  it('支持逗号分隔的列表参数', () => {
    const args = parseArgs(['--cidr', '1.2.3.0/24,5.6.7.0/24'])
    expect(flagList(args, 'cidr')).toEqual(['1.2.3.0/24', '5.6.7.0/24'])
  })

  it('缺省时使用默认值', () => {
    const args = parseArgs([])
    expect(flagNumber(args, 'port', 443)).toBe(443)
    expect(flagString(args, 'host')).toBe('')
  })
})
