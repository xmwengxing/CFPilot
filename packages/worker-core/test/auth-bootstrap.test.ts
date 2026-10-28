/**
 * ensureBootstrap 的 KV 写放大回归测试。
 *
 * ## 为什么要测
 *
 * Cloudflare KV 免费版每天只有 **1000 次写/删除**。旧实现在注入
 * `PANEL_PASSWORD` 时，**每次**引导都无条件
 * `put(ADMIN_PW_HASH)` + `delete(ADMIN_PW_PLAIN)`，而
 * `routes/shared.ts` 的 `getAuth()` 缓存只有 60 秒、且**每个边缘 isolate
 * 各有一份** —— 全球几十个 isolate 冷启动就能把写配额打光，
 * 之后面板保存配置、回填优选 IP 全部 500。
 *
 * 现在的要求：密码没变 → 一次 KV 写都不做；密码变了 → 只写一次；
 * 明文副本只在**确实存在**时才删（delete 同样计入写配额）。
 */
import { describe, expect, it } from 'vitest'
import { ensureBootstrap, verifyPassword } from '../src/auth'
import type { Store } from '../src/store'
import { ADMIN_PW_HASH_KEY, ADMIN_PW_PLAIN_KEY, PANEL_PATH_KEY } from '../src/config'

/** 统计读写次数的内存 Store：本测试的核心断言就是「写了几次」 */
class CountingStore implements Store {
  readonly data = new Map<string, string>()
  gets = 0
  puts = 0
  deletes = 0

  async get(key: string): Promise<string | null> {
    this.gets++
    return this.data.has(key) ? this.data.get(key)! : null
  }

  async put(key: string, value: string): Promise<void> {
    this.puts++
    this.data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.deletes++
    this.data.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix))
  }
}

describe('ensureBootstrap 的 KV 写放大', () => {
  it('a. KV 为空 + 注入密码：写入哈希，且返回的哈希能校验通过', async () => {
    const store = new CountingStore()
    const ctx = await ensureBootstrap(store, 'my-secret-pw', '/p-a')

    expect(store.puts).toBeGreaterThanOrEqual(1)
    expect(store.data.get(ADMIN_PW_HASH_KEY)).toBeTruthy()
    expect(store.data.get(PANEL_PATH_KEY)).toBe('/p-a')
    expect(await verifyPassword(ctx, 'my-secret-pw')).toBe(true)
    expect(await verifyPassword(ctx, 'wrong')).toBe(false)
    // 注入密码时 KV 里不应留明文副本
    expect(store.data.has(ADMIN_PW_PLAIN_KEY)).toBe(false)
  })

  it('b. 密码未变的重复引导：put / delete 次数都不增加（核心回归）', async () => {
    const store = new CountingStore()
    const first = await ensureBootstrap(store, 'same-pw', '/p-b')
    const putsAfterFirst = store.puts
    const deletesAfterFirst = store.deletes
    const hashInKv = store.data.get(ADMIN_PW_HASH_KEY)

    // 模拟「60 秒缓存过期 / 另一个 isolate 冷启动」后的再次引导
    const second = await ensureBootstrap(store, 'same-pw', '/p-b')

    expect(store.puts).toBe(putsAfterFirst)
    expect(store.deletes).toBe(deletesAfterFirst)
    // 未变时返回的应当是 KV 里那份哈希，而不是新盐派生出来的
    expect(second.passwordHash).toBe(first.passwordHash)
    expect(store.data.get(ADMIN_PW_HASH_KEY)).toBe(hashInKv)
    expect(await verifyPassword(second, 'same-pw')).toBe(true)
  })

  it('c. 更换环境变量密码：恰好新增 1 次 put，新密码生效、旧密码失效', async () => {
    const store = new CountingStore()
    await ensureBootstrap(store, 'old-password', '/p-c')
    const putsBefore = store.puts

    const ctx = await ensureBootstrap(store, 'new-password', '/p-c')

    expect(store.puts).toBe(putsBefore + 1)
    expect(await verifyPassword(ctx, 'new-password')).toBe(true)
    expect(await verifyPassword(ctx, 'old-password')).toBe(false)
    // 改完密码后再引导一次也不该再写
    const putsAfterChange = store.puts
    await ensureBootstrap(store, 'new-password', '/p-c')
    expect(store.puts).toBe(putsAfterChange)
  })

  it('d. 未注入密码 + KV 为空：随机生成明文并写两个键（行为不变）', async () => {
    const store = new CountingStore()
    const ctx = await ensureBootstrap(store, undefined, '/p-d')

    expect(ctx.generatedPassword).toMatch(/^cfp-[a-f0-9]{16}$/)
    expect(store.data.get(ADMIN_PW_PLAIN_KEY)).toBe(ctx.generatedPassword)
    expect(store.data.get(ADMIN_PW_HASH_KEY)).toBeTruthy()
    expect(await verifyPassword(ctx, ctx.generatedPassword!)).toBe(true)
  })

  it('e. 明文副本残留：只删一次；再次引导不再删（键不存在就不写）', async () => {
    const store = new CountingStore()
    // 模拟历史引导留下的明文副本（绕过 put 计数直接塞进 Map）
    store.data.set(ADMIN_PW_PLAIN_KEY, 'leftover-plain')

    const ctx = await ensureBootstrap(store, 'explicit-pw', '/p-e')
    expect(store.deletes).toBe(1)
    expect(store.data.has(ADMIN_PW_PLAIN_KEY)).toBe(false)
    expect(await verifyPassword(ctx, 'explicit-pw')).toBe(true)

    const deletesAfterFirst = store.deletes
    const putsAfterFirst = store.puts
    const again = await ensureBootstrap(store, 'explicit-pw', '/p-e')

    expect(store.deletes).toBe(deletesAfterFirst)
    expect(store.puts).toBe(putsAfterFirst)
    expect(again.passwordHash).toBe(ctx.passwordHash)
  })

  it('f. KV 里是脏哈希（不含分隔符）：视为不匹配并重写一次', async () => {
    const store = new CountingStore()
    store.data.set(ADMIN_PW_HASH_KEY, 'not-a-valid-hash')

    const ctx = await ensureBootstrap(store, 'recover-pw', '/p-f')

    // 路径 1 次 + 修复哈希 1 次；明文副本不存在所以不删
    expect(store.puts).toBe(2)
    expect(store.deletes).toBe(0)
    expect(await verifyPassword(ctx, 'recover-pw')).toBe(true)
  })
})
