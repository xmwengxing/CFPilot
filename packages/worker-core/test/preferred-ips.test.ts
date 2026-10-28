/**
 * 回填接口的行为测试。
 *
 * ## 为什么要测
 *
 * 优选池有四层，订阅节点来自 L1 + L2：
 *
 *   L1  LOCAL_PREFERRED_IPS  ← 本地真连接优选的结果（回填写入这里）
 *   L2  config.add           ← 面板「手动优选 IP」输入框
 *
 * 旧实现只写 L1、不动 L2 → 订阅里 **L1 + L2 都在** →
 * 用户看到「回填了但订阅仍是旧 IP 的节点」。
 *
 * 现在回填会同时清空 L2，让订阅里只有本次回填的结果。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { DEFAULT_CONFIG, LOCAL_IPS_KEY, mergeConfig } from '../src/config'
import type { Store } from '../src/store'
import type { UserConfig } from '../src/types'

/** 内存 Store（够用，且不依赖 Workers 运行时）。 */
class MemStore implements Store {
  map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix))
  }
}

const CONFIG_KEY = 'CONFIG'
const SCANNER_TOKEN = 'test-token'

let store: MemStore
let config: UserConfig
let configChanged = 0

beforeEach(() => {
  store = new MemStore()
  // 回填接口用 Bearer 令牌鉴权，令牌要在 Store 里
  store.map.set('SCANNER_TOKEN', SCANNER_TOKEN)
  config = mergeConfig(DEFAULT_CONFIG, {
    add: '1.2.3.4:443\n5.6.7.8:443',
    addApi: 'https://example.test/pool.txt',
  })
  configChanged = 0
})

/** 造一个带 Bearer 令牌的请求。 */
function authReq(path: string, body?: unknown): Request {
  return new Request(`https://panel.example.com/api/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SCANNER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** 造上下文。 */
function ctx(): ApiContext {
  return {
    store,
    env: {} as never,
    config,
    auth: {
      panelPath: '/panel',
      sessionOk: true,
      generatedPassword: false,
    } as never,
    onConfigChanged: () => {
      // 模拟缓存刷新（真实实现里会重新 loadConfig）
      configChanged++
    },
  }
}

/** 调回填接口。 */
async function push(ips: string[]): Promise<{ count: number; clearedManual: boolean }> {
  const res = await handleApi(
    authReq('/preferred-ips', { ips }),
    new URL(`https://panel.example.com/api/v1/preferred-ips`),
    ctx()
  )
  expect(res).not.toBeNull()
  const json = (await res!.json()) as { ok: boolean; count: number; clearedManual: boolean }
  expect(json.ok).toBe(true)
  return { count: json.count, clearedManual: json.clearedManual }
}

describe('POST /api/v1/preferred-ips（回填）', () => {
  it('写入本地池', async () => {
    const r = await push(['9.9.9.9:443#LAX'])
    expect(r.count).toBe(1)
    expect(await store.get(LOCAL_IPS_KEY)).toBe('9.9.9.9:443#LAX')
  })

  it('覆盖面板原有的「手动优选 IP」（config.add 被清空）', async () => {
    // 先把带 add 的配置落盘（模拟用户之前手填过）
    await store.put(CONFIG_KEY, JSON.stringify(config))
    expect(config.add).not.toBe('')

    const r = await push(['9.9.9.9:443#LAX'])

    expect(r.clearedManual).toBe(true)
    // 配置里的 add 必须被清空
    const saved = JSON.parse((await store.get(CONFIG_KEY))!) as UserConfig
    expect(saved.add).toBe('')
    // 但远程池不受影响
    expect(saved.addApi).toBe('https://example.test/pool.txt')
  })

  it('手填池本来为空时不算覆盖', async () => {
    config = mergeConfig(DEFAULT_CONFIG, { add: '' })
    await store.put(CONFIG_KEY, JSON.stringify(config))

    const r = await push(['9.9.9.9:443#LAX'])
    expect(r.clearedManual).toBe(false)
  })

  it('空列表也会清空手填池（清空语义）', async () => {
    await store.put(CONFIG_KEY, JSON.stringify(config))
    const r = await push([])
    expect(r.count).toBe(0)
    expect(r.clearedManual).toBe(true)
    const saved = JSON.parse((await store.get(CONFIG_KEY))!) as UserConfig
    expect(saved.add).toBe('')
  })

  it('触发配置刷新回调', async () => {
    await store.put(CONFIG_KEY, JSON.stringify(config))
    await push(['9.9.9.9:443#LAX'])
    expect(configChanged).toBe(1)
  })

  it('令牌无效时拒绝', async () => {
    const res = await handleApi(
      new Request('https://panel.example.com/api/v1/preferred-ips', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
        body: JSON.stringify({ ips: ['1.1.1.1:443'] }),
      }),
      new URL('https://panel.example.com/api/v1/preferred-ips'),
      ctx()
    )
    expect(res!.status).toBe(401)
  })
})
