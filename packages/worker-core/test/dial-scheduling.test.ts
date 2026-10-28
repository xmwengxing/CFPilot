/**
 * `dial()` 的选路顺序 —— 端到端验证（打桩 sockets 层）。
 *
 * ## 为什么要有这组测试
 *
 * 2026-10-28 修的真实缺陷：
 *
 *   ProxyIP 只要 TCP 连上就算成功（**1 RTT**），
 *   SOCKS5 / HTTP 还要做认证 + CONNECT（**2~3 RTT**）。
 *
 * 两者原先在**同一个并发竞速池**里 —— ProxyIP 必然先赢，
 * 于是「配了 SOCKS5 也没用」，而且是**静默**的：
 * 出口 IP 与用户预期不符，却没有任何报错。
 *
 * 这组测试直接跑 `dial()`，用打桩的 socket 层记录
 * 「每个候选被试的顺序」与「并发度」，把两个行为钉死：
 *
 *   1. **落地代理优先于 ProxyIP**（不再被 ProxyIP 压过）
 *   2. **落地代理之间是顺序故障转移**（不并发轰炸代理服务器）
 *
 * ## 打桩说明
 *
 * 用 `kind: 'http'` 的落地代理（而不是 SOCKS5）——
 * HTTP CONNECT 的响应是文本（`HTTP/1.1 200 ...`），
 * 打桩比 SOCKS5 的二进制握手简单得多。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 记录一次连接尝试。 */
interface ConnectRecord {
  host: string
  port: number
  /** 该次连接开始时，已经在飞的其他连接数（用来观察并发度） */
  inflight: number
}

/** 哪些地址连接失败。 */
let failHosts: Set<string>
/** 记录所有连接尝试。 */
let records: ConnectRecord[]
/** 当前在飞的连接数。 */
let inflight: number

/** HTTP CONNECT 成功的响应。 */
const HTTP_OK = new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n')

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    records.push({ host: address.hostname, port: address.port, inflight })
    inflight++
    const host = address.hostname
    return {
      opened: (async () => {
        // 模拟连接建立需要一点时间（让并发行为可观察）
        await new Promise((r) => setTimeout(r, 5))
        inflight--
        if (failHosts.has(host)) {
          throw new Error(`连接失败：${host}`)
        }
      })(),
      // HTTP CONNECT 的成功响应
      readable: new ReadableStream({
        start(c) {
          c.enqueue(HTTP_OK)
          c.close()
        },
      }),
      writable: new WritableStream(),
      startTls: () => ({
        opened: Promise.resolve(),
        readable: new ReadableStream({ start(c) { c.close() } }),
        writable: new WritableStream(),
        close: async () => {},
      }),
      close: async () => {
        inflight--
      },
    }
  },
}))

beforeEach(() => {
  failHosts = new Set()
  records = []
  inflight = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

const { dial } = await import('../src/outbound/dial')

describe('dial() 的代理选路顺序', () => {
  it('落地代理优先于 ProxyIP（ProxyIP 不再压过 HTTP 代理）', async () => {
    const result = await dial({
      hostname: 'target.example',
      port: 443,
      proxies: [
        // ProxyIP 在配置里排在前面（collectProxies 的顺序就是 proxyIp → socks5 → httpProxy）
        { host: '1.2.3.4', port: 443, kind: 'direct' },
        { host: '5.6.7.8', port: 8080, kind: 'http' },
      ],
      timeoutMs: 2000,
      resolvePreferred: false,
    })

    // 走的是 HTTP 落地代理，不是 ProxyIP
    expect(result.via).toBe('http')
    expect(result.endpoint).toBe('5.6.7.8:8080')

    // 关键：ProxyIP **根本没有被试过**
    expect(records.some((r) => r.host === '1.2.3.4')).toBe(false)
  })

  it('落地代理之间是顺序故障转移（不并发）', async () => {
    failHosts = new Set(['5.6.7.8'])

    const result = await dial({
      hostname: 'target.example',
      port: 443,
      proxies: [
        { host: '5.6.7.8', port: 8080, kind: 'http' },
        { host: '9.10.11.12', port: 8080, kind: 'http' },
      ],
      timeoutMs: 2000,
      resolvePreferred: false,
    })

    expect(result.via).toBe('http')
    expect(result.endpoint).toBe('9.10.11.12:8080')

    // 两个代理都被试了，且**串行**（第一个失败后才试第二个）
    const s1 = records.findIndex((r) => r.host === '5.6.7.8')
    const s2 = records.findIndex((r) => r.host === '9.10.11.12')
    expect(s1).toBeGreaterThanOrEqual(0)
    expect(s2).toBeGreaterThan(s1)
  })

  it('多个落地代理不会同时在飞（不轰炸代理服务器）', async () => {
    failHosts = new Set(['5.6.7.8', '9.10.11.12'])

    await dial({
      hostname: 'target.example',
      port: 443,
      proxies: [
        { host: '5.6.7.8', port: 8080, kind: 'http' },
        { host: '9.10.11.12', port: 8080, kind: 'http' },
        { host: '13.14.15.16', port: 8080, kind: 'http' },
      ],
      timeoutMs: 2000,
      resolvePreferred: false,
    }).catch(() => undefined)

    // 顺序转移 → 任一时刻最多一个代理连接在飞
    const maxInflight = records.reduce((m, r) => Math.max(m, r.inflight), 0)
    expect(maxInflight).toBeLessThanOrEqual(1)
  })

  it('only 模式：代理全失败时不静默改走直连', async () => {
    failHosts = new Set(['5.6.7.8', '1.2.3.4'])

    await expect(
      dial({
        hostname: 'target.example',
        port: 443,
        proxies: [
          { host: '1.2.3.4', port: 443, kind: 'direct' },
          { host: '5.6.7.8', port: 8080, kind: 'http' },
        ],
        timeoutMs: 2000,
        resolvePreferred: false,
        proxyMode: 'only',
      })
    ).rejects.toThrow()

    // 直连目标（target.example）**没有被试过** —— 那会暴露 Cloudflare 原生出口 IP
    expect(records.some((r) => r.host === 'target.example')).toBe(false)
  })

  it('fallback 模式：直连优先，失败才走代理', async () => {
    failHosts = new Set(['target.example'])

    const result = await dial({
      hostname: 'target.example',
      port: 443,
      proxies: [{ host: '5.6.7.8', port: 8080, kind: 'http' }],
      timeoutMs: 2000,
      resolvePreferred: false,
      proxyMode: 'fallback',
    })

    expect(result.via).toBe('http')
    // 直连被试过（且先试）
    const directIdx = records.findIndex((r) => r.host === 'target.example')
    const proxyIdx = records.findIndex((r) => r.host === '5.6.7.8')
    expect(directIdx).toBeGreaterThanOrEqual(0)
    expect(proxyIdx).toBeGreaterThan(directIdx)
  })
})
