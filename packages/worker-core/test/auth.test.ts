import { describe, expect, it } from 'vitest'
import { ensureBootstrap, verifyPassword } from '../src/auth'
import { MemoryStore } from '../src/store'
import { ADMIN_PW_HASH_KEY, ADMIN_PW_PLAIN_KEY, PANEL_PATH_KEY } from '../src/config'

describe('ensureBootstrap 凭据优先级', () => {
  it('KV 为空时用环境变量的路径与密码', async () => {
    const store = new MemoryStore()
    const ctx = await ensureBootstrap(store, 'my-secret-pw', '/p-env')
    expect(ctx.panelPath).toBe('/p-env')
    expect(ctx.generatedPassword).toBeNull()
    expect(await verifyPassword(ctx, 'my-secret-pw')).toBe(true)
    expect(await verifyPassword(ctx, 'wrong')).toBe(false)
    // KV 里只应有哈希，不留明文
    expect(await store.get(ADMIN_PW_HASH_KEY)).toBeTruthy()
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBeNull()
  })

  it('KV 已有旧值时，环境变量覆盖它（核心回归）', async () => {
    const store = new MemoryStore()
    // 先按旧凭据引导一次
    await ensureBootstrap(store, 'old-password', '/p-old')
    expect(await store.get(PANEL_PATH_KEY)).toBe('/p-old')

    // 重新部署并注入新凭据：必须生效
    const ctx = await ensureBootstrap(store, 'new-password', '/p-new')
    expect(ctx.panelPath).toBe('/p-new')
    expect(await verifyPassword(ctx, 'new-password')).toBe(true)
    expect(await verifyPassword(ctx, 'old-password')).toBe(false)
    expect(await store.get(PANEL_PATH_KEY)).toBe('/p-new')
  })

  it('环境变量变化后会清掉 KV 里的明文副本', async () => {
    const store = new MemoryStore()
    // 未注入密码 → 随机生成并留明文
    const first = await ensureBootstrap(store, undefined, '/p-a')
    expect(first.generatedPassword).toBeTruthy()
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBe(first.generatedPassword)

    // 注入密码后明文副本应被删除
    await ensureBootstrap(store, 'explicit-pw', '/p-a')
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBeNull()
  })

  it('未注入密码时随机生成并保留明文副本', async () => {
    const store = new MemoryStore()
    const ctx = await ensureBootstrap(store, undefined, '/p-b')
    expect(ctx.generatedPassword).toMatch(/^cfp-[a-f0-9]{16}$/)
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBe(ctx.generatedPassword)
    expect(await verifyPassword(ctx, ctx.generatedPassword!)).toBe(true)
  })

  it('环境变量未提供路径时沿用 KV 里的路径', async () => {
    const store = new MemoryStore()
    await ensureBootstrap(store, 'pw1', '/p-keep')
    const ctx = await ensureBootstrap(store, 'pw1', undefined)
    expect(ctx.panelPath).toBe('/p-keep')
  })

  it('路径规范化：补齐前导斜杠并去除重复斜杠', async () => {
    const store = new MemoryStore()
    const ctx = await ensureBootstrap(store, 'pw', 'p-x')
    expect(ctx.panelPath).toBe('/p-x')

    const store2 = new MemoryStore()
    const ctx2 = await ensureBootstrap(store2, 'pw', '//p-y')
    expect(ctx2.panelPath).toBe('/p-y')
  })

  it('空字符串环境变量按「未提供」处理', async () => {
    const store = new MemoryStore()
    const ctx = await ensureBootstrap(store, '   ', '  ')
    // 两项都未提供：路径随机生成，密码随机生成并留明文
    expect(ctx.panelPath).toMatch(/^\/cfpilot-[a-z0-9]{6}$/)
    expect(ctx.generatedPassword).toBeTruthy()
  })
})
