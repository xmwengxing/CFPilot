/**
 * 落地代理健康记忆的**集成**行为 —— 回归测试。
 *
 * ## 守的是什么
 *
 * 落地代理组是**顺序故障转移**（`dial.ts` 的 `dialLanding`）：
 * 第一个失败才试第二个。
 *
 * 于是一个已经宕机的代理节点会让**每一个请求都先白等一次完整的代理超时** ——
 * 而且每个请求都重复付这笔账。一个死节点就能把整条链路拖成半瘫痪。
 *
 * 健康记忆让**连续失败**的节点进入冷却，冷却期内直接跳过。
 *
 * ## 打桩方式
 *
 * 与 `dial-concurrency.test.ts` 相同：mock `cloudflare:sockets` 的 `connect()`，
 * 记录每个地址**是否真的被试过**。断言的是行为（哪些节点被试），
 * 不绑定具体时序。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearProxyHealth } from '../src/outbound/proxy-health'

/** 记录每次 connect() 试过的地址 */
let tried: string[] = []
/** 这些代理地址的 connect() 会直接失败（模拟死节点） */
let deadProxies: Set<string> = new Set()

vi.mock('cloudflare:sockets', () => ({
  connect: (address: { hostname: string; port: number }) => {
    tried.push(address.hostname)
    const dead = deadProxies.has(address.hostname)

    if (dead) {
      // 死节点：连接建立后立刻断开 —— SOCKS5 握手读不到任何字节
      return {
        opened: Promise.resolve(),
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        writable: new WritableStream<Uint8Array>({ write() {} }),
        close: async () => {},
      }
    }

    // 活节点：一个会正确应答 SOCKS5 握手的假代理
    //   ① 问候应答 [0x05, 0x00]（选择「无需认证」）
    //   ② CONNECT 应答 [0x05, 0x00, 0x00, 0x01, 4 字节地址, 2 字节端口]
    let stage = 0
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x05, 0x00]))
        stage = 1
      },
      pull(controller) {
        if (stage === 1) {
          stage = 2
          controller.enqueue(new Uint8Array([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        }
      },
    })
    const writable = new WritableStream<Uint8Array>({ write() {} })
    return {
      opened: Promise.resolve(),
      readable,
      writable,
      close: async () => {},
    }
  },
}))

const { dial } = await import('../src/outbound/dial')

const DEAD = 'dead.proxy'
const ALIVE = 'alive.proxy'

/** 最小可用的拨号选项 */
function options(proxies: Array<{ host: string; port: number; kind: 'socks5' }>) {
  return {
    hostname: 'target.example',
    port: 443,
    proxies,
    proxyMode: 'only' as const,
    budgetMs: 3000,
    timeoutMs: 300,
  }
}

describe('落地代理健康记忆（集成）', () => {
  beforeEach(() => {
    tried = []
    deadProxies = new Set([DEAD])
    clearProxyHealth()
  })

  it('第一个代理连续失败后，后续请求跳过它', async () => {
    const proxies = [
      { host: DEAD, port: 1080, kind: 'socks5' as const },
      { host: ALIVE, port: 1080, kind: 'socks5' as const },
    ]

    // 前两次请求：坏节点还没进冷却，会被试（失败计数 1 → 2）
    tried = []
    await dial(options(proxies)).catch(() => undefined)
    expect(tried).toContain(DEAD)

    tried = []
    await dial(options(proxies)).catch(() => undefined)
    expect(tried).toContain(DEAD)

    // 第三次：连续失败已达阈值 ⇒ 进入冷却 ⇒ 不再试它
    tried = []
    await dial(options(proxies)).catch(() => undefined)
    expect(tried).not.toContain(DEAD)
    expect(tried).toContain(ALIVE)
  })

  it('冷却期满后重新回到候选池', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = Date.now()
      const proxies = [
        { host: DEAD, port: 1080, kind: 'socks5' as const },
        { host: ALIVE, port: 1080, kind: 'socks5' as const },
      ]
      await dial(options(proxies)).catch(() => undefined)
      await dial(options(proxies)).catch(() => undefined)

      // 坏节点恢复
      deadProxies = new Set()
      // 冷却期内仍被跳过（这是设计：冷却用来避开抖动）
      tried = []
      await dial(options(proxies)).catch(() => undefined)
      expect(tried).not.toContain(DEAD)

      // 冷却期满（30 秒）⇒ 重新被试 ⇒ 这次成功 ⇒ 健康记录清零
      vi.setSystemTime(new Date(base + 31_000))
      tried = []
      await dial(options(proxies)).catch(() => undefined)
      expect(tried).toContain(DEAD)
    } finally {
      vi.useRealTimers()
    }
  })
})
