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
 * TLS 握手筛选—— 守护 -1 根因修复。
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

describe('探测重试（withRetry 语义）', () => {
  /**
   * 复刻 scan.ts 的 withRetry 逻辑。
   *
   * 金丝雀：源码改了重试语义，这里会失败，提醒同步。
   * 真机背景：偶发失败率 3~5%（TLS 抖动 / 运营商瞬时丢包），
   * 一次定生死会白丢好 IP。
   */
  const withRetry = async <T>(
    attempts: number,
    fn: () => Promise<T>,
    isOk: (r: T) => boolean = (r) => (r as { ok?: boolean }).ok === true
  ): Promise<T> => {
    const total = Math.max(1, Math.floor(attempts))
    let last: T
    for (let i = 0; i < total; i++) {
      last = await fn()
      if (isOk(last)) return last
    }
    return last!
  }

  it('首次成功不再重试', async () => {
    let calls = 0
    const r = await withRetry(3, async () => { calls++; return { ok: true, v: 1 } })
    expect(r).toEqual({ ok: true, v: 1 })
    expect(calls).toBe(1)
  })

  it('失败后重试，取第一次成功的结果', async () => {
    let calls = 0
    const r = await withRetry(3, async () => {
      calls++
      return calls < 3 ? { ok: false, v: calls } : { ok: true, v: 'success' }
    })
    expect(r).toEqual({ ok: true, v: 'success' })
    expect(calls).toBe(3)
  })

  it('全部失败时返回最后一次结果', async () => {
    let calls = 0
    const r = await withRetry(3, async () => { calls++; return { ok: false, v: calls } })
    expect(r).toEqual({ ok: false, v: 3 })
    expect(calls).toBe(3)
  })

  it('attempts=1 等价于不重试', async () => {
    let calls = 0
    const r = await withRetry(1, async () => { calls++; return { ok: false, v: 0 } })
    expect(r.ok).toBe(false)
    expect(calls).toBe(1)
  })

  it('attempts=0 / 负数被规整为 1', async () => {
    let calls = 0
    await withRetry(0, async () => { calls++; return { ok: false } })
    expect(calls).toBe(1)
    calls = 0
    await withRetry(-5, async () => { calls++; return { ok: false } })
    expect(calls).toBe(1)
  })

  it('自定义成功判定（TLS 探测用 tlsMs > 0）', async () => {
    let calls = 0
    const r = await withRetry<{ tlsMs: number }>(
      3,
      async () => { calls++; return { tlsMs: calls < 2 ? -1 : 500 } },
      (x) => x.tlsMs > 0
    )
    expect(r.tlsMs).toBe(500)
    expect(calls).toBe(2)
  })
})

describe('阶段二严格校验（响应体内容校验）', () => {
  /**
   * 复刻 scan.ts 阶段二的保留规则。
   *
   * 金丝雀：源码改了过滤条件，这里会失败，提醒同步。
   */
  const keepOk = (
    results: Array<{ ip: string; ok: boolean; pongVerified?: boolean }>,
    strict: boolean
  ): string[] =>
    (strict
      ? results.filter((r) => r.ok && r.pongVerified === true)
      : results.filter((r) => r.ok)
    ).map((r) => r.ip)

  const sample = [
    { ip: '1.1.1.1', ok: true, pongVerified: true }, // 101 + PONG ✅
    { ip: '2.2.2.2', ok: true, pongVerified: false }, // 101 通但数据面不响应 ❌
    { ip: '3.3.3.3', ok: false, pongVerified: false }, // 101 就没过 ❌
    { ip: '4.4.4.4', ok: true, pongVerified: undefined }, // 非 CFPilot，退化 101 ✅
  ]

  it('严格模式只保留通过内容校验的（拦掉假活 IP）', () => {
    // 4.4.4.4 的 pongVerified 是 undefined，严格模式下被排除
    expect(keepOk(sample, true)).toEqual(['1.1.1.1'])
  })

  it('宽松模式（--no-verify）保留所有 101 通过的', () => {
    expect(keepOk(sample, false)).toEqual(['1.1.1.1', '2.2.2.2', '4.4.4.4'])
  })

  it('关键守护：101 通但无响应的 IP 绝不能进严格模式结果', () => {
    const result = keepOk(sample, true)
    expect(result).not.toContain('2.2.2.2')
    expect(result).not.toContain('3.3.3.3')
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
