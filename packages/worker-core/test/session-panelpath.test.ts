/**
 * /session 未鉴权不得返回 panelPath —— 回归测试（审计 C-2）。
 *
 * 面板路径是随机隐藏入口，是「未登录者不应知道入口」这层防护的全部依据。
 * 任意人一个 GET 就能拿到它等于把爆破面提前交出去
 * （登录限速是按 isolate 的，跨 isolate 会被放大）。
 *
 * 修复：只有 `authenticated === true` 时才返回 `panelPath`。
 * 面板/桌面壳在登录成功后由向导带回路径，不依赖 /session 下发。
 */
import { describe, expect, it } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { createSession, SESSION_COOKIE } from '../src/auth'
import { ensureBootstrap } from '../src/auth'
import { DEFAULT_CONFIG } from '../src/config'
import { MemoryStore } from '../src/store'
import type { Env } from '../src/types'

function ctx(store: MemoryStore, auth: ApiContext['auth']): ApiContext {
  return { store, env: {} as Env, config: DEFAULT_CONFIG, auth, onConfigChanged: () => undefined }
}

async function session(store: MemoryStore, auth: ApiContext['auth'], cookie?: string) {
  const url = new URL('https://panel.test/api/v1/session')
  const req = new Request('https://panel.test/api/v1/session', {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  const res = (await handleApi(req, url, ctx(store, auth)))!
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('GET /api/v1/session', () => {
  it('未登录：响应里不得包含 panelPath', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-super-secret')
    const { body } = await session(store, auth)
    expect(body.authenticated).toBe(false)
    expect('panelPath' in body).toBe(false)
    // 没有 panelPath 字段可被误读，也不能靠空字符串绕过去
    expect(JSON.stringify(body)).not.toContain('/p-super-secret')
  })

  it('带有效会话 Cookie：返回 panelPath', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-super-secret')
    const token = await createSession(store)
    const { body } = await session(store, auth, `${SESSION_COOKIE}=${token}`)
    expect(body.authenticated).toBe(true)
    expect(body.panelPath).toBe('/p-super-secret')
  })

  it('带伪造会话 Cookie：authenticated=false 且不泄露', async () => {
    const store = new MemoryStore()
    const auth = await ensureBootstrap(store, 'right-pw', '/p-super-secret')
    const { body } = await session(store, auth, `${SESSION_COOKIE}=deadbeefcafe`)
    expect(body.authenticated).toBe(false)
    expect('panelPath' in body).toBe(false)
    expect(JSON.stringify(body)).not.toContain('/p-super-secret')
  })
})
