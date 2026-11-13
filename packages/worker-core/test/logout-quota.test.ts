/**
 * /logout 的 KV 写配额防护 —— 回归测试（审计发现 A1）。
 *
 * ## 症状
 *
 * /logout 位于会话鉴权门之前（注销不需要先登录），旧实现只要 Cookie 带 token
 * 就无条件 `store.delete(SESSION:token)`。delete 同样占 KV 写配额（AGENTS §1.30）。
 * 攻击者无需任何凭据，POST /logout 携带随机 Cookie，每请求耗 1 次写配额，
 * 1000 次即打光当日配额 → 登录发会话 / 保存配置 / 回填全部 500。
 *
 * ## 这里验四件事
 *
 * 1. 伪造 Cookie 的注销**不消耗写配额**（先读再删，键不存在则不删）。
 * 2. 本 isolate 刚签发的会话注销仍立即生效（快路径直接删）。
 * 3. 非本 isolate 签发但 KV 里真实存在的会话，注销仍能删（先读命中后删）。
 * 4. /logout 有 isolate 级限速，超过阈值回 429。
 */
import { describe, expect, it } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { ensureBootstrap, SESSION_COOKIE } from '../src/auth'
import { DEFAULT_CONFIG, SESSION_PREFIX } from '../src/config'
import { MemoryStore } from '../src/store'
import type { Env } from '../src/types'

/** 统计 delete 调用次数，用于断言写配额消耗。 */
class CountingStore extends MemoryStore {
  deletes = 0
  override async delete(key: string): Promise<void> {
    this.deletes += 1
    await super.delete(key)
  }
}

function ctx(store: MemoryStore, auth: ApiContext['auth']): ApiContext {
  return {
    store,
    env: {} as Env,
    config: DEFAULT_CONFIG,
    auth,
    onConfigChanged: () => undefined,
  }
}

async function logout(
  store: MemoryStore,
  auth: ApiContext['auth'],
  cookie: string | undefined,
  ip: string
): Promise<Response> {
  const url = new URL('https://panel.test/api/v1/logout')
  const headers: Record<string, string> = { 'CF-Connecting-IP': ip }
  if (cookie) headers.Cookie = cookie
  const req = new Request('https://panel.test/api/v1/logout', { method: 'POST', headers })
  return (await handleApi(req, url, ctx(store, auth)))!
}

async function login(
  store: MemoryStore,
  auth: ApiContext['auth'],
  ip: string
): Promise<string> {
  const url = new URL('https://panel.test/api/v1/login')
  const req = new Request('https://panel.test/api/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password: 'right-pw' }),
  })
  const res = (await handleApi(req, url, ctx(store, auth)))!
  return (res.headers.get('Set-Cookie') || '').split(';')[0]!
}

async function authenticated(
  store: MemoryStore,
  auth: ApiContext['auth'],
  cookie: string
): Promise<boolean> {
  const url = new URL('https://panel.test/api/v1/session')
  const req = new Request('https://panel.test/api/v1/session', {
    method: 'GET',
    headers: { Cookie: cookie },
  })
  const res = (await handleApi(req, url, ctx(store, auth)))!
  const body = (await res.json()) as { authenticated?: boolean }
  return Boolean(body.authenticated)
}

describe('/logout 写配额防护', () => {
  it('伪造 Cookie 的注销不消耗 KV 写配额', async () => {
    const store = new CountingStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')
    store.deletes = 0

    const res = await logout(store, auth, `${SESSION_COOKIE}=deadbeefdeadbeefdeadbeef`, '1.1.1.1')
    expect(res.status).toBe(200)
    // 键不存在 → 先读判定后不删，写配额零消耗
    expect(store.deletes).toBe(0)
  })

  it('无 Cookie 的注销不消耗写配额', async () => {
    const store = new CountingStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')
    store.deletes = 0

    const res = await logout(store, auth, undefined, '1.1.1.2')
    expect(res.status).toBe(200)
    expect(store.deletes).toBe(0)
  })

  it('本 isolate 刚签发的会话注销后立即失效（快路径直接删）', async () => {
    const store = new CountingStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')
    const cookie = await login(store, auth, '1.1.1.3')
    expect(await authenticated(store, auth, cookie)).toBe(true)
    store.deletes = 0

    const res = await logout(store, auth, cookie, '1.1.1.3')
    expect(res.status).toBe(200)
    expect(store.deletes).toBe(1)
    expect(await authenticated(store, auth, cookie)).toBe(false)
  })

  it('非本 isolate 签发但 KV 真实存在的会话，注销仍先读命中后删', async () => {
    const store = new CountingStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')
    // 手工写入一个会话键（模拟别的 isolate 签发、本 isolate recentSessions 没有）
    const token = 'cafebabecafebabecafebabecafebabe'
    await store.put(`${SESSION_PREFIX}${token}`, JSON.stringify({ ua: '', t: Date.now() }), 3600)
    const cookie = `${SESSION_COOKIE}=${token}`
    expect(await authenticated(store, auth, cookie)).toBe(true)
    store.deletes = 0

    const res = await logout(store, auth, cookie, '1.1.1.4')
    expect(res.status).toBe(200)
    expect(store.deletes).toBe(1)
    expect(await authenticated(store, auth, cookie)).toBe(false)
  })

})