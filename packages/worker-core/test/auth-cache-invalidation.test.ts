/**
 * 鉴权缓存失效 —— 回归测试。
 *
 * ## 守护的缺陷（Gemini 审计 P1-4）
 *
 * `getAuth` 的模块级缓存是 60 秒，而登录成功时会做两件改 KV 的事：
 * `upgradePasswordHash`（旧哈希 → PBKDF2）与 `discardPlaintextPassword`
 * （删掉自动生成密码的明文副本）。缓存不失效时：
 *
 *   1. 登录后 60 秒内 `/api/v1/status` 仍把**已删除的明文密码**下发；
 *   2. 60 秒内重复登录会再触发一次 PBKDF2 派生 + KV 写（免费版 1000 写/天）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { discardPlaintextPassword } from '../src/auth'
import { getAuth, invalidateAuth } from '../src/routes/shared'
import type { Env, } from '../src/types'
import type { Store } from '../src/store'

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

beforeEach(() => {
  invalidateAuth()
})

describe('invalidateAuth', () => {
  it('清缓存后重新引导：明文密码不再返回', async () => {
    const store = new MemStore()
    const env = {} as Env

    // 首次引导（未注入 PANEL_PASSWORD、内存 Store）：生成一次性明文密码
    const first = await getAuth(store, env)
    expect(first.generatedPassword).toBeTruthy()

    // 登录成功路径：明文只保留到首次登录成功
    await discardPlaintextPassword(store)

    // 未清缓存 → 60 秒内仍从缓存里读到已删除的明文（这就是缺陷表现）
    const cached = await getAuth(store, env)
    expect(cached.generatedPassword).toBe(first.generatedPassword)

    // 清缓存 → 重新 ensureBootstrap：KV 里只剩哈希，不再有明文
    invalidateAuth()
    const fresh = await getAuth(store, env)
    expect(fresh.generatedPassword).toBeNull()
    // 面板路径不变（同一个键）
    expect(fresh.panelPath).toBe(first.panelPath)
  })
})
