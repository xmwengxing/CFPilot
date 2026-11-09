import { describe, expect, it, beforeEach, vi } from 'vitest'
import { loadConfig, saveConfig, resetConfigBootstrapState } from '../src/config'
import { KvStore } from '../src/store'
import type { Env } from '../src/types'

/**
 * 一个「像 CF KV 一样」的假命名空间：能观察写入次数，并可模拟**陈旧读**。
 *
 * Cloudflare KV 的读是最终一致的（边缘缓存约 60 秒）：
 * 部署刚写进 KV 的正确值，本 isolate 的头几次读**仍可能读不到**。
 * 内核若把「读不到」当成「需要引导」，就会重新生成一个随机 UUID 写回，
 * 把部署时写进 KV 的正确 UUID 覆盖掉 —— 而这类写用户点不到也拦不住。
 */
class FakeKvNamespace {
  writes = 0
  /** 设为 true 时，读永远返回「键不存在」（模拟陈旧读） */
  stale = false
  private readonly data = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    if (this.stale) return null
    return this.data.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    this.writes++
    this.data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.writes++
    this.data.delete(key)
  }

  async list(): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    return { keys: [...this.data.keys()].map((name) => ({ name })), list_complete: true }
  }
}

function makeStore(): { store: KvStore; kv: FakeKvNamespace } {
  const kv = new FakeKvNamespace()
  return { store: new KvStore(kv as unknown as KVNamespace), kv }
}

describe('loadConfig 的引导与 KV 陈旧读', () => {
  beforeEach(() => {
    resetConfigBootstrapState()
  })

  it('KV 里已有正确的 uuid 时不覆盖它', async () => {
    const { store, kv } = makeStore()
    await saveConfig(store, { uuid: 'deployed-uuid', trojanPassword: 'deployed-trojan' } as never)
    const writesAfterSave = kv.writes

    const loaded = await loadConfig(store, {} as Env)
    expect(loaded.uuid).toBe('deployed-uuid')
    expect(loaded.trojanPassword).toBe('deployed-trojan')
    expect(kv.writes).toBe(writesAfterSave)
  })

  it('陈旧读（读不到键）期间不产生任何写，也不换掉 uuid', async () => {
    const { store, kv } = makeStore()
    await saveConfig(store, { uuid: 'deployed-uuid', trojanPassword: 'deployed-trojan' } as never)
    const writesAfterSave = kv.writes

    // 模拟陈旧读：键读不到
    kv.stale = true
    for (let i = 0; i < 20; i++) {
      const loaded = await loadConfig(store, {} as Env)
      // 引导尚未触发 ⇒ uuid 保持空（fail-closed），绝不写入
      expect(loaded.uuid).toBe('')
    }
    expect(kv.writes).toBe(writesAfterSave)
  })

  it('键持续缺失超过传播窗口后才引导，且只写一次', async () => {
    const { store, kv } = makeStore()
    kv.stale = true
    // 第一次读：记录「缺失起始时刻」，不写
    await loadConfig(store, {} as Env)
    expect(kv.writes).toBe(0)

    // 模拟时间流逝（推进 91 秒 > 90 秒的传播窗口宽限）
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 91_000)
    try {
      const loaded = await loadConfig(store, {} as Env)
      expect(loaded.uuid).not.toBe('')
      expect(kv.writes).toBe(1)
      // 之后的读不再重复引导
      await loadConfig(store, {} as Env)
      expect(kv.writes).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
