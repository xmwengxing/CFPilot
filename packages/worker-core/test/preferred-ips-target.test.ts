/**
 * 回填的目标池、清洗与上限 —— 回归测试。
 *
 * ## 背景
 *
 * 回填有两个目标池，语义完全不同：
 *
 *   - **本地优选池**（`LOCAL_PREFERRED_IPS`）—— 订阅的 L1 来源，进订阅；
 *   - **自定义反代入口池**（`config.relayPool`）—— 只影响出站选路，不进订阅。
 *
 * 反代优选产出的是「第三方的反代服务器」，写进反代入口池才对。
 *
 * 另外两件事也在这里钉住：
 *   - **看不懂的行要跳过并回报** —— 解析层对无效行是静默跳过的，
 *     用户看到「保存成功」但列表里没有，那种失败最难查；
 *   - **池子要有条数上限** —— 池子是候选池，订阅最终只按 maxNodes 取一部分，
 *     留几万条会让每次订阅请求都读 + 解析一份巨大的 KV 值。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { DEFAULT_CONFIG, LOCAL_IPS_KEY, mergeConfig } from '../src/config'
import type { Store } from '../src/store'
import type { UserConfig } from '../src/types'

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

beforeEach(() => {
  store = new MemStore()
  store.map.set('SCANNER_TOKEN', SCANNER_TOKEN)
  config = mergeConfig(DEFAULT_CONFIG, { add: '1.2.3.4:443' })
  store.map.set(CONFIG_KEY, JSON.stringify(config))
})

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
    onConfigChanged: () => undefined,
  }
}

async function push(body: Record<string, unknown>): Promise<{
  status: number
  json: Record<string, unknown>
}> {
  const res = await handleApi(
    new Request('https://panel.example.com/api/v1/preferred-ips', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SCANNER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    new URL('https://panel.example.com/api/v1/preferred-ips'),
    ctx()
  )
  expect(res).not.toBeNull()
  const json = (await res!.json()) as Record<string, unknown>
  return { status: res!.status, json }
}

async function savedConfig(): Promise<UserConfig> {
  const raw = await store.get(CONFIG_KEY)
  return JSON.parse(raw ?? '{}') as UserConfig
}

describe('回填到自定义反代入口池', () => {
  it('写进 config.relayPool，不碰本地优选池', async () => {
    const { status, json } = await push({
      ips: ['9.9.9.9:443#LAX', 'relay.example.com:443'],
      target: 'relay',
    })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.target).toBe('relay')

    const saved = await savedConfig()
    expect(saved.relayPool).toContain('9.9.9.9:443#LAX')
    expect(saved.relayPool).toContain('relay.example.com:443')
    // 本地优选池不能被写
    expect(await store.get(LOCAL_IPS_KEY)).toBeNull()
  })

  it('覆盖模式：先清空再写入', async () => {
    config = mergeConfig(DEFAULT_CONFIG, { relayPool: '1.1.1.1:443' })
    store.map.set(CONFIG_KEY, JSON.stringify(config))

    await push({ ips: ['9.9.9.9:443'], target: 'relay' })
    expect((await savedConfig()).relayPool).toBe('9.9.9.9:443')
  })

  it('增量模式：保留原有的，只补新的', async () => {
    config = mergeConfig(DEFAULT_CONFIG, { relayPool: '1.1.1.1:443' })
    store.map.set(CONFIG_KEY, JSON.stringify(config))

    const { json } = await push({
      ips: ['9.9.9.9:443'],
      mode: 'append',
      target: 'relay',
    })
    expect(json.added).toBe(1)
    const pool = (await savedConfig()).relayPool ?? ''
    expect(pool).toContain('1.1.1.1:443')
    expect(pool).toContain('9.9.9.9:443')
  })

  it('反代入口池写满了就截断，并报出超了多少', async () => {
    const many: string[] = []
    for (let i = 0; i < 260; i++) many.push(`9.9.9.${i % 256}:443`)
    const { json } = await push({ ips: many, target: 'relay' })
    expect(json.overLimit).toBeGreaterThan(0)
    expect(((await savedConfig()).relayPool ?? '').split('\n').length).toBeLessThanOrEqual(200)
  })
})

describe('回填的清洗与上限', () => {
  it('看不懂的行被跳过，并报出跳过了几行', async () => {
    const { json } = await push({ ips: ['9.9.9.9:443#LAX', '这不是一条地址', '  '] })
    expect(json.invalid).toBe(1)
    expect(json.count).toBe(1)
    expect(await store.get(LOCAL_IPS_KEY)).toBe('9.9.9.9:443#LAX')
  })

  it('全是无效行时**不动池子**（不能当成「清空」）', async () => {
    store.map.set(LOCAL_IPS_KEY, '1.2.3.4:443')
    const { status } = await push({ ips: ['这不是一条地址', '也不是'] })
    expect(status).toBe(400)
    // 池子必须原样还在
    expect(await store.get(LOCAL_IPS_KEY)).toBe('1.2.3.4:443')
  })

  it('空列表仍然按「清空」处理（历史语义）', async () => {
    store.map.set(LOCAL_IPS_KEY, '1.2.3.4:443')
    const { status } = await push({ ips: [] })
    expect(status).toBe(200)
    expect(await store.get(LOCAL_IPS_KEY)).toBe('')
  })

  it('本地优选池超过上限时截断并报出超了多少', async () => {
    const many: string[] = []
    for (let i = 0; i < 5100; i++) many.push(`9.9.${Math.floor(i / 256) % 256}.${i % 256}:443`)
    const { json } = await push({ ips: many })
    expect(json.overLimit).toBeGreaterThan(0)
    const stored = (await store.get(LOCAL_IPS_KEY)) ?? ''
    expect(stored.split('\n').filter(Boolean).length).toBeLessThanOrEqual(5000)
  })
})
