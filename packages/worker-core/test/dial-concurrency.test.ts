/**
 * 出站拨号并发宽度 —— 回归测试。
 *
 * ## 守护的缺陷（2026-10-28 核实）
 *
 * Cloudflare Workers **单个请求内同时打开的出站 TCP 连接上限是 6 条**。
 * 收敛前：
 *
 *   - `relay.ts` 的 `RELAY_BATCH_SIZE = 8`；
 *   - 目标是 Cloudflare 网段时，反代第一批（8 个）通过 `relayAsPrimary`
 *     与直连 / 优选候选进入**同一个竞速池**；
 *   - `raceDial()` 对池里的候选**全部同时**发起 `connect()`。
 *
 * 最坏情况 = 1（目标直连）+ N（DoH 解析出的优选 IP）+ 8（反代）
 * = 10 条以上同时连接。超出上限的那些 `connect()` 会立刻抛错，
 * 表现是：候选被白白浪费、`onFailure` 分级诊断里混进一堆假失败、
 * 偶发「明明有可用候选却失败」。
 *
 * ## 这组测试钉住的行为
 *
 *   1. 单次竞速里**同时在飞**的连接数 ≤ 平台上限（6）；
 *   2. 窗口化**不丢候选**：前一批全失败后仍会试后面的候选；
 *   3. `concurrent: false` 保持原有顺序语义（在飞数 ≤ 1）；
 *   4. 全部失败时错误信息里留有失败证据（不是空错误）。
 *
 * ## 打桩方式
 *
 * 与 `dial-scheduling.test.ts` 相同：mock `cloudflare:sockets` 的 `connect()`，
 * 记录「同时在飞的连接数」与「每个地址是否真的被试过」。
 * 断言的是**行为**（峰值宽度、候选覆盖率、最终结果），
 * 不绑定具体调度时序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELAY_BATCH_SIZE } from '../src/outbound/relay'

/** 一次 `connect()` 尝试的记录 */
interface ConnectRecord {
  host: string
  /** 该次 connect() 发起时，已在飞的连接数（含自己） */
  inflight: number
}

/** 每次连接建立的模拟耗时（ms）—— 让并发窗口可观察 */
const CONNECT_DELAY_MS = 5

/** 这些地址的 connect() 会失败 */
let failHosts: Set<string> = new Set()
/** connect() 全部失败（不需要逐个列举地址时用） */
let failAll = false
/** 记录所有 connect() 尝试（按发起顺序） */
let records: ConnectRecord[] = []
/** 当前在飞连接数 */
let inflight = 0
/** 历史峰值（同时在飞的最大连接数） */
let peak = 0

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    inflight++
    peak = Math.max(peak, inflight)
    records.push({ host: address.hostname, inflight })

    // 释放并发名额：建连成功 / 失败 / 被 close 都只释放一次
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      inflight--
    }

    const host = address.hostname
    return {
      // Workers 语义：`connect()` 同步返回 socket，建连结果在 `opened` 上；
      // 建连期间这条连接**占着**并发名额
      opened: (async () => {
        await new Promise((resolve) => setTimeout(resolve, CONNECT_DELAY_MS))
        release()
        if (failAll || failHosts.has(host)) throw new Error(`连接失败：${host}`)
      })(),
      readable: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
      writable: new WritableStream(),
      close: async () => {
        release()
      },
    }
  },
}))

beforeEach(() => {
  failHosts = new Set()
  failAll = false
  records = []
  inflight = 0
  peak = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

const { dial, MAX_SIMULTANEOUS_CONNECTS } = await import('../src/outbound/dial')

/**
 * 12 个「优选 IP」候选。
 *
 * 用 203.0.113.0/24（RFC 5737 TEST-NET-3）：它**不在** CF 网段表里，
 * 所以不会被 `buildRouteCandidates` 降权，会保持顺序进入直连 / 优选组。
 * （注意别用 192.0.2.0/24 —— 那是 CF 网段表里的保留段，会被降权。）
 */
const OPTIMIZED_HOSTS: readonly string[] = Array.from(
  { length: 12 },
  (_, i) => `203.0.113.${i + 1}`
)

/** 直连目标（非 CF 网段，避免触发反代路径） */
const TARGET = 'target.example'

describe('拨号并发宽度收敛到平台上限（6 条）', () => {
  it('并发上限常量 = 6，反代批次不超过一个并发窗口', () => {
    // 平台硬约束：Workers 单请求同时出站 TCP 连接上限 6 条
    expect(MAX_SIMULTANEOUS_CONNECTS).toBe(6)
    // 反代一批 = 一个并发窗口，不能超过平台上限
    expect(RELAY_BATCH_SIZE).toBeLessThanOrEqual(MAX_SIMULTANEOUS_CONNECTS)
    expect(RELAY_BATCH_SIZE).toBe(6)
  })

  it('12 个优选候选竞速时，同时在飞连接数峰值 ≤ 6，且所有候选都被尝试', async () => {
    failAll = true

    await expect(
      dial({
        hostname: TARGET,
        port: 443,
        optimizedIps: OPTIMIZED_HOSTS.map((ip) => ({ ip, port: 443 })),
        resolvePreferred: false,
        concurrent: true,
        timeoutMs: 2000,
      })
    ).rejects.toThrow()

    // 关键断言：任何时刻都不能超过平台上限（否则超出部分直接假失败）
    expect(peak).toBeLessThanOrEqual(MAX_SIMULTANEOUS_CONNECTS)
    // 同时确认仍是「并发」而非退化成串行（宽度应被真正用上）
    expect(peak).toBeGreaterThan(1)

    // 窗口化 ≠ 截断：直连目标 + 12 个优选 IP 全部被试过（共 13 个候选）
    expect(records).toHaveLength(13)
    for (const ip of OPTIMIZED_HOSTS) {
      expect(records.some((r) => r.host === ip)).toBe(true)
    }
  })

  it('前 6 个候选全失败、第 7 个成功 → 最终成功且第 7 个确实被尝试', async () => {
    // 候选顺序：直连目标在最前，其次按 optimizedIps 顺序。
    // 第 7 个候选 = OPTIMIZED_HOSTS[5]（前 5 个优选 IP 是第 2~6 个候选）。
    const seventh = OPTIMIZED_HOSTS[5]!
    // 除第 7 个之外全部失败
    failHosts = new Set([TARGET, ...OPTIMIZED_HOSTS.filter((ip) => ip !== seventh)])

    const result = await dial({
      hostname: TARGET,
      port: 443,
      optimizedIps: OPTIMIZED_HOSTS.map((ip) => ({ ip, port: 443 })),
      resolvePreferred: false,
      concurrent: true,
      timeoutMs: 2000,
    })

    // 1) 最终成功，且成功的就是第 7 个候选
    expect(result.endpoint).toBe(`${seventh}:443`)

    // 2) 第 7 个候选**确实被尝试过** —— 证明第一批全失败后窗口继续推进，
    //    没有把候选截断成「只试前 6 个」
    const seventhIndex = records.findIndex((r) => r.host === seventh)
    expect(seventhIndex).toBeGreaterThanOrEqual(0)
    // 它是在前 6 个候选都被试过之后才被尝试的（第二窗口）
    expect(seventhIndex).toBeGreaterThanOrEqual(6)

    // 3) 成功之后不再开新窗口（第 12 个优选 IP 根本不该被碰）
    expect(records.some((r) => r.host === OPTIMIZED_HOSTS[11]!)).toBe(false)
  })

  it('concurrent: false 保持顺序语义（任意时刻在飞数 ≤ 1）', async () => {
    failAll = true

    await expect(
      dial({
        hostname: TARGET,
        port: 443,
        optimizedIps: OPTIMIZED_HOSTS.map((ip) => ({ ip, port: 443 })),
        resolvePreferred: false,
        concurrent: false,
        timeoutMs: 2000,
      })
    ).rejects.toThrow()

    // 顺序故障转移：一次只连一个，不能因为「并发上限是 6」就擅自并发
    expect(peak).toBeLessThanOrEqual(1)
    // 顺序模式仍然覆盖全部候选
    expect(records).toHaveLength(13)
  })

  it('全部候选失败 → 抛错且错误信息保留失败证据（不是空错误）', async () => {
    failAll = true

    let caught: unknown
    try {
      await dial({
        hostname: TARGET,
        port: 443,
        optimizedIps: OPTIMIZED_HOSTS.map((ip) => ({ ip, port: 443 })),
        resolvePreferred: false,
        concurrent: true,
        timeoutMs: 2000,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message.length).toBeGreaterThan(0)
    // 总候选数 / 批次数 / 具体失败原因都要保留（诊断不能丢）
    expect(message).toContain('均失败')
    expect(message).toMatch(/分 \d+ 批/)
    expect(message).toContain('连接失败')
    expect(message).toContain(OPTIMIZED_HOSTS[0]!)
  })

  it('反代第一批与优选候选同池竞速时也受同一窗口约束（最坏情况）', async () => {
    failAll = true
    // 目标在 CF 网段 → 反代第一批通过 relayAsPrimary 进入主竞速池，
    // 与 12 个优选 IP 同池 —— 这正是原先 10+ 条并发的最坏情况
    const relayHosts = Array.from({ length: 6 }, (_, i) => `198.51.100.${i + 1}`)

    await expect(
      dial({
        hostname: '104.16.0.1',
        port: 443,
        optimizedIps: OPTIMIZED_HOSTS.map((ip) => ({ ip, port: 443 })),
        relay: relayHosts.map((ip) => ({ ip, port: 443, label: ip })),
        resolvePreferred: false,
        concurrent: true,
        timeoutMs: 2000,
      })
    ).rejects.toThrow()

    // 18 个主竞速候选（12 优选 + 6 反代）也必须收敛到 6 条并发
    expect(peak).toBeLessThanOrEqual(MAX_SIMULTANEOUS_CONNECTS)
    // 且每一个候选都真的被试过（窗口化不丢候选）
    for (const ip of [...OPTIMIZED_HOSTS, ...relayHosts]) {
      expect(records.some((r) => r.host === ip)).toBe(true)
    }
  })
})
