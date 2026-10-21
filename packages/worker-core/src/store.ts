/**
 * 存储抽象：优先使用 KV，未绑定时降级为内存存储（本地调试用）
 */
import type { Env } from './types'

export interface Store {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

export class KvStore implements Store {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key)
  }

  async put(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds >= 60) {
      await this.kv.put(key, value, { expirationTtl: ttlSeconds })
    } else {
      await this.kv.put(key, value)
    }
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    let cursor: string | undefined
    do {
      const res = await this.kv.list({ prefix, cursor })
      for (const k of res.keys) out.push(k.name)
      cursor = res.list_complete ? undefined : res.cursor
    } while (cursor)
    return out
  }
}

/** 本地开发 / 单元测试用的内存实现 */
export class MemoryStore implements Store {
  private readonly data = new Map<string, { value: string; expiresAt: number }>()

  async get(key: string): Promise<string | null> {
    const item = this.data.get(key)
    if (!item) return null
    if (item.expiresAt > 0 && item.expiresAt <= Date.now()) {
      this.data.delete(key)
      return null
    }
    return item.value
  }

  async put(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0
    this.data.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix))
  }
}

export function createStore(env: Env): Store {
  return env.KV ? new KvStore(env.KV) : new MemoryStore()
}
