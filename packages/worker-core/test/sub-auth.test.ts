/**
 * 订阅鉴权双模式（legacy / signed）
 *
 * 这组测试守的是**切换风险**：
 *   - 经典模式必须照旧可用，且**同时接受**签名链接（这样用户能先导入验证再切模式）；
 *   - 签名模式下经典链接必须 403（否则「防泄露」形同虚设）；
 *   - 轮换后旧签名链接立即失效。
 *
 * 任何一条被改坏，用户侧的表现都是「订阅突然 403」——最难自查的一类故障。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { routeControlPlane } from '../src/routes/control'
import { invalidateConfig } from '../src/routes/shared'
import { neutralPage } from '../src/ui/neutral'
import { signSubToken, loadSubSecret, rotateSubSecret, SUB_SECRET_KEY } from '../src/sub-token'
import { KvStore } from '../src/store'
import type { Env } from '../src/types'

const UUID = '11111111-2222-3333-4444-555555555555'

/** 最小 KV 桩：只需要 get / put / delete / list */
class FakeKV {
  readonly map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  async list(options: { prefix?: string } = {}): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }> {
    const prefix = options.prefix ?? ''
    return {
      keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }
  }
}

function makeEnv(kv: FakeKV, mode?: 'legacy' | 'signed'): Env {
  const env: Record<string, unknown> = { UUID, KV: kv }
  if (mode) env.SUB_TOKEN_MODE = mode
  return env as unknown as Env
}

async function callSub(env: Env, path: string): Promise<Response> {
  const request = new Request(`https://panel.example.com${path}`)
  return (await routeControlPlane(request, env)) ?? neutralPage(200)
}

beforeEach(() => {
  invalidateConfig()
})

describe('经典模式（默认）', () => {
  it('UUID 路径照旧 200', async () => {
    const kv = new FakeKV()
    const res = await callSub(makeEnv(kv), `/sub/${UUID}?target=base64`)
    expect(res.status).toBe(200)
  })

  it('?token= 查询参数照旧可用', async () => {
    const kv = new FakeKV()
    const res = await callSub(makeEnv(kv), `/sub/x?token=${UUID}&target=base64`)
    expect(res.status).toBe(200)
  })

  it('错误 UUID 仍然 403', async () => {
    const kv = new FakeKV()
    const res = await callSub(makeEnv(kv), '/sub/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(403)
  })

  it('也接受签名链接（切换前的验证窗口）', async () => {
    const kv = new FakeKV()
    const env = makeEnv(kv)
    const secret = await loadSubSecret(new KvStore(kv as unknown as KVNamespace))
    const token = await signSubToken(secret)
    const res = await callSub(env, `/sub/${token}?target=base64`)
    expect(res.status).toBe(200)
  })
})

describe('签名模式', () => {
  it('经典链接 403', async () => {
    const kv = new FakeKV()
    const res = await callSub(makeEnv(kv, 'signed'), `/sub/${UUID}?target=base64`)
    expect(res.status).toBe(403)
  })

  it('有效签名链接 200', async () => {
    const kv = new FakeKV()
    const env = makeEnv(kv, 'signed')
    // 首次读取会生成并落盘（生产上由面板「签发」触发）
    const secret = await loadSubSecret(new KvStore(kv as unknown as KVNamespace))
    expect(secret).toBeTruthy()
    const token = await signSubToken(secret)
    const res = await callSub(env, `/sub/${token}?target=base64`)
    expect(res.status).toBe(200)
  })

  it('篡改过的签名链接 403', async () => {
    const kv = new FakeKV()
    const env = makeEnv(kv, 'signed')
    const secret = await loadSubSecret(new KvStore(kv as unknown as KVNamespace))
    const token = await signSubToken(secret)
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    const res = await callSub(env, `/sub/${tampered}?target=base64`)
    expect(res.status).toBe(403)
  })

  it('轮换后旧链接 403、新链接 200', async () => {
    const kv = new FakeKV()
    const env = makeEnv(kv, 'signed')
    const oldSecret = await loadSubSecret(new KvStore(kv as unknown as KVNamespace))
    const oldToken = await signSubToken(oldSecret)
    expect((await callSub(env, `/sub/${oldToken}`)).status).toBe(200)

    const fresh = await rotateSubSecret(new KvStore(kv as unknown as KVNamespace))

    expect((await callSub(env, `/sub/${oldToken}`)).status).toBe(403)
    const newToken = await signSubToken(fresh)
    expect((await callSub(env, `/sub/${newToken}`)).status).toBe(200)
  })
})
