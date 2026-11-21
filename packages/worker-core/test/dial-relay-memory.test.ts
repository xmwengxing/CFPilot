/**
 * 反代入口「按域名成功记忆」—— 回归测试。
 *
 * ## 守护的场景
 *
 * 出厂不再内置固定入口后，某域名走 `stableRelayIndex()` 的哈希选路。
 * 若哈希选中的入口对这个域名不可用（第三方反代入口的 SNI 策略各不相同），
 * 表现为「升级后原本能打开的站点突然打不开」，即使池里另有一个能用。
 *
 * 成功记忆让同一域名复用**上次真正成功**的入口：
 *   - 第二次请求直接命中，不再重复踩坏入口；
 *   - 入口失效时依赖 endpoint-health 熔断，自动重新学一个。
 *
 * ## 打桩方式
 *
 * mock `cloudflare:sockets`，记录每次 connect 的 hostname；
 * 用 `stableRelayIndex` 反查一个「哈希正好指向坏入口」的域名，使测试确定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stableRelayIndex } from '../src/outbound/relay'

const BAD = '9.9.9.9'
const GOOD = '198.51.100.20'

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
  const { clearRelaySuccessMemory } = await import('../src/outbound/dial')
  clearRelaySuccessMemory()
})

afterEach(() => {
  vi.clearAllMocks()
})

const { dial } = await import('../src/outbound/dial')

/** 找一个哈希正好落在第 0 个入口（BAD）的域名，让 sticky 选择可预测。 */
function hostWithStickyZero(count: number): string {
  for (let i = 0; i < 500; i += 1) {
    const h = `app${i}.example-nocf.test`
    if (stableRelayIndex(h, count) === 0) return h
  }
  throw new Error('找不到合适的测试域名')
}

function opts(hostname: string): Parameters<typeof dial>[0] {
  return {
    hostname,
    port: 443,
    resolvePreferred: false,
    timeoutMs: 2000,
    relayPool: { userEntries: `${BAD}\n${GOOD}`, useBuiltin: false },
  }
}

describe('反代入口成功记忆', () => {
  it('第一次踩过坏入口后，第二次直接命中上次成功的入口', async () => {
    const host = hostWithStickyZero(2)
    failHosts = new Set([host, BAD])

    // 第 1 次：粘性哈希指向 BAD → 失败 → 滑动窗口到 GOOD
    const first = await dial(opts(host))
    expect(first.endpoint.startsWith(GOOD)).toBe(true)
    // 直连候选（域名本身）也会被 connect 一次，只看反代入口的尝试顺序
    expect(tried.filter((h) => h !== host)).toEqual([BAD, GOOD])

    // 第 2 次：成功记忆生效，直接 GOOD，不再碰 BAD
    tried = []
    const second = await dial(opts(host))
    expect(second.endpoint.startsWith(GOOD)).toBe(true)
    expect(tried.filter((h) => h !== host)).toEqual([GOOD])
  })

  it('记忆的入口失效时回落到其它入口，并重新学习', async () => {
    const host = hostWithStickyZero(2)
    failHosts = new Set([host, BAD])
    await dial(opts(host)) // 学到 GOOD

    // GOOD 也失效：BAD 仍坏 → 两次都失败，最终抛错（证明记忆不会让请求挂死）
    failHosts = new Set([host, BAD, GOOD])
    await expect(dial(opts(host))).rejects.toBeTruthy()

    // 恢复 GOOD 后应重新可用（冷却到期或窗口继续尝试）
    failHosts = new Set([host, BAD])
    const recovered = await dial(opts(host))
    expect(recovered.endpoint.startsWith(GOOD)).toBe(true)
  })

  it('不同域名各记各的，互不干扰', async () => {
    const hostA = hostWithStickyZero(2)
    failHosts = new Set([hostA, BAD])
    await dial(opts(hostA))
    // 直连候选（域名本身）也会被 connect 一次，只看反代入口的尝试顺序
    expect(tried.filter((h) => h !== hostA)).toEqual([BAD, GOOD])

    // 另一个域名：重新从哈希开始（不是继承 hostA 的记忆）
    const hostB = 'other.example-nocf.test'
    // 让直连也失败，否则非 CF 域名会直连成功、根本走不到反代
    failHosts = new Set([hostA, hostB, BAD])
    tried = []
    const res = await dial(opts(hostB))
    expect(res.endpoint.startsWith(GOOD)).toBe(true)
    // 可能先试 GOOD（哈希正好指向它），也可能先 BAD；关键是不能串用 A 的记忆状态
    expect(tried.length).toBeGreaterThan(0)
  })

  it('假活 / TLS 告警惩罚会立即清掉成功记忆并熔断坏入口', async () => {
    const { penalizeRelayEndpoint, confirmRelaySuccess } = await import('../src/outbound/dial')
    const host = hostWithStickyZero(2)
    failHosts = new Set([host])

    // 首次建连：哈希指向 BAD 且 TCP 通（模拟“假活/返回 TLS Alert”的反代）
    const first = await dial(opts(host))
    expect(first.endpoint.startsWith(BAD)).toBe(true)
    expect(first.isRelay).toBe(true)

    // 上层收到 TLS Fatal Alert 或假活无下行 → 立即惩罚 BAD
    penalizeRelayEndpoint(host, first.endpoint, true)

    // 下一次请求必须跳过已被熔断的 BAD，直接命中 GOOD
    tried = []
    const second = await dial(opts(host))
    expect(second.endpoint.startsWith(GOOD)).toBe(true)
    expect(tried.filter((h) => h !== host)).toEqual([GOOD])

    // GOOD 真正收到有效下行后确认成功记忆
    confirmRelaySuccess(host, second.endpoint)
    tried = []
    const third = await dial(opts(host))
    expect(third.endpoint.startsWith(GOOD)).toBe(true)
    expect(tried.filter((h) => h !== host)).toEqual([GOOD])
  })
})



