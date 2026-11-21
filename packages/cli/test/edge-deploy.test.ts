/**
 * Phase 2 CLI 部署编排单测（不真机，mock 所有外部调用）。
 *
 * 防什么：
 *   1. 编排顺序错（建库 → schema → Worker → 域名 → 密码 → 面板）。
 *   2. Worker 上传少了 DO migration / D1 绑定 → 盲中继房间或监测库失效。
 *   3. dashboard 的 DEFAULT_API 没替换成实际 WorkerUrl → 面板指向别人域名。
 *   4. /auth/setup 的 409（已设置）没被当成幂等成功。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { deployEdgeRelay, isMonitorSetupDone, zoneNameFromDomain } from '../src/edge/deploy'
import { CloudflareError, type CloudflareClient } from '../src/deploy/cf-api'

afterEach(() => vi.unstubAllGlobals())

function fakeClient(onQuery?: (sql: string) => Promise<void>) {
  const calls: string[] = []
  const client = {
    createD1Database: vi.fn(async (_a: string, name: string) => {
      calls.push(`d1:${name}`)
      return { uuid: 'db-uuid-12345678', name }
    }),
    listD1Databases: vi.fn(async (_a: string, name?: string) => {
      calls.push(`d1-list:${name}`)
      return [{ uuid: 'db-uuid-existing', name: name ?? 'edge-relay-test-monitor' }]
    }),
    queryD1: vi.fn(async (_a: string, _id: string, sql: string) => {
      calls.push(`sql:${sql.slice(0, 20)}`)
      await onQuery?.(sql)
    }),
    uploadScript: vi.fn(async (_a: string, name: string, opts: { bindings: unknown[]; doExports?: unknown; migrations?: unknown; code: string }) => {
      calls.push(`worker:${name}`)
      ;(globalThis as Record<string, unknown>).__lastUpload = opts
    }),
    attachCustomDomain: vi.fn(async () => { calls.push('domain') }),
    getPagesProject: vi.fn(async () => { throw Object.assign(new Error('404'), { status: 404 }) }),
    createPagesProject: vi.fn(async () => { calls.push('pages-create') }),
    deployPagesWorker: vi.fn(async (_a: string, _p: string, opts: { code: string }) => {
      calls.push('pages-upload')
      ;(globalThis as Record<string, unknown>).__lastWorker = opts.code
    }),
    listZones: vi.fn(async () => []),
  }
  return { client: client as unknown as CloudflareClient, calls }
}

const baseOpts = {
  accountId: 'acct',
  domain: 'relay.example.com',
  monitorPassword: 'password123',
  monitorToken: 'mon-token-xyz',
  zoneId: 'zone-1',
  workerName: 'edge-relay-test',
}

describe('zoneNameFromDomain', () => {
  it('从三级域名提取主域', () => {
    expect(zoneNameFromDomain('relay.example.com')).toBe('example.com')
    expect(zoneNameFromDomain('a.b.Example.COM')).toBe('example.com')
  })
})

describe('deployEdgeRelay 编排', () => {
  it('按顺序建库→schema→Worker→域名→密码→面板，并带齐绑定与 migration', async () => {
    const { client, calls } = fakeClient()
    // mock /auth/setup
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/auth/setup')) {
        calls.push('auth-setup')
        expect(JSON.parse(String(init?.body)).password).toBe('password123')
        return new Response('{"ok":true}', { status: 200 })
      }
      throw new Error('unexpected fetch ' + url)
    }))

    const result = await deployEdgeRelay(client, { ...baseOpts, onProgress: () => {} })

    // 顺序
    expect(calls[0]).toBe('d1:edge-relay-test-monitor')
    expect(calls.filter((c) => c.startsWith('sql:'))).toHaveLength(6)
    expect(calls[1]).toBe('sql:SELECT 1')
    expect(calls).toContain('worker:edge-relay-test')
    expect(calls.indexOf('domain')).toBeGreaterThan(calls.indexOf('worker:edge-relay-test'))
    expect(calls).toContain('auth-setup')
    expect(calls).toContain('pages-upload')

    // Worker 绑定与 migration
    const upload = (globalThis as Record<string, unknown>).__lastUpload as {
      bindings: Array<{ name: string; type: string; id?: string; class_name?: string }>
      doExports?: Record<string, { type: string; state: string; storage: string }>
      code: string
    }
    expect(upload.bindings.find((b) => b.name === 'DB')).toMatchObject({ type: 'd1', id: 'db-uuid-12345678' })
    expect(upload.bindings.find((b) => b.name === 'MESH_ROOM')).toMatchObject({ type: 'durable_object_namespace', class_name: 'MeshRoom' })
    // 新版平台用 exports 声明 DO（真机验证），不是旧 migrations 数组
    expect(upload.doExports).toEqual({
      MeshRoom: { type: 'durable-object', state: 'created', storage: 'sqlite' },
    })
    expect(upload.code).toContain('export')

    // 汇总字段
    expect(result.workerUrl).toBe('https://relay.example.com')
    expect(result.wssEndpoint).toContain('/mesh/')
    expect(result.monitorToken).toBe('mon-token-xyz')

    // dashboard-worker 内的 DEFAULT_API 被替换为真实 WorkerUrl（面板指向本次部署）
    const code = (globalThis as Record<string, unknown>).__lastWorker as string
    expect(code).toContain("const DEFAULT_API = 'https://relay.example.com'")
    expect(code).not.toContain('relay.shijingtian.de5.net')
    expect(code).toContain('export default')
  })

  it('等待新建 D1 就绪，并重试初始化期间的瞬时错误', async () => {
    let readinessAttempts = 0
    let schemaAttempts = 0
    const { client } = fakeClient(async (sql) => {
      if (sql === 'SELECT 1' && ++readinessAttempts === 1) {
        throw new CloudflareError('D1 database is not ready', 503)
      }
      if (sql !== 'SELECT 1' && ++schemaAttempts === 1) {
        throw new CloudflareError('D1 temporarily unavailable', 429)
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))

    await expect(deployEdgeRelay(client, { ...baseOpts, withDashboard: false })).resolves.toBeTruthy()

    expect(readinessAttempts).toBe(2)
    expect(schemaAttempts).toBe(6)
    expect(client.uploadScript).toHaveBeenCalledOnce()
  })

  it('D1 永久错误不重试，也不上传 Worker', async () => {
    const { client } = fakeClient(async (sql) => {
      if (sql !== 'SELECT 1') throw new CloudflareError('invalid SQL', 400)
    })

    await expect(deployEdgeRelay(client, { ...baseOpts, withDashboard: false })).rejects.toThrow('invalid SQL')

    expect(client.queryD1).toHaveBeenCalledTimes(2)
    expect(client.uploadScript).not.toHaveBeenCalled()
  })

  it('创建 D1 因同名失败时复用已有库', async () => {
    const { client, calls } = fakeClient()
    vi.mocked(client.createD1Database).mockRejectedValueOnce(new CloudflareError('database already exists', 409))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))

    const result = await deployEdgeRelay(client, { ...baseOpts, withDashboard: false })

    expect(client.listD1Databases).toHaveBeenCalledWith('acct', 'edge-relay-test-monitor')
    expect(calls).toContain('d1-list:edge-relay-test-monitor')
    expect(result.d1Uuid).toBe('db-uuid-existing')
  })

  it('/auth/setup 返回 409（已设置）视为幂等成功', async () => {
    const { client } = fakeClient()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/auth/setup')) return new Response('{"code":"conflict"}', { status: 409 })
      throw new Error('unexpected fetch')
    }))
    await expect(deployEdgeRelay(client, baseOpts)).resolves.toBeTruthy()
  })

  it('Worker/D1 暂不可达或限流时重试密码初始化', async () => {
    const { client } = fakeClient()
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/auth/setup')) {
        attempts += 1
        if (attempts === 1) throw new TypeError('fetch failed')
        if (attempts === 2) return new Response('initializing', { status: 503 })
        return new Response('{"ok":true}', { status: 200 })
      }
      throw new Error('unexpected fetch')
    }))
    await expect(deployEdgeRelay(client, { ...baseOpts, withDashboard: false })).resolves.toBeTruthy()
    expect(attempts).toBe(3)
  })

  it('密码初始化返回永久 4xx 时不重试', async () => {
    const { client } = fakeClient()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/auth/setup')) return new Response('bad password', { status: 400 })
      throw new Error('unexpected fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(deployEdgeRelay(client, { ...baseOpts, withDashboard: false })).rejects.toThrow('HTTP 400')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('--no-dashboard 跳过面板部署', async () => {
    const { client, calls } = fakeClient()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))
    await deployEdgeRelay(client, { ...baseOpts, withDashboard: false })
    expect(calls).not.toContain('pages-upload')
  })

  it('密码不足 8 位直接拒绝', async () => {
    const { client } = fakeClient()
    await expect(deployEdgeRelay(client, { ...baseOpts, monitorPassword: 'short' })).rejects.toThrow('8 位')
  })
})

describe('isMonitorSetupDone', () => {
  it('setupRequired=false 表示已初始化', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"setupRequired":false}', { status: 200 })))
    expect(await isMonitorSetupDone('https://x')).toBe(true)
  })
  it('setupRequired=true 表示未初始化', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"setupRequired":true}', { status: 200 })))
    expect(await isMonitorSetupDone('https://x')).toBe(false)
  })
})
