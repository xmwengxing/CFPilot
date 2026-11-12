/**
 * 登录成功后不该被弹回登录页 —— 回归测试。
 *
 * ## 症状
 *
 * 用户在面板输入密码，提示「登录成功」，紧接着又回到登录页面。
 *
 * ## 根因
 *
 * 会话写在 KV 里，而 **KV 的读是最终一致的**（边缘缓存约 60 秒）。
 * 于是这个序列：
 *
 *   登录请求 → 写 KV → Set-Cookie
 *   紧接着的「查会话」请求 → 读 KV → **可能读不到**（还没传播到那个边缘节点）
 *   → authenticated=false → 界面弹回登录页
 *
 * 密码明明是对的，用户看到的却是「又回到登录页」。
 *
 * ## 这里验两件事
 *
 * 1. **同一个 isolate 刚签发的会话立刻可用** —— 不等 KV 传播 ✓
 * 2. **伪造的令牌仍然被拒** —— isolate 缓存只认「自己签发过的」令牌 ✓
 */
import { describe, expect, it } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { ensureBootstrap, SESSION_COOKIE } from '../src/auth'
import { DEFAULT_CONFIG } from '../src/config'
import { MemoryStore } from '../src/store'
import type { Env } from '../src/types'

/**
 * 模拟 KV 的传播延迟：刚写入的键，**第一次读会读不到**。
 *
 * 这正是线上「登录成功又被弹回登录页」的那个瞬间。
 */
class LaggyStore extends MemoryStore {
  /** 写入了但还没传播到本地的键 */
  private pending = new Set<string>()

  override async put(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.pending.add(key)
    await super.put(key, value, ttlSeconds)
  }

  override async get(key: string): Promise<string | null> {
    if (this.pending.has(key)) {
      // 第一次读：还没传播开 → 读不到
      this.pending.delete(key)
      return null
    }
    return await super.get(key)
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

async function login(store: MemoryStore, auth: ApiContext['auth'], password: string) {
  const url = new URL('https://panel.test/api/v1/login')
  const req = new Request('https://panel.test/api/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ password }),
  })
  const res = (await handleApi(req, url, ctx(store, auth)))!
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0]
  return { status: res.status, cookie }
}

async function session(store: MemoryStore, auth: ApiContext['auth'], cookie?: string) {
  const url = new URL('https://panel.test/api/v1/session')
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  const req = new Request('https://panel.test/api/v1/session', {
    method: 'GET',
    headers,
  })
  const res = (await handleApi(req, url, ctx(store, auth)))!
  return (await res.json()) as Record<string, unknown>
}

describe('登录后的会话立即可用', () => {
  it('KV 还没传播开时，同一 isolate 仍能查到刚签发的会话', async () => {
    const store = new LaggyStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')

    const { status, cookie } = await login(store, auth, 'right-pw')
    expect(status).toBe(200)
    expect(cookie).toContain(SESSION_COOKIE)

    // 关键断言：紧接着的会话查询必须认账
    // （没修之前这里会因为 KV 读不到而 authenticated=false → 弹回登录页）
    const body = await session(store, auth, cookie)
    expect(body.authenticated).toBe(true)
  })

  it('伪造的会话令牌仍然被拒', async () => {
    const store = new LaggyStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')

    const body = await session(store, auth, `${SESSION_COOKIE}=deadbeefdeadbeefdeadbeef`)
    expect(body.authenticated).toBe(false)
    // 未鉴权时不得泄露面板路径
    expect('panelPath' in body).toBe(false)
  })

  it('注销后本 isolate 也不再认这个会话', async () => {
    const store = new LaggyStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')
    const { cookie } = await login(store, auth, 'right-pw')

    // 注销
    const url = new URL('https://panel.test/api/v1/logout')
    const logoutHeaders: Record<string, string> = {}
    if (cookie) logoutHeaders.Cookie = cookie
    const req = new Request('https://panel.test/api/v1/logout', {
      method: 'POST',
      headers: logoutHeaders,
    })
    await handleApi(req, url, ctx(store, auth))

    const body = await session(store, auth, cookie)
    expect(body.authenticated).toBe(false)
  })

  it('查不到会话时要告诉界面「带了 Cookie」—— 界面据此等待而不是弹登录页', async () => {
    const store = new LaggyStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-secret')

    // 带了一个查不到的 Cookie（相当于「刚签发、但这个 isolate 没见过、KV 也没传播到」）
    const withCookie = await session(store, auth, `${SESSION_COOKIE}=cafebabecafebabe`)
    expect(withCookie.authenticated).toBe(false)
    expect(withCookie.hasSessionCookie).toBe(true)

    // 压根没带 Cookie → hasSessionCookie=false（界面直接显示登录页）
    const without = await session(store, auth)
    expect(without.hasSessionCookie).toBe(false)
  })
})
