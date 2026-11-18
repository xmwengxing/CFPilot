/**
 * 出站拨号：阶段级截止时间 + 直连/优选组的健康排序。
 *
 * ## 守护的两个缺陷（2026-11-18 审计核实）
 *
 * 1. **总预算没有真正贯穿各阶段**：`connectWithTimeout` 的 TCP 建连与 TLS 升级
 *    各自用同一个 `timeoutMs`，一个候选最坏吃掉 2 倍剩余预算
 *    （NAT64 重试还要再来一次）。现在由 `attemptOf` 算出「本次尝试的绝对截止」，
 *    每阶段取 `min(阶段上限, 剩余)`，总耗时被真正夹住。
 *
 * 2. **直连/优选组不吃健康排序**：`attemptOf` 给所有候选记了成败，但
 *    `dialDirectGroup` 直接 `directCandidates.map(...)`，冷却中的坏优选 IP
 *    每次仍排在前面，白占「单请求 6 条并发出站」的槽位。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface ConnectRecord {
  host: string
  at: number
}

let records: ConnectRecord[] = []
let failHosts = new Set<string>()
/** 建立 TCP 的模拟耗时（ms） */
let openedDelayMs = 5
/** TLS 升级是否永不完成（验证阶段级截止） */
let tlsNeverOpens = false

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    records.push({ host: address.hostname, at: Date.now() })
    const host = address.hostname
    return {
      opened: new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (failHosts.has(host)) reject(new Error(`连接失败：${host}`))
          else resolve()
        }, openedDelayMs)
      }),
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          c.close()
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      startTls: () => ({
        opened: tlsNeverOpens ? new Promise<void>(() => {}) : Promise.resolve(),
        readable: new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        }),
        writable: new WritableStream<Uint8Array>(),
        close: async () => {},
      }),
      close: async () => {},
    }
  },
}))

const { dial } = await import('../src/outbound/dial')
const { clearEndpointHealth, recordEndpointFailure } = await import('../src/outbound/endpoint-health')

beforeEach(() => {
  records = []
  failHosts = new Set()
  openedDelayMs = 5
  tlsNeverOpens = false
  clearEndpointHealth()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('直连/优选组按端点健康排序', () => {
  it('冷却中的优选 IP 排到队尾（不再每次抢在前面）', async () => {
    const base = {
      hostname: 'target.example',
      port: 443,
      optimizedIps: [
        { ip: '1.2.3.4', port: 443 },
        { ip: '5.6.7.8', port: 443 },
      ],
      timeoutMs: 2000,
      resolvePreferred: false,
    }

    await dial(base)
    const before = records.map((r) => r.host)
    expect(before.indexOf('1.2.3.4')).toBeLessThan(before.indexOf('5.6.7.8'))

    // 让 1.2.3.4 进入冷却（连续两次失败）
    const now = Date.now()
    recordEndpointFailure('optimized|1.2.3.4:443', now, false)
    recordEndpointFailure('optimized|1.2.3.4:443', now + 1, false)

    records = []
    await dial(base)
    const after = records.map((r) => r.host)
    expect(after).toContain('1.2.3.4')
    expect(after.indexOf('1.2.3.4')).toBeGreaterThan(after.indexOf('5.6.7.8'))
  })
})

describe('尝试级绝对截止时间', () => {
  it('TCP 建连吃掉大半预算后，TLS 阶段只等剩余时间（不再各等满一轮）', async () => {
    openedDelayMs = 400
    tlsNeverOpens = true
    const started = Date.now()

    await expect(
      dial({
        hostname: 'target.example',
        port: 443,
        proxies: [{ host: 'tls-proxy.test', port: 443, kind: 'https', serverName: 'tls-proxy.test' }],
        proxyMode: 'only',
        timeoutMs: 600,
        budgetMs: 5000,
        resolvePreferred: false,
      })
    ).rejects.toThrow(/超时|预算/)

    const elapsed = Date.now() - started
    // 期望 ≈ 600ms（400 建连 + 200 剩余）；旧实现是 400 + 600 = 1000ms
    expect(elapsed).toBeGreaterThanOrEqual(550)
    expect(elapsed).toBeLessThan(850)
  })
})
