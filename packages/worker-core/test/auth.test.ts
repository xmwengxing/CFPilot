import { describe, expect, it } from 'vitest'
import { ensureBootstrap, upgradePasswordHash, verifyPassword, verifyPasswordDetailed } from '../src/auth'
import { MemoryStore } from '../src/store'
import { ADMIN_PW_HASH_KEY, ADMIN_PW_PLAIN_KEY, PANEL_PATH_KEY } from '../src/config'
import { sha256Hex } from '../src/util'

/** 旧版（单次 SHA-256）格式：`<salt>:<sha256(salt:password)>` */
async function legacyHash(password: string, salt = 'aabbccdd'): Promise<string> {
  return `${salt}:${await sha256Hex(`${salt}:${password}`)}`
}

describe('密码派生格式', () => {
  it('新写入的是版本化 PBKDF2 格式', async () => {
    const store = new MemoryStore()
    await ensureBootstrap(store, 'pw-kdf', '/p-kdf')
    const hash = (await store.get(ADMIN_PW_HASH_KEY)) ?? ''
    expect(hash.startsWith('pbkdf2$')).toBe(true)
    expect(hash.split('$')).toHaveLength(4)
  })

  it('旧版 sha256 哈希仍可登录（升级兼容）', async () => {
    const store = new MemoryStore()
    await store.put(ADMIN_PW_HASH_KEY, await legacyHash('old-pw'))
    const ctx = await ensureBootstrap(store, undefined, '/p-legacy')
    expect(await verifyPassword(ctx, 'old-pw')).toBe(true)
    expect(await verifyPassword(ctx, 'wrong-pw')).toBe(false)
    // 明细接口要告诉调用方「这份哈希还是旧格式」，才能触发静默升级
    expect((await verifyPasswordDetailed(ctx, 'old-pw')).legacy).toBe(true)
  })

  it('旧格式登录后可升级为 PBKDF2，新旧密码都能校验', async () => {
    const store = new MemoryStore()
    await store.put(ADMIN_PW_HASH_KEY, await legacyHash('pw-upgrade'))
    const ctx = await ensureBootstrap(store, undefined, '/p-upgrade')
    expect((await verifyPasswordDetailed(ctx, 'pw-upgrade')).legacy).toBe(true)

    await upgradePasswordHash(store, 'pw-upgrade')
    const upgraded = (await store.get(ADMIN_PW_HASH_KEY)) ?? ''
    expect(upgraded.startsWith('pbkdf2$')).toBe(true)
    // 升级后重新引导：环境变量（无）→ 读 KV 哈希（PBKDF2）→ 密码仍可校验
    const ctx2 = await ensureBootstrap(store, undefined, '/p-upgrade')
    expect(await verifyPassword(ctx2, 'pw-upgrade')).toBe(true)
    expect((await verifyPasswordDetailed(ctx2, 'pw-upgrade')).legacy).toBe(false)
  })

  it('环境变量密码不变时不会因为格式差异反复重写 KV', async () => {
    const store = new MemoryStore()
    await ensureBootstrap(store, 'stable-pw', '/p-stable')
    const before = await store.get(ADMIN_PW_HASH_KEY)
    await ensureBootstrap(store, 'stable-pw', '/p-stable')
    expect(await store.get(ADMIN_PW_HASH_KEY)).toBe(before)
  })
})

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
