/**
 * 运行概览卡片的数据来源 —— 回归测试。
 *
 * ## 真实报障（2026-10-28）
 *
 * 用户：「运行预览页面的『当前接入边缘机房』和『系统内核版本』这两张卡的值
 * 似乎都是硬编码的，从来没变过。」
 *
 * 查下来：
 *   1. `/api/v1/status` 里 `version` **写死成 `'0.1.0'`** —— 面板永远显示 0.1.0；
 *   2. `colo` 本身是真实的（`request.cf.colo`），但面板**只在登录后读一次**，
 *      停在同一页不会刷新，看起来就像常量。
 *
 * 修法：`version` 换成真实的 `BUILD_VERSION`，另加 `pkgVersion`（语义版本）
 * 与 `readAt`（读取时刻，面板显示「以上数据读取于 …」）；面板切回概览时重新读取。
 */
import { describe, expect, it } from 'vitest'
import { handleApi, type ApiContext } from '../src/api'
import { DEFAULT_CONFIG } from '../src/config'
import type { Store } from '../src/store'
import type { UserConfig } from '../src/types'
import { BUILD_VERSION, PKG_VERSION, VERSION_PATH, versionResponse } from '../src/version'

/** 内存 Store：/status 只需要会话校验与本地池读取 */
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

const SESSION = 'sess-test-token'

async function statusResponse(): Promise<Record<string, unknown>> {
  const store = new MemStore()
  // 会话校验读 SESSION:<token>
  store.map.set(`SESSION:${SESSION}`, JSON.stringify({ ua: '', t: Date.now() }))
  store.map.set('LOCAL_PREFERRED_IPS', '1.2.3.4:443#HKG\n5.6.7.8:443#LAX\n')

  const config: UserConfig = { ...DEFAULT_CONFIG, subDomain: 'data.example.com' }
  const ctx: ApiContext = {
    store,
    env: {} as ApiContext['env'],
    config,
    auth: { panelPath: '/panel-test', passwordHash: 'salt:hash', generatedPassword: null },
    onConfigChanged: () => {},
  }

  const request = new Request('https://panel.example.com/api/v1/status', {
    method: 'GET',
    headers: { Cookie: `cfpilot_sess=${SESSION}` },
  })
  const res = await handleApi(request, new URL(request.url), ctx)
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  return (await res!.json()) as Record<string, unknown>
}

describe('/api/v1/status（运行概览卡片）', () => {
  it('version 不再写死 0.1.0，而是真实构建版本', async () => {
    const body = await statusResponse()
    expect(body.version).not.toBe('0.1.0')
    expect(body.version).toBe(BUILD_VERSION)
    // 源码直跑（vitest）时没有构建注入，值是 'dev'；构建产物里是 <git短hash>-<源码哈希>
    expect(typeof body.version).toBe('string')
  })

  it('提供语义版本 pkgVersion 与读取时刻 readAt', async () => {
    const before = Date.now()
    const body = await statusResponse()
    expect(body.pkgVersion).toBe(PKG_VERSION)
    expect(typeof body.readAt).toBe('number')
    expect(body.readAt as number).toBeGreaterThanOrEqual(before)
    // readAt 必须是「这次请求的时间」，不能被缓存成常量
    expect(body.readAt as number).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('除了版本号，机房与数据面域名也来自真实请求/配置', async () => {
    const body = await statusResponse()
    expect(body.nodeDomain).toBe('data.example.com') // subDomain 优先
    expect(typeof body.colo).toBe('string')
    expect(body.colo).toBeTruthy()
    expect(body.localIps).toBe(2) // 上面写了两条
  })

  it('两次请求的 readAt 不同（证明不是硬编码）', async () => {
    const a = await statusResponse()
    await new Promise((r) => setTimeout(r, 5))
    const b = await statusResponse()
    expect(b.readAt as number).toBeGreaterThan(a.readAt as number)
  })
})

describe('/__cfp_version（部署向导用）', () => {
  it('返回 build 与语义版本，且不被缓存', async () => {
    const res = versionResponse()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.build).toBe(BUILD_VERSION)
    expect(body.version).toBe(PKG_VERSION)
    expect(typeof body.ts).toBe('number')
  })

  it('路径常量与部署向导的调用一致', () => {
    expect(VERSION_PATH).toBe('/__cfp_version')
  })
})
