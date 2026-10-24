import { describe, expect, it } from 'vitest'
import { withMockServer, cfError, type CapturedRequest, type MockResponse } from './mock-server'
import { CloudflareClient } from '../src/cf-api'
import {
  deployWorkerSplit,
  inspectWorkerKvOwnership,
  readWorkerManifest,
  WORKER_MANIFEST_KEY,
} from '../src/worker-deploy'

/**
 * Workers 双脚本部署。
 *
 * 这些用例锁住三件在真机上踩过的事：
 *   1. **部署顺序**：必须先传数据面，控制面的 DATA_HOST 才有正确值；
 *   2. **清单键隔离**：Workers 清单写 `CFP_DEPLOY_MANIFEST_WORKERS`，
 *      不能污染 Pages 的 `CFP_DEPLOY_MANIFEST`；
 *   3. **KV 归属**：Pages 实例占用的 KV 不能再被 Workers 形态复用。
 */
describe('Workers 双脚本部署', () => {
  /** 收集上传的 metadata，便于断言绑定与顺序 */
  interface Uploaded {
    name: string
    metadata: Record<string, unknown>
  }

  function handler(state: { uploads: Uploaded[]; kv: Map<string, string> }) {
    return (req: CapturedRequest): MockResponse => {
      const url = req.url

      // 上传脚本：PUT /accounts/{id}/workers/scripts/{name}
      const scriptMatch = /\/workers\/scripts\/([^/?]+)$/.exec(url)
      if (scriptMatch && req.method === 'PUT') {
        const name = decodeURIComponent(scriptMatch[1]!)
        // multipart 里 metadata 段是 JSON。不依赖 boundary 细节，
        // 直接找第一个以 { 开头、含 "main_module" 的 JSON 对象。
        let metadata: Record<string, unknown> = {}
        const start = req.body.indexOf('{"main_module"')
        if (start >= 0) {
          // 从 start 起做括号配平，取出完整 JSON（字符串内的括号要跳过）
          let depth = 0
          let inStr = false
          let escaped = false
          for (let i = start; i < req.body.length; i++) {
            const ch = req.body[i]!
            if (inStr) {
              if (escaped) escaped = false
              else if (ch === '\\') escaped = true
              else if (ch === '"') inStr = false
              continue
            }
            if (ch === '"') { inStr = true; continue }
            if (ch === '{') depth++
            else if (ch === '}') {
              depth--
              if (depth === 0) {
                try {
                  metadata = JSON.parse(req.body.slice(start, i + 1)) as Record<string, unknown>
                } catch {
                  metadata = {}
                }
                break
              }
            }
          }
        }
        state.uploads.push({ name, metadata })
        return { status: 200, body: { success: true, errors: [], result: { id: name, tag: 'tag' } } }
      }

      // 开启 workers.dev 子域
      if (/\/subdomain$/.test(url) && req.method === 'POST') {
        return { status: 200, body: { success: true, errors: [], result: { enabled: true } } }
      }

      // workers.dev 子域
      if (/\/workers\/subdomain$/.test(url)) {
        return { status: 200, body: { success: true, errors: [], result: { subdomain: 'demo' } } }
      }

      // KV 读写
      if (/\/storage\/kv\/namespaces\/[^/]+\/values\//.test(url)) {
        const key = decodeURIComponent(url.split('/values/')[1] ?? '')
        if (req.method === 'PUT') {
          state.kv.set(key, req.body)
          return { status: 200, body: { success: true, errors: [], result: null } }
        }
        const value = state.kv.get(key)
        if (value === undefined) return cfError(404, 'not found', 10009)
        return { status: 200, body: value }
      }

      // 自定义域名
      if (/\/workers\/domains$/.test(url) && req.method === 'GET') {
        return { status: 200, body: { success: true, errors: [], result: [] } }
      }
      if (/\/workers\/domains$/.test(url) && req.method === 'PUT') {
        const body = JSON.parse(req.body) as { hostname: string; service: string }
        return {
          status: 200,
          body: {
            success: true,
            errors: [],
            result: { id: 'dom1', hostname: body.hostname, service: body.service, enabled: true },
          },
        }
      }

      return cfError(404, `未模拟的请求：${req.method} ${url}`)
    }
  }

  const baseOptions = {
    token: 'test-token',
    accountId: 'acc1',
    kvNamespaceId: 'kv1',
    controlScript: 'ctlscript',
    dataScript: 'datascript',
    panelPath: '/p-abc',
    panelPassword: 'pw-test',
    uuid: '11111111-2222-3333-4444-555555555555',
    trojanPassword: 'tj-test',
    wsPath: '/ws-abc',
    enableTrojan: true,
    enableXhttp: false,
    // 测试不发起真实网络探测（探测本身有 15s 超时，会让用例很慢）
    skipDataProbe: true,
    bundles: { control: 'export default {}', data: 'export default {}' },
  } as const

  it('先上传数据面、再上传控制面，且控制面的 DATA_HOST 指向数据面', async () => {
    const state = { uploads: [] as Uploaded[], kv: new Map<string, string>() }
    await withMockServer(handler(state), async (base) => {
      const result = await deployWorkerSplit({
        ...baseOptions,
        apiBase: base,
        log: () => {},
      })

      // 顺序：数据面在前
      expect(state.uploads.map((u) => u.name)).toEqual(['datascript', 'ctlscript'])

      // 控制面拿到的 DATA_HOST 必须是数据面域名
      const control = state.uploads.find((u) => u.name === 'ctlscript')!
      const bindings = (control.metadata.bindings ?? []) as Array<{ name: string; text?: string }>
      const dataHost = bindings.find((b) => b.name === 'DATA_HOST')?.text
      expect(dataHost).toBe('datascript.demo.workers.dev')

      // 数据面必须带 UUID / WS 路径（大小写两个名字都注入）
      const data = state.uploads.find((u) => u.name === 'datascript')!
      const dataBindings = (data.metadata.bindings ?? []) as Array<{ name: string; text?: string }>
      const names = dataBindings.map((b) => b.name)
      expect(names).toContain('UUID')
      expect(names).toContain('WS_PATH')
      expect(names).toContain('PATH')
      expect(names).toContain('KV')
      expect(names).toContain('K')

      expect(result.control.host).toBe('ctlscript.demo.workers.dev')
      expect(result.data.host).toBe('datascript.demo.workers.dev')
    })
  })

  it('清单写到独立的 CFP_DEPLOY_MANIFEST_WORKERS 键，不污染 Pages 清单', async () => {
    const state = { uploads: [] as Uploaded[], kv: new Map<string, string>() }
    // 放一个**另一个实例**的 Pages 清单，验证不会被 Workers 部署改写。
    // （同一 KV 上不能同时跑两种形态，这里用 force 绕过归属校验，
    //  只验证「清单键互不干扰」这一点。）
    state.kv.set('CFP_DEPLOY_MANIFEST', '{"v":1,"controlProject":"other-instance","dataProject":"d"}')

    await withMockServer(handler(state), async (base) => {
      await deployWorkerSplit({ ...baseOptions, apiBase: base, force: true, log: () => {} })
    })

    // Pages 清单原样保留
    expect(state.kv.get('CFP_DEPLOY_MANIFEST')).toBe(
      '{"v":1,"controlProject":"other-instance","dataProject":"d"}'
    )

    // Workers 清单独立存在且内容正确
    const raw = state.kv.get(WORKER_MANIFEST_KEY)
    expect(raw).toBeTruthy()
    const manifest = JSON.parse(raw!) as {
      kind: string
      controlScript: string
      dataScript: string
      credentials: { uuid: string }
    }
    expect(manifest.kind).toBe('workers')
    expect(manifest.controlScript).toBe('ctlscript')
    expect(manifest.dataScript).toBe('datascript')
    expect(manifest.credentials.uuid).toBe(baseOptions.uuid)

    // 凭据写到大写 CONFIG（不是 CFNext 的小写 config）
    expect(state.kv.has('CONFIG')).toBe(true)
    expect(state.kv.has('config')).toBe(false)
  })

  it('更新部署沿用已有凭据（客户端订阅地址不变）', async () => {
    const state = { uploads: [] as Uploaded[], kv: new Map<string, string>() }
    state.kv.set(
      WORKER_MANIFEST_KEY,
      JSON.stringify({
        v: 1,
        kind: 'workers',
        controlScript: 'ctlscript',
        dataScript: 'datascript',
        controlHost: 'ctl.example.com',
        dataHost: 'data.example.com',
        build: 'old-build',
        at: '2026-01-01T00:00:00.000Z',
        credentials: {
          panelPath: '/p-old',
          panelPassword: 'pw-old',
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          trojanPassword: 'tj-old',
          wsPath: '/ws-old',
        },
      })
    )

    await withMockServer(handler(state), async (base) => {
      const result = await deployWorkerSplit({
        ...baseOptions,
        // 显式留空 → 应当沿用清单里的旧值
        panelPath: '',
        panelPassword: '',
        uuid: '',
        trojanPassword: '',
        wsPath: '',
        apiBase: base,
        localBuild: 'new-build',
        log: () => {},
      })
      expect(result.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
      expect(result.wsPath).toBe('/ws-old')
      expect(result.panelPath).toBe('/p-old')
    })

    // 注入的变量也必须是旧凭据
    const data = state.uploads.find((u) => u.name === 'datascript')!
    const bindings = (data.metadata.bindings ?? []) as Array<{ name: string; text?: string }>
    expect(bindings.find((b) => b.name === 'UUID')?.text).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  it('版本相同时跳过部署', async () => {
    const state = { uploads: [] as Uploaded[], kv: new Map<string, string>() }
    state.kv.set(
      WORKER_MANIFEST_KEY,
      JSON.stringify({
        v: 1,
        kind: 'workers',
        controlScript: 'ctlscript',
        dataScript: 'datascript',
        controlHost: 'ctl.example.com',
        dataHost: 'data.example.com',
        build: 'same-build',
        at: '2026-01-01T00:00:00.000Z',
        credentials: {
          panelPath: '/p-old',
          panelPassword: 'pw-old',
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          trojanPassword: 'tj-old',
          wsPath: '/ws-old',
        },
      })
    )

    await withMockServer(handler(state), async (base) => {
      await deployWorkerSplit({ ...baseOptions, apiBase: base, localBuild: 'same-build', log: () => {} })
    })

    expect(state.uploads).toHaveLength(0)
  })

  it('Pages 实例占用的 KV 会被拒绝（两种形态不能共用 KV）', async () => {
    const state = { uploads: [] as Uploaded[], kv: new Map<string, string>() }
    state.kv.set(
      'CFP_DEPLOY_MANIFEST',
      JSON.stringify({ v: 1, controlProject: 'pages-ctl', dataProject: 'pages-data' })
    )

    await withMockServer(handler(state), async (base) => {
      await expect(
        deployWorkerSplit({ ...baseOptions, apiBase: base, log: () => {} })
      ).rejects.toThrow(/已承载 Pages 实例/)
    })

    // 校验失败时不能有任何上传动作
    expect(state.uploads).toHaveLength(0)
  })

  it('参数非法（MSYS 污染路径）直接抛出，不发起任何请求', async () => {
    const state = { uploads: [] as Uploaded[], kv: new Map<string, string>() }
    await withMockServer(handler(state), async (base) => {
      await expect(
        deployWorkerSplit({
          ...baseOptions,
          panelPath: 'C:/Users/x/bash-win32-x64/p-abc',
          apiBase: base,
          log: () => {},
        })
      ).rejects.toThrow(/部署参数不合法/)
    })
    expect(state.uploads).toHaveLength(0)
  })
})

describe('Workers KV 归属判定', () => {
  it('空 KV 放行', async () => {
    const kv = new Map<string, string>()
    await withMockServer(
      (req) => {
        if (/\/values\//.test(req.url)) {
          const key = decodeURIComponent(req.url.split('/values/')[1] ?? '')
          return kv.has(key)
            ? { status: 200, body: kv.get(key)! }
            : cfError(404, 'not found', 10009)
        }
        return cfError(404, 'unexpected')
      },
      async (base) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const info = await inspectWorkerKvOwnership(client, 'acc1', 'kv1', 'ctlscript')
        expect(info.verdict).toBe('empty')
        expect(info.blocking).toBe(false)
      }
    )
  })

  it('同源 Workers 清单判定为 owned', async () => {
    const kv = new Map<string, string>()
    kv.set(
      WORKER_MANIFEST_KEY,
      JSON.stringify({
        v: 1,
        kind: 'workers',
        controlScript: 'ctlscript',
        dataScript: 'datascript',
        controlHost: 'c',
        dataHost: 'd',
        build: 'b',
        at: 'now',
        credentials: {},
      })
    )
    await withMockServer(
      (req) => {
        if (/\/values\//.test(req.url)) {
          const key = decodeURIComponent(req.url.split('/values/')[1] ?? '')
          return kv.has(key)
            ? { status: 200, body: kv.get(key)! }
            : cfError(404, 'not found', 10009)
        }
        return cfError(404, 'unexpected')
      },
      async (base) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const info = await inspectWorkerKvOwnership(client, 'acc1', 'kv1', 'ctlscript')
        expect(info.verdict).toBe('owned')
        expect(info.blocking).toBe(false)
      }
    )
  })

  it('readWorkerManifest 对非 Workers 清单返回 null', async () => {
    const kv = new Map<string, string>()
    // kind 不对（比如误写成 pages）应当被视为「不是 Workers 清单」
    kv.set(WORKER_MANIFEST_KEY, JSON.stringify({ v: 1, kind: 'pages', controlScript: 'x' }))
    await withMockServer(
      (req) => {
        if (/\/values\//.test(req.url)) {
          const key = decodeURIComponent(req.url.split('/values/')[1] ?? '')
          return kv.has(key)
            ? { status: 200, body: kv.get(key)! }
            : cfError(404, 'not found', 10009)
        }
        return cfError(404, 'unexpected')
      },
      async (base) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        expect(await readWorkerManifest(client, 'acc1', 'kv1')).toBeNull()
      }
    )
  })
})
