/**
 * `/api/v1/route-profile` 与 `/api/v1/ips` 的接口级回归测试。
 *
 * ## 覆盖的问题
 *
 * 1. **填写框读取不到内置内容**：`GET /route-profile` 只回 KV 里的自定义原文。
 *    没写自定义时那是空串 —— 但订阅里生效的是一整套内置 GEOSITE/GEOIP 规则。
 *    用户看到空框，读到的和生效的不是一回事。
 * 2. **「清空（回落至内置）」无效**：删键前先 `get` 判断键是否存在，
 *    而 KV 读是最终一致的 —— 陈旧读会把「其实有值」误判成「没有」。
 * 3. **手动指定 IP 填错没有提示**：解析层静默跳过看不懂的行，
 *    用户只看到「保存成功」，但订阅里一条节点都没进去。
 */
import { describe, expect, it } from 'vitest'
import { handleApi } from '../src/api'
import { createSession, SESSION_COOKIE } from '../src/auth'
import { buildBuiltinProfileText, ROUTE_MAIN_GROUP } from '../src/route-profile'
import { MemoryStore } from '../src/store'
import type { Env, UserConfig } from '../src/types'
import type { AuthContext } from '../src/auth'

const AUTH = {} as AuthContext

/**
 * 内存 KV（带测试用的直读/直写辅助）。
 *
 * `MemoryStore` 的数据是私有的，测试要断言「键被删了 / 被写了」就得能直读。
 */
class TestStore extends MemoryStore {
  async setRaw(key: string, value: string): Promise<void> {
    await this.put(key, value)
  }
  async getRaw(key: string): Promise<string | null> {
    return this.get(key)
  }
  async hasRaw(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }
}

function ctx(store: MemoryStore, config: UserConfig = {} as UserConfig) {
  return {
    store,
    env: {} as Env,
    config,
    auth: AUTH,
    onConfigChanged: () => {},
  }
}

function apiUrl(path: string): URL {
  return new URL(`https://example.com/api/v1${path}`)
}

/**
 * 调一次面板 API（自动带上有效会话 cookie）。
 *
 * ⚠️ 除 `/session` 与 `/login` 外的接口都要求面板会话，
 * 否则会先被 401 拦掉 —— 测不到真正的逻辑。
 */
async function call(
  store: MemoryStore,
  path: string,
  method: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = await createSession(store)
  const request = new Request(apiUrl(path).toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handleApi(request, apiUrl(path), ctx(store))
  const data = (await res!.json()) as Record<string, unknown>
  return { status: res!.status, data }
}

describe('GET /api/v1/route-profile', () => {
  it('没有自定义规则时返回内置规则内容（不是空串）', async () => {
    const store = new TestStore()
    const { status, data } = await call(store, '/route-profile', 'GET')
    expect(status).toBe(200)
    expect(data.isCustom).toBe(false)
    expect(String(data.text)).toBe(buildBuiltinProfileText(ROUTE_MAIN_GROUP))
    expect(String(data.text).trim().length).toBeGreaterThan(0)
  })

  it('有自定义规则时返回自定义内容并标记 isCustom', async () => {
    const store = new TestStore()
    await store.setRaw('ROUTE_PROFILE', '- GEOSITE,youtube,CFPilot')
    const { data } = await call(store, '/route-profile', 'GET')
    expect(data.isCustom).toBe(true)
    expect(data.text).toBe('- GEOSITE,youtube,CFPilot')
    expect(data.raw).toBe('- GEOSITE,youtube,CFPilot')
  })
})

describe('PUT /api/v1/route-profile', () => {
  it('保存自定义规则后返回自定义状态', async () => {
    const store = new TestStore()
    const { data } = await call(store, '/route-profile', 'PUT', {
      raw: '- GEOSITE,youtube,CFPilot',
    })
    expect(data.isCustom).toBe(true)
    expect(data.text).toBe('- GEOSITE,youtube,CFPilot')
    expect(await store.getRaw('ROUTE_PROFILE')).toBe('- GEOSITE,youtube,CFPilot')
  })

  it('传空串会删掉 KV 键（回落内置）', async () => {
    const store = new TestStore()
    await store.setRaw('ROUTE_PROFILE', '- GEOSITE,youtube,CFPilot')
    const { data } = await call(store, '/route-profile', 'PUT', { raw: '' })
    expect(await store.hasRaw('ROUTE_PROFILE')).toBe(false)
    expect(data.isCustom).toBe(false)
    expect(String(data.text)).toBe(buildBuiltinProfileText(ROUTE_MAIN_GROUP))
  })

  it('原样保存内置规则 ⇒ 仍走内置（不留重复的自定义副本）', async () => {
    const store = new TestStore()
    await store.setRaw('ROUTE_PROFILE', '- GEOSITE,youtube,CFPilot')
    const { data } = await call(store, '/route-profile', 'PUT', {
      raw: buildBuiltinProfileText(ROUTE_MAIN_GROUP),
    })
    expect(await store.hasRaw('ROUTE_PROFILE')).toBe(false)
    expect(data.isCustom).toBe(false)
    expect(String(data.text)).toBe(buildBuiltinProfileText(ROUTE_MAIN_GROUP))
  })

  it('保存后不回读 KV（避免陈旧读把结果报成旧值）', async () => {
    const store = new TestStore()
    await store.setRaw('ROUTE_PROFILE', '旧内容')
    const { data } = await call(store, '/route-profile', 'PUT', {
      raw: '- GEOSITE,youtube,CFPilot',
    })
    // 陈旧读会返回「旧内容」；正确行为是直接回报刚写入的值
    expect(data.text).toBe('- GEOSITE,youtube,CFPilot')
    expect(data.isCustom).toBe(true)
  })

  it('超长内容被拒绝', async () => {
    const store = new TestStore()
    const { status } = await call(store, '/route-profile', 'PUT', { raw: 'x'.repeat(20001) })
    expect(status).toBe(400)
  })
})

describe('PUT /api/v1/ips：手动录入的语法校验', () => {
  it('合法内容被接受', async () => {
    const store = new TestStore()
    const { status, data } = await call(store, '/ips', 'PUT', {
      raw: '104.16.1.1:443#US-SJC\n[2606:4700::1]:443',
    })
    expect(status).toBe(200)
    expect(data.count).toBe(2)
  })

  it('非法行被拒绝并指出行号', async () => {
    const store = new TestStore()
    const { status, data } = await call(store, '/ips', 'PUT', {
      raw: '104.16.1.1\nnot a host',
    })
    expect(status).toBe(400)
    expect(String(data.error)).toContain('第 2 行')
    expect(await store.hasRaw('LOCAL_PREFERRED_IPS')).toBe(false)
  })

  it('端口越界被拒绝', async () => {
    const store = new TestStore()
    const { status, data } = await call(store, '/ips', 'PUT', {
      raw: '104.16.1.1:99999',
    })
    expect(status).toBe(400)
    expect(String(data.error)).toContain('无法识别')
  })
})
