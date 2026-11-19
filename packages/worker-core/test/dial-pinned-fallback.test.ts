/**
 * 固定入口（pin）的熔断与快速回落 —— 回归测试。
 *
 * ## 守护的缺陷（2026-11-19 核实）
 *
 * `dialRelay()` 里 pin 是「无条件逐条先试」：
 *   - 不查健康记忆 ⇒ 失效的 pin **永不冷却**，每个请求都先白等一次反代超时；
 *   - 共用 `RELAY_CONNECT_TIMEOUT_MS`（2.5s）⇒ 配多条 pin 就能吃掉大半拨号预算。
 *
 * 用户侧表现：某域名（如手机 app 的 api 域名）**每次请求**都多等 2.5s，
 * app 的网络超时约 10~15s，多连接叠加后表现为「一直转圈 / 打不开」，
 * 即使兜底反代池其实是好的。
 *
 * ## 钉住的行为
 *
 *   1. pin 可用时仍然优先走 pin（固定出口语义不丢）；
 *   2. pin 失败后**回落到常规反代池**并成功；
 *   3. pin 连续失败达到阈值后进入冷却，后续请求**不再尝试 pin**（直接走池）；
 *   4. pin 的单独超时严格短于常规反代超时。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PIN = '9.9.9.9'
const POOL = '198.51.100.10'
const TARGET = 'app.example-nocf.test'

let failHosts: Set<string> = new Set()
let tried: string[] = []

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    tried.push(address.hostname)
    const host = address.hostname
    return {
      opened: (async () => {
        if (failHosts.has(host)) throw new Error(`连接失败：${host}`)
      })(),
      readable: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
      writable: new WritableStream(),
      close: async () => {},
    }
  },
}))

beforeEach(async () => {
  failHosts = new Set()
  tried = []
  const { clearEndpointHealth } = await import('../src/outbound/endpoint-health')
  clearEndpointHealth()
})

afterEach(() => {
  vi.clearAllMocks()
})

const { dial, PINNED_RELAY_CONNECT_TIMEOUT_MS, RELAY_CONNECT_TIMEOUT_MS } = await import(
  '../src/outbound/dial'
)

function dialOptions(): Parameters<typeof dial>[0] {
  return {
    hostname: TARGET,
    port: 443,
    resolvePreferred: false,
    timeoutMs: 2000,
    pinnedRelays: [{ ip: PIN, port: 443 }],
    relayPool: { userEntries: POOL, useBuiltin: false },
  }
}

describe('固定反代入口（pin）', () => {
  it('pin 的超时严格短于常规反代', () => {
    expect(PINNED_RELAY_CONNECT_TIMEOUT_MS).toBeLessThan(RELAY_CONNECT_TIMEOUT_MS)
  })

  it('pin 可用时优先走 pin', async () => {
    // 目标直连失败，pin 可用
    failHosts = new Set([TARGET])
    const res = await dial(dialOptions())
    expect(res.endpoint.startsWith(PIN)).toBe(true)
  })

  it('pin 失败后回落到常规反代池', async () => {
    failHosts = new Set([TARGET, PIN])
    const res = await dial(dialOptions())
    expect(res.endpoint.startsWith(POOL)).toBe(true)
    // pin 确实被尝试过（优先语义），只是失败后回落
    expect(tried).toContain(PIN)
  })

  it('pin 连续失败后进入冷却，后续请求不再尝试 pin', async () => {
    failHosts = new Set([TARGET, PIN])

    // 前两次：仍会尝试 pin（并因此记入失败计数，阈值 2）
    await dial(dialOptions())
    await dial(dialOptions())

    tried = []
    const res = await dial(dialOptions())
    expect(res.endpoint.startsWith(POOL)).toBe(true)
    // 关键断言：冷却生效 —— 第三次**没有**再去碰失效的 pin
    expect(tried).not.toContain(PIN)
  })
})
