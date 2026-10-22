import { describe, expect, it } from 'vitest'
import { withMockServer, headerValue, type CapturedRequest } from './mock-server'
import { CloudflareClient } from '../src/cf-api'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('内核产物路径解析', () => {
  it('能从 monorepo 的 worker-core/dist 找到构建产物', () => {
    // 与 pages-deploy.ts 的 loadBundle 候选路径保持一致
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      resolve(here, '../worker-core/dist/control.js'),
      resolve(here, '../../worker-core/dist/control.js'),
      resolve(here, '../assets/control.js'),
      resolve(process.cwd(), 'packages/worker-core/dist/control.js'),
    ]
    const found = candidates.find((c) => existsSync(c))
    expect(found, `候选路径均不存在：${candidates.join(', ')}`).toBeTruthy()
  })
})

describe('KV 配置冲突检测', () => {
  it('KV 为空时提示凭据会生效', async () => {
    const logs: string[] = []
    await withMockServer(
      () => ({ status: 404, body: { success: false, errors: [{ code: 10009, message: 'not found' }] } }),
      async (base) => {
        const { detectKvConfigConflictForTest } = await import('../src/pages-deploy')
        await detectKvConfigConflictForTest(base, logs.push.bind(logs))
      }
    )
    expect(logs.join('\n')).toContain('KV 是空的')
  })

  it('KV 已有 PANEL_PATH 时提示环境变量不生效', async () => {
    const logs: string[] = []
    await withMockServer(
      (req) => {
        const key = req.url.split('/values/')[1] ?? ''
        if (key === 'PANEL_PATH') {
          return { status: 200, body: '/p-existing', contentType: 'text/plain' }
        }
        return { status: 404, body: { success: false, errors: [{ code: 10009, message: 'not found' }] } }
      },
      async (base) => {
        const { detectKvConfigConflictForTest } = await import('../src/pages-deploy')
        await detectKvConfigConflictForTest(base, logs.push.bind(logs))
      }
    )
    const text = logs.join('\n')
    expect(text).toContain('PANEL_PATH')
    expect(text).toContain('不会生效')
    expect(text).toContain('/p-existing')
  })
})

describe('部署参数校验', () => {
  const baseOptions = {
    token: 't',
    accountId: 'acc',
    kvNamespaceId: 'ns-1',
    controlProject: 'ctl',
    dataProject: 'dat',
    panelPath: '/p-abc12345',
    panelPassword: 'pw',
    uuid: '11111111-2222-3333-4444-555555555555',
    trojanPassword: 'tp',
    wsPath: '/abc1234567',
    enableTrojan: true,
    enableXhttp: false,
  }

  it('接受合法参数', async () => {
    const { deployPagesSplit } = await import('../src/pages-deploy')
    await withMockServer(
      () => ({ status: 200, body: { success: true, result: [] } }),
      async (base) => {
        // 只验证不抛参数错误：用空 mock 让后续步骤全失败但 warnings 收集
        const result = await deployPagesSplit({
          ...baseOptions,
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
        expect(result.warnings.every((w) => !w.includes('不合法'))).toBe(true)
      }
    )
  })

  it('拒绝被 MSYS 转换成的 Windows 路径', async () => {
    const { deployPagesSplit } = await import('../src/pages-deploy')
    await expect(
      deployPagesSplit({
        ...baseOptions,
        panelPath: 'C:/Users/wxgo8/.dsh/profiles/web/node_modules/@dsh-ops/bash-win32-x64/p-verify',
        apiBase: 'http://127.0.0.1:1',
        log: () => {},
      })
    ).rejects.toThrow(/不合法|MSYS/)
  })

  it('拒绝含冒号的 UUID 与密码', async () => {
    const { deployPagesSplit } = await import('../src/pages-deploy')
    await expect(
      deployPagesSplit({ ...baseOptions, uuid: 'C:/some/path', apiBase: 'http://127.0.0.1:1', log: () => {} })
    ).rejects.toThrow(/不合法/)
    await expect(
      deployPagesSplit({ ...baseOptions, trojanPassword: 'a:b', apiBase: 'http://127.0.0.1:1', log: () => {} })
    ).rejects.toThrow(/不合法/)
  })

  it('拒绝非法的 Pages 项目名', async () => {
    const { deployPagesSplit } = await import('../src/pages-deploy')
    await expect(
      deployPagesSplit({ ...baseOptions, controlProject: 'Bad_Name', apiBase: 'http://127.0.0.1:1', log: () => {} })
    ).rejects.toThrow(/项目名/)
  })

  it('拒绝非法 WS 路径', async () => {
    const { deployPagesSplit } = await import('../src/pages-deploy')
    // 缺前导斜杠、含大写、含空格、只有斜杠都不合法
    for (const bad of ['vless', '/Vless', '/has space', '/']) {
      await expect(
        deployPagesSplit({ ...baseOptions, wsPath: bad, apiBase: 'http://127.0.0.1:1', log: () => {} })
      ).rejects.toThrow(/不合法/)
    }
  })
})

describe('数据面 KV config 同步', () => {
  const baseOptions = {
    token: 't',
    accountId: 'acc',
    kvNamespaceId: 'ns-1',
    controlProject: 'ctl',
    dataProject: 'dat',
    panelPath: '/p-abc12345',
    panelPassword: 'pw',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    trojanPassword: 'tp-new',
    wsPath: '/newpath123',
    enableTrojan: true,
    enableXhttp: false,
  }

  it('把 uuid / path / trojanPassword 写进 KV 的 config 键', async () => {
    const written = new Map()
    await withMockServer(
      (req) => {
        const url = req.url
        // KV 读：旧 config
        if (req.method === 'GET' && url.includes('/values/config')) {
          return {
            status: 200,
            body: JSON.stringify({
              uuid: 'old-uuid', path: 'oldpath', admin: 'keep-admin',
              proxyIP: 'keep.proxyip.example', tlsOnly: true,
            }),
            contentType: 'text/plain',
          }
        }
        // KV 写
        if (req.method === 'PUT' && url.includes('/values/')) {
          const key = url.split('/values/')[1] ?? ''
          written.set(key, req.body)
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
          ...baseOptions,
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
        expect(written.size).toBeGreaterThan(0)
        expect(written.has('config')).toBe(true)
        const cfg = JSON.parse(written.get("config")!)
        // 本次凭据必须写进去
        expect(cfg.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        expect(cfg.path).toBe('newpath123')
        expect(cfg.trojanPassword).toBe('tp-new')
        // 用户手动配的字段必须保留
        expect(cfg.admin).toBe('keep-admin')
        expect(cfg.proxyIP).toBe('keep.proxyip.example')
        expect(cfg.tlsOnly).toBe(true)
        // Object.assign 整体覆盖，缺字段会变 undefined：必须写全
        for (const field of ['adminInit', 'login', 'host', 'enableVless', 'enableTrojan', 'enableXhttp', 'outboundProxy', 'outboundMode']) {
          expect(cfg[field], `字段 ${field} 不应为 undefined`).not.toBeUndefined()
        }
      }
    )
  })

  it('WS 路径去掉前导斜杠后再写入', async () => {
    const written = new Map()
    await withMockServer(
      (req) => {
        const url = req.url
        if (req.method === 'GET' && url.includes('/values/config')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          const key = url.split('/values/')[1] ?? ''
          written.set(key, req.body)
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
          ...baseOptions,
          wsPath: '/stripme',
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
        expect(JSON.parse(written.get('config')!).path).toBe('stripme')
      }
    )
  })

  it('KV 写入失败时记入 warnings 且不抛出', async () => {
    await withMockServer(
      (req) => {
        const url = req.url
        if (req.method === 'GET' && url.includes('/values/config')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/config')) {
          return {
            status: 403,
            body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          }
        }
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        const result = await deployPagesSplit({
          ...baseOptions,
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
        expect(result.warnings.some((w) => w.includes('KV 配置同步失败'))).toBe(true)
      }
    )
  })
})

describe('部署清单与更新模式', () => {
  const baseOptions = {
    token: 't',
    accountId: 'acc',
    kvNamespaceId: 'ns-1',
    controlProject: 'ctl',
    dataProject: 'dat',
    panelPath: '/p-abc12345',
    panelPassword: 'pw',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    trojanPassword: 'tp',
    wsPath: '/testpath12',
    enableTrojan: true,
    enableXhttp: false,
    localBuild: 'build-001',
  }

  /** 构造完整 mock：支持 KV 读写（含清单键） */
  function fullMock(options: { existingManifest?: string; onDeploy?: (p: string, n: number) => boolean } = {}) {
    const kv = new Map()
    if (options.existingManifest) kv.set('CFP_DEPLOY_MANIFEST', options.existingManifest)
    const deploys: string[] = []
    return {
      kv,
      deploys,
      handler: (req: CapturedRequest) => {
        const url = req.url
        if (req.method === 'GET' && url.includes('/values/')) {
          const key = decodeURIComponent(url.split('/values/')[1] ?? '')
          const value = kv.get(key)
          if (value === undefined) {
            return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
          }
          return { status: 200, body: value, contentType: 'text/plain' }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          const key = decodeURIComponent(url.split('/values/')[1] ?? '')
          kv.set(key, req.body)
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: name + '.pages.dev' } } }
        }
        if (req.method === 'GET' && /pages\/projects\/[^/]+$/.test(url)) {
          const name = url.split('/').pop()
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: name + '.pages.dev' } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'POST' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          deploys.push(project)
          const ok = options.onDeploy ? options.onDeploy(project, deploys.length) : true
          if (!ok) {
            return { status: 400, body: { success: false, errors: [{ code: 8000119, message: 'blocked' }] } }
          }
          return {
            status: 200,
            body: { success: true, result: { id: 'dep-' + project, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] } },
          }
        }
        if (req.method === 'GET' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: [{ id: 'dep-' + project, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] }] },
          }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'unhandled' }] } }
      },
    }
  }

  const oldManifest = JSON.stringify({
    v: 1,
    controlProject: 'ctl-old',
    dataProject: 'dat-old',
    controlSubdomain: 'ctl-old.pages.dev',
    dataSubdomain: 'dat-old.pages.dev',
    build: 'build-000',
    at: '2026-10-22T00:00:00.000Z',
    credentials: {
      panelPath: '/p-oldpath', panelPassword: 'old-pw',
      uuid: '99999999-8888-7777-6666-555555555555',
      trojanPassword: 'old-tp', wsPath: '/oldpath12',
    },
  })

  it('首次部署后写入清单，记录两个项目名与凭据', async () => {
    const mock = fullMock()
    await withMockServer(mock.handler, async (base) => {
      const { deployPagesSplit } = await import('../src/pages-deploy')
      await deployPagesSplit({
        ...baseOptions,
        apiBase: base,
        bundles: { control: 'x', data: 'x' },
        wait: { timeoutMs: 500, intervalMs: 10 },
        log: () => {},
      })
      const raw = mock.kv.get('CFP_DEPLOY_MANIFEST')
      expect(raw).toBeTruthy()
      const m = JSON.parse(raw)
      expect(m.v).toBe(1)
      expect(m.controlProject).toBe('ctl')
      expect(m.dataProject).toBe('dat')
      expect(m.build).toBe('build-001')
      expect(m.credentials.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
      expect(m.credentials.wsPath).toBe('/testpath12')
    })
  })

  it('版本相同时跳过部署', async () => {
    const mock = fullMock({ existingManifest: oldManifest })
    await withMockServer(mock.handler, async (base) => {
      const { deployPagesSplit } = await import('../src/pages-deploy')
      const result = await deployPagesSplit({
        ...baseOptions,
        localBuild: 'build-000',
        apiBase: base,
        bundles: { control: 'x', data: 'x' },
        wait: { timeoutMs: 500, intervalMs: 10 },
        log: () => {},
      })
      expect(mock.deploys).toEqual([])
      expect(result.control.subdomain).toBe('ctl-old.pages.dev')
      expect(result.data.subdomain).toBe('dat-old.pages.dev')
    })
  })

  it('版本不同时更新部署，且沿用旧 UUID 与旧项目名', async () => {
    const mock = fullMock({ existingManifest: oldManifest })
    await withMockServer(mock.handler, async (base) => {
      const { deployPagesSplit } = await import('../src/pages-deploy')
      await deployPagesSplit({
        ...baseOptions,
        localBuild: 'build-002',
        // 不显式传凭据：验证默认沿用清单里的旧值
        uuid: "",
        wsPath: "",
        panelPassword: "",
        apiBase: base,
        bundles: { control: 'x', data: 'x' },
        wait: { timeoutMs: 500, intervalMs: 10 },
        log: () => {},
      })
      expect(mock.deploys.sort()).toEqual(['ctl-old', 'dat-old'])
      const cfg = JSON.parse(mock.kv.get('config'))
      expect(cfg.uuid).toBe('99999999-8888-7777-6666-555555555555')
      expect(cfg.path).toBe('oldpath12')
    })
  })

  it('fresh 模式忽略清单，使用新项目名与新凭据', async () => {
    const mock = fullMock({ existingManifest: oldManifest })
    await withMockServer(mock.handler, async (base) => {
      const { deployPagesSplit } = await import('../src/pages-deploy')
      await deployPagesSplit({
        ...baseOptions,
        mode: 'fresh',
        apiBase: base,
        bundles: { control: 'x', data: 'x' },
        wait: { timeoutMs: 500, intervalMs: 10 },
        log: () => {},
      })
      expect(mock.deploys.sort()).toEqual(['ctl', 'dat'])
      const cfg = JSON.parse(mock.kv.get('config'))
      expect(cfg.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    })
  })
})

describe('Pages API 客户端', () => {
  it('创建 Pages 项目提交 name 与 production_branch', async () => {
    await withMockServer(
      (req) => {
        if (req.method === 'POST' && req.url.endsWith('/pages/projects')) {
          return { status: 200, body: { success: true, result: { id: 'p1', name: 'demo', subdomain: 'demo.pages.dev' } } }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
      },
      async (base, requests) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const project = await client.createPagesProject('acc', { name: 'demo' })
        expect(project.subdomain).toBe('demo.pages.dev')
        const body = JSON.parse(requests[0]!.body)
        expect(body.name).toBe('demo')
        expect(body.production_branch).toBe('main')
      }
    )
  })

  it('配置部署接口提交 kv_namespaces 与 env_vars', async () => {
    await withMockServer(
      (req) => {
        if (req.method === 'PATCH' && req.url.includes('/pages/projects/demo')) {
          return { status: 200, body: { success: true, result: {} } }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base, requests) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        await client.updatePagesDeploymentConfig('acc', 'demo', {
          kv_namespaces: { KV: { namespace_id: 'ns-1' } },
          env_vars: { PANEL_PATH: { value: '/p-x' } },
        })
        const body = JSON.parse(requests[0]!.body)
        expect(body.deployment_configs.production.kv_namespaces.KV.namespace_id).toBe('ns-1')
        expect(body.deployment_configs.production.env_vars.PANEL_PATH.value).toBe('/p-x')
      }
    )
  })

  it('部署接口使用 multipart 且含 _worker.bundle 字段', async () => {
    await withMockServer(
      (req) => {
        if (req.method === 'POST' && req.url.includes('/deployments')) {
          return { status: 200, body: { success: true, result: { id: 'd1', url: 'https://d1.demo.pages.dev' } } }
        }
        return { status: 500, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base, requests) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const deployment = await client.deployPagesWorker('acc', 'demo', { code: 'export default {}' })
        expect(deployment.id).toBe('d1')
        // multipart 且不手动设 JSON Content-Type
        expect(headerValue(requests[0]!, 'content-type')).toContain('multipart/form-data')
        expect(requests[0]!.body).toContain('name="_worker.bundle"')
        expect(requests[0]!.body).toContain('name="branch"')
        expect(requests[0]!.body).toContain('main')
        // 内层 bundle 里应有 metadata 与 _worker.js
        expect(requests[0]!.body).toContain('name="metadata"')
        expect(requests[0]!.body).toContain('name="_worker.js"')
      }
    )
  })

  it('查询部署列表按时间倒序返回', async () => {
    await withMockServer(
      () => ({
        status: 200,
        body: {
          success: true,
          result: [
            { id: 'd2', url: 'u2', latest_stage: { name: 'deploy', status: 'success' }, stages: [] },
            { id: 'd1', url: 'u1', latest_stage: { name: 'deploy', status: 'success' }, stages: [] },
          ],
        },
      }),
      async (base) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const list = await client.getPagesDeployments('acc', 'demo')
        expect(list.map((d) => d.id)).toEqual(['d2', 'd1'])
        expect(list[0]!.latest_stage.status).toBe('success')
      }
    )
  })

  it('Pages 8000119 封禁错误保留错误码', async () => {
    await withMockServer(
      () => ({
        status: 400,
        body: {
          success: false,
          errors: [{ code: 8000119, message: 'Your Pages project has been blocked. Contact abusereply@cloudflare.com.' }],
        },
      }),
      async (base) => {
        const client = new CloudflareClient({ token: 't', apiBase: base })
        await expect(
          client.deployPagesWorker('acc', 'demo', { code: 'x' })
        ).rejects.toMatchObject({ name: 'CloudflareError', status: 400, code: 8000119 })
      }
    )
  })
})

describe('Pages 双项目部署流程', () => {
  it('按「建项目 → 配变量 → 先数据面后控制面」顺序执行', async () => {
    const calls: Array<{ method: string; path: string }> = []
    await withMockServer(
      (req) => {
        calls.push({ method: req.method, path: req.url })
        const url = req.url
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH' && url.includes('/pages/projects/')) {
          return { status: 200, body: { success: true, result: {} } }
        }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'POST' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: { id: `dep-${project}`, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] } },
          }
        }
        if (req.method === 'GET' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: [{ id: `dep-${project}`, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] }] },
          }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'unhandled ' + req.method + ' ' + url }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        const result = await deployPagesSplit({
          token: 't',
          accountId: 'acc',
          kvNamespaceId: 'ns-1',
          controlProject: 'ctl',
          dataProject: 'dat',
          panelPath: '/p-test',
          panelPassword: 'pw',
          uuid: '11111111-2222-3333-4444-555555555555',
          trojanPassword: 'tp',
          wsPath: '/testpath12',
          enableTrojan: true,
          enableXhttp: false,
          wait: { timeoutMs: 5000, intervalMs: 10 },
          apiBase: base,
          bundles: { control: 'export default {}', data: 'export default {}' },
          log: () => {},
        })

        expect(result.warnings).toEqual([])
        expect(result.control.subdomain).toBe('ctl.pages.dev')
        expect(result.data.subdomain).toBe('dat.pages.dev')
        expect(result.control.deploymentId).toBe('dep-ctl')
        expect(result.data.deploymentId).toBe('dep-dat')

        // 顺序校验：两个项目创建 → 两次 PATCH 配置 → 数据面部署 → 控制面部署
        const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pages/projects'))
        const patches = calls.filter((c) => c.method === 'PATCH')
        const deploys = calls.filter((c) => c.method === 'POST' && c.path.includes('/deployments'))
        expect(creates.length).toBe(2)
        expect(patches.length).toBe(2)
        expect(deploys.length).toBe(2)
        // 数据面必须先部署（控制面的 DATA_HOST 才有效）
        expect(deploys[0]!.path).toContain('/dat/deployments')
        expect(deploys[1]!.path).toContain('/ctl/deployments')
      }
    )
  })

  it('8000119 时自动换项目名重试，全部失败才记 warnings', async () => {
    await withMockServer(
      (req) => {
        const url = req.url
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'GET' && /pages\/projects\/[^/]+$/.test(url)) {
          const name = url.split('/').pop()!
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'POST' && url.includes('/deployments')) {
          return {
            status: 400,
            body: { success: false, errors: [{ code: 8000119, message: 'Your Pages project has been blocked. Contact abusereply@cloudflare.com.' }] },
          }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        const result = await deployPagesSplit({
          token: 't',
          accountId: 'acc',
          kvNamespaceId: 'ns-1',
          controlProject: 'ctl',
          dataProject: 'dat',
          panelPath: '/p-test1234',
          panelPassword: 'pw',
          uuid: 'u',
          trojanPassword: 'tp',
          wsPath: '/testpath12',
          enableTrojan: true,
          enableXhttp: false,
          wait: { timeoutMs: 5000, intervalMs: 10 },
          apiBase: base,
          bundles: { control: 'export default {}', data: 'export default {}' },
          log: () => {},
        })
        // 3 个候选名都试过，两边各记一条 warning
        expect(result.warnings.length).toBe(2)
        expect(result.warnings.every((w) => /8000119|blocked/.test(w))).toBe(true)
      }
    )
  })

  it('8000119 后换名成功则继续部署', async () => {
    let deployCount = 0
    await withMockServer(
      (req) => {
        const url = req.url
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'GET' && /pages\/projects\/[^/]+$/.test(url)) {
          const name = url.split('/').pop()!
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'POST' && url.includes('/deployments')) {
          deployCount++
          // 第一次（原项目名）封禁，之后成功
          if (deployCount === 1) {
            return {
              status: 400,
              body: { success: false, errors: [{ code: 8000119, message: 'Your Pages project has been blocked.' }] },
            }
          }
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: { id: `dep-${project}`, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] } },
          }
        }
        if (req.method === 'GET' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: [{ id: `dep-${project}`, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] }] },
          }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        const result = await deployPagesSplit({
          token: 't',
          accountId: 'acc',
          kvNamespaceId: 'ns-1',
          controlProject: 'ctl',
          dataProject: 'dat',
          panelPath: '/p-test1234',
          panelPassword: 'pw',
          uuid: 'u',
          trojanPassword: 'tp',
          wsPath: '/testpath12',
          enableTrojan: true,
          enableXhttp: false,
          wait: { timeoutMs: 5000, intervalMs: 10 },
          apiBase: base,
          bundles: { control: 'export default {}', data: 'export default {}' },
          log: () => {},
        })
        // 数据面换名成功，不应有 warning
        expect(result.warnings).toEqual([])
        // 数据面用了新项目名（带随机后缀）
        expect(result.data.name).not.toBe('dat')
        expect(result.data.name).toMatch(/^dat-[a-z0-9]{4}$/)
      }
    )
  })

  it('项目已存在时复用它而不是报错', async () => {
    await withMockServer(
      (req) => {
        const url = req.url
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          // 实测：已存在时返回 400 + 无错误码的消息（不是固定 8000017）
          return {
            status: 400,
            body: { success: false, errors: [{ code: 8000000, message: 'A project with this name already exists. Choose a different project name.' }] },
          }
        }
        if (req.method === 'GET' && /pages\/projects\/[^/]+$/.test(url)) {
          const name = url.split('/').pop()!
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }
        if (req.method === 'POST' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: { id: `dep-${project}`, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] } },
          }
        }
        if (req.method === 'GET' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: [{ id: `dep-${project}`, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] }] },
          }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'unhandled ' + req.method + ' ' + url }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        const result = await deployPagesSplit({
          token: 't',
          accountId: 'acc',
          kvNamespaceId: 'ns-1',
          controlProject: 'ctl',
          dataProject: 'dat',
          panelPath: '/p-test',
          panelPassword: 'pw',
          uuid: 'u',
          trojanPassword: 'tp',
          wsPath: '/testpath12',
          enableTrojan: true,
          enableXhttp: false,
          wait: { timeoutMs: 3000, intervalMs: 10 },
          apiBase: base,
          bundles: { control: 'export default {}', data: 'export default {}' },
          log: () => {},
        })
        expect(result.control.subdomain).toBe('ctl.pages.dev')
        expect(result.data.subdomain).toBe('dat.pages.dev')
        expect(result.warnings).toEqual([])
      }
    )
  })
})
