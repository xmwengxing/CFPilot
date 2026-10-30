/**
 * 面板登录的暴力破解防线 —— 回归测试。
 *
 * 覆盖三件事：
 *
 * 1. **失败限速**：同一来源 IP 连续失败 5 次后进入 60 秒冷却，
 *    此时即使密码正确也返回 429（否则限速就没有意义）。
 *    限速状态只用 isolate 内存 —— 写 KV 会被攻击者当成耗尽每日写配额的手段。
 *
 * 2. **旧哈希静默升级**：KV 里是旧版 `<salt>:<sha256>` 时，
 *    登录成功必须把哈希改写成 `pbkdf2$...`，且用户下次仍能用同一密码登录。
 *
 * 3. **明文密码一次性**：未注入 `PANEL_PASSWORD` 的实例会把随机生成的密码
 *    写进 KV 供用户取回；第一次成功登录后必须删除，不能长期留存。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { ensureBootstrap, verifyPassword } from '../src/auth'
import { ADMIN_PW_HASH_KEY, ADMIN_PW_PLAIN_KEY, DEFAULT_CONFIG } from '../src/config'
import { MemoryStore } from '../src/store'
import { sha256Hex } from '../src/util'
import type { Env } from '../src/types'

/** 旧版（单次 SHA-256）格式 */
async function legacyHash(password: string, salt = 'aabbccdd'): Promise<string> {
  return `${salt}:${await sha256Hex(`${salt}:${password}`)}`
}

/** 造一次登录请求；`ip` 决定限速桶 */
function loginRequest(password: string, ip: string): Request {
  return new Request('https://panel.test/api/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password }),
  })
}

function apiContext(store: MemoryStore, auth: ApiContext['auth']): ApiContext {
  return {
    store,
    env: {} as Env,
    config: DEFAULT_CONFIG,
    auth,
    onConfigChanged: () => undefined,
  }
}

/** 调用一次登录 */
async function login(store: MemoryStore, auth: ApiContext['auth'], password: string, ip: string) {
  const url = new URL('https://panel.test/api/v1/login')
  return await handleApi(loginRequest(password, ip), url, apiContext(store, auth))
}

beforeEach(() => {
  // 每个用例用不同的来源 IP：限速表是模块级的，换桶即可互不干扰
})

describe('登录失败限速', () => {
  it('连续失败 5 次后进入冷却：正确密码也返回 429', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-throttle')

    for (let i = 0; i < 5; i++) {
      const res = await login(store, auth, 'wrong-pw', '203.0.113.10')
      expect(res!.status).toBe(401)
    }

    const blocked = await login(store, auth, 'right-pw', '203.0.113.10')
    expect(blocked!.status).toBe(429)
    expect(blocked!.headers.get('cache-control')).toBe('no-store')
    expect(Number(blocked!.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('限速只影响触发它的来源 IP', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-throttle-ip')

    for (let i = 0; i < 6; i++) await login(store, auth, 'wrong-pw', '203.0.113.20')
    const blocked = await login(store, auth, 'right-pw', '203.0.113.20')
    expect(blocked!.status).toBe(429)

    const ok = await login(store, auth, 'right-pw', '203.0.113.21')
    expect(ok!.status).toBe(200)
    expect(ok!.headers.get('set-cookie')).toBeTruthy()
  })

  it('登录成功会清空该 IP 的失败计数', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-throttle-reset')

    for (let i = 0; i < 4; i++) await login(store, auth, 'wrong-pw', '203.0.113.30')
    expect((await login(store, auth, 'right-pw', '203.0.113.30'))!.status).toBe(200)
    // 计数已清零：再失败 4 次仍不应被限速
    for (let i = 0; i < 4; i++) {
      expect((await login(store, auth, 'wrong-pw', '203.0.113.30'))!.status).toBe(401)
    }
  })
})

describe('旧哈希升级与一次性明文', () => {
  it('旧格式登录成功后哈希升级为 PBKDF2，且同一密码仍可登录', async () => {
    const store = new MemoryStore()
    await store.put(ADMIN_PW_HASH_KEY, await legacyHash('old-pw'))
    const auth = await ensureBootstrap(store, undefined, '/p-upgrade-api')

    const res = await login(store, auth, 'old-pw', '203.0.113.40')
    expect(res!.status).toBe(200)

    const upgraded = (await store.get(ADMIN_PW_HASH_KEY)) ?? ''
    expect(upgraded.startsWith('pbkdf2$')).toBe(true)
    // 用升级后的上下文重新校验：密码不变
    const ctx = await ensureBootstrap(store, undefined, '/p-upgrade-api')
    expect(await verifyPassword(ctx, 'old-pw')).toBe(true)
  })

  it('自动生成的明文密码在首次登录成功后被删除', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, undefined, '/p-plain')
    const generated = auth.generatedPassword
    expect(generated).toBeTruthy()
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBe(generated)

    const res = await login(store, auth, generated!, '203.0.113.50')
    expect(res!.status).toBe(200)
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBeNull()
  })

  it('登录失败不会删除明文（用户还要靠它登录）', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, undefined, '/p-plain-keep')
    const generated = auth.generatedPassword

    expect((await login(store, auth, 'wrong-pw', '203.0.113.60'))!.status).toBe(401)
    expect(await store.get(ADMIN_PW_PLAIN_KEY)).toBe(generated)
  })
})
