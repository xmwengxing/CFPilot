/**
 * 竞速落败连接必须整条 Socket 关掉 —— 回归测试。
 *
 * ## 守护的缺陷
 *
 * `raceBatch` 原先对「慢一步连上」的候选只调
 * `result.writable.getWriter().close()`：
 *
 *   - writer 可能已被锁住，`getWriter()` 直接抛错并被 catch 吞掉；
 *   - 即便调用成功，写端关闭也不会中断另一头挂起的 `reader.read()`。
 *
 * 结果是每批竞速留下最多 5 条半开连接，占着「单请求 6 条出站 TCP」的槽位，
 * 影响同一请求后续的 DoH 查询与重试拨号。
 *
 * ## 打桩方式
 *
 * 与 `dial-concurrency.test.ts` 一致：mock `cloudflare:sockets` 的 `connect()`，
 * 给每个候选不同的建连延迟，制造「一个胜出、其余迟到」的确定时序，
 * 断言落败者的底层 `socket.close()` 各被调用一次、胜出者不被关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每个候选的建连延迟（ms） */
let delays: Record<string, number> = {}
/** 每个候选的底层 socket.close() 调用次数 */
let closeCalls: Record<string, number> = {}

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    const host = address.hostname
    const delay = delays[host] ?? 5
    return {
      opened: (async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
      })(),
      readable: new ReadableStream<Uint8Array>({ start(c) { c.close() } }),
      writable: new WritableStream<Uint8Array>(),
      close: () => {
        closeCalls[host] = (closeCalls[host] ?? 0) + 1
      },
    }
  },
}))

beforeEach(() => {
  delays = {}
  closeCalls = {}
})

afterEach(() => {
  vi.clearAllMocks()
})

const { dial } = await import('../src/outbound/dial')

/** 203.0.113.0/24 是 RFC 5737 测试网段，不在 CF 网段表里，不会被降权 */
const CANDIDATES = ['203.0.113.1', '203.0.113.2', '203.0.113.3'] as const
const TARGET = 'target.example'

describe('竞速落败连接立即释放槽位', () => {
  it('第一个候选胜出后，其余迟到的候选各调用一次 socket.close()，胜出者不被关', async () => {
    // 直连目标最快，三个优选 IP 稍慢但都会连上 —— 正是「迟到成功」分支
    delays[TARGET] = 1
    for (const ip of CANDIDATES) delays[ip] = 20

    const result = await dial({
      hostname: TARGET,
      port: 443,
      optimizedIps: CANDIDATES.map((ip) => ({ ip, port: 443 })),
      resolvePreferred: false,
      concurrent: true,
      timeoutMs: 2000,
    })

    expect(result.endpoint).toBe(`${TARGET}:443`)

    // 落败 promise 会在 resolve 之后的微任务里 settle，等它们跑完
    await new Promise((resolve) => setTimeout(resolve, 60))

    for (const ip of CANDIDATES) {
      expect(closeCalls[ip]).toBe(1)
    }
    // 胜出连接要留给上行/下行泵继续使用
    expect(closeCalls[TARGET] ?? 0).toBe(0)
  })

  it('只有一个候选时不触发任何关闭', async () => {
    delays[TARGET] = 1

    const result = await dial({
      hostname: TARGET,
      port: 443,
      resolvePreferred: false,
      concurrent: true,
      timeoutMs: 2000,
    })

    expect(result.via).toBe('direct')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closeCalls[TARGET] ?? 0).toBe(0)
  })
})
