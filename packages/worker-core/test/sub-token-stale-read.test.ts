import { describe, expect, it, beforeEach, vi } from 'vitest'
import { loadSubSecret, resetSubSecretState, signSubToken, verifySubToken } from '../src/sub-token'
import { KvStore } from '../src/store'

/** 一个「像 CF KV 一样」的假命名空间：能观察写入次数，并可模拟陈旧读。 */
class FakeKvNamespace {
  writes = 0
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

const SUB_SECRET_KEY = 'SUB_TOKEN_SECRET'

describe('订阅签名密钥与 KV 陈旧读', () => {
  beforeEach(() => {
    resetSubSecretState()
  })

  it('键存在时读到的是同一个密钥（不轮换、不写）', async () => {
    const kv = new FakeKvNamespace()
    const store = new KvStore(kv as unknown as KVNamespace)
    await kv.put(SUB_SECRET_KEY, 'existing-secret')
    const writesBefore = kv.writes

    const a = await loadSubSecret(store)
    const b = await loadSubSecret(store)
    expect(a).toBe('existing-secret')
    expect(b).toBe('existing-secret')
    expect(kv.writes).toBe(writesBefore)
  })

  it('陈旧读期间不生成新密钥、不写 KV（已签发的链接不能失效）', async () => {
    const kv = new FakeKvNamespace()
    const store = new KvStore(kv as unknown as KVNamespace)
    await kv.put(SUB_SECRET_KEY, 'existing-secret')
    const writesBefore = kv.writes

    // 模拟陈旧读：键读不到
    kv.stale = true
    for (let i = 0; i < 20; i++) {
      await loadSubSecret(store)
    }
    // 没有产生任何写 ⇒ 已签发的链接不受影响
    expect(kv.writes).toBe(writesBefore)
  })

  it('陈旧读窗口内签出的令牌仍可互相验证（隔离体内密钥稳定）', async () => {
    const kv = new FakeKvNamespace()
    const store = new KvStore(kv as unknown as KVNamespace)
    kv.stale = true

    const secret1 = await loadSubSecret(store)
    const token = await signSubToken(secret1)
    const secret2 = await loadSubSecret(store)
    expect(secret2).toBe(secret1)
    expect((await verifySubToken(secret2, token)).ok).toBe(true)
    expect(kv.writes).toBe(0)
  })

  it('键持续缺失超过传播窗口后才生成并写入，且只写一次', async () => {
    const kv = new FakeKvNamespace()
    const store = new KvStore(kv as unknown as KVNamespace)
    kv.stale = true

    await loadSubSecret(store)
    expect(kv.writes).toBe(0)

    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 91_000)
    try {
      const secret = await loadSubSecret(store)
      expect(secret).toHaveLength(64)
      expect(kv.writes).toBe(1)
      // 之后的读不再重复生成
      await loadSubSecret(store)
      expect(kv.writes).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
