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

/**
 * KV 归属校验。
 *
 * 一个 KV 命名空间 = 一个 CFPilot 部署实例。
 * 往不属于自己的命名空间里写键会直接改坏别人的线上项目，
 * 因此越界写入必须在动手前被拦住。
 */
describe('KV 归属校验', () => {
  const notFound = { status: 404, body: { success: false, errors: [{ code: 10009, message: 'not found' }] } }

  /** 构造一个只对指定键返回内容的 mock */
  function kvWith(keys: Record<string, string>) {
    return (req: { url: string }) => {
      const key = decodeURIComponent(req.url.split('/values/')[1] ?? '')
      const value = keys[key]
      if (value !== undefined) {
        return { status: 200, body: value, contentType: 'text/plain' }
      }
      return notFound
    }
  }

  it('空命名空间放行', async () => {
    const logs: string[] = []
    await withMockServer(
      kvWith({}),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const info = await assertKvOwnership(client, 'acc', 'ns', {
          controlProject: 'ctl',
          mode: 'auto',
          log: logs.push.bind(logs),
        })
        expect(info.verdict).toBe('empty')
      }
    )
    expect(logs.join('\n')).toContain('归属校验通过')
  })

  it('清单属于本次目标时放行（原地更新）', async () => {
    const manifest = JSON.stringify({
      v: 1,
      controlProject: 'ctl',
      dataProject: 'dat',
      controlSubdomain: 'a.pages.dev',
      dataSubdomain: 'b.pages.dev',
      build: 'x',
      at: '2026-10-22T00:00:00.000Z',
      credentials: { panelPath: '/p', panelPassword: 'pw', uuid: 'u', trojanPassword: 't', wsPath: '/w' },
    })
    await withMockServer(
      kvWith({ CFP_DEPLOY_MANIFEST: manifest }),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const info = await assertKvOwnership(client, 'acc', 'ns', {
          controlProject: 'ctl',
          mode: 'update',
          log: () => {},
        })
        expect(info.verdict).toBe('owned')
      }
    )
  })

  it('清单属于另一个实例时中止', async () => {
    const manifest = JSON.stringify({
      v: 1,
      controlProject: 'other-ctl',
      dataProject: 'other-dat',
      controlSubdomain: 'a.pages.dev',
      dataSubdomain: 'b.pages.dev',
      build: 'x',
      at: '2026-10-22T00:00:00.000Z',
      credentials: { panelPath: '/p', panelPassword: 'pw', uuid: 'u', trojanPassword: 't', wsPath: '/w' },
    })
    await withMockServer(
      kvWith({ CFP_DEPLOY_MANIFEST: manifest }),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        await expect(
          assertKvOwnership(client, 'acc', 'ns', { controlProject: 'ctl', mode: 'auto', log: () => {} })
        ).rejects.toThrow(/另一个 CFPilot 实例/)
      }
    )
  })

  it('force 时允许覆盖他人实例', async () => {
    const manifest = JSON.stringify({
      v: 1,
      controlProject: 'other-ctl',
      dataProject: 'other-dat',
      controlSubdomain: 'a.pages.dev',
      dataSubdomain: 'b.pages.dev',
      build: 'x',
      at: '2026-10-22T00:00:00.000Z',
      credentials: { panelPath: '/p', panelPassword: 'pw', uuid: 'u', trojanPassword: 't', wsPath: '/w' },
    })
    const logs: string[] = []
    await withMockServer(
      kvWith({ CFP_DEPLOY_MANIFEST: manifest }),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const info = await assertKvOwnership(client, 'acc', 'ns', {
          controlProject: 'ctl',
          mode: 'auto',
          force: true,
          log: logs.push.bind(logs),
        })
        expect(info.verdict).toBe('occupied')
      }
    )
    expect(logs.join('\n')).toContain('强制覆盖')
  })

  it('含其他项目 config 键时必须阻断（纯自研，不与他人共用 KV）', async () => {
    await withMockServer(
      kvWith({ config: '{"uuid":"x"}' }),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        const err = await assertKvOwnership(client, 'acc', 'ns', {
          controlProject: 'ctl',
          mode: 'auto',
        }).then(
          () => null,
          (e: Error) => e
        )
        expect(err).toBeInstanceOf(Error)
        expect(err?.message).toContain('config')
        expect(err?.message).toContain('独立的 KV')
      }
    )
  })

  it('其他项目占用时加 force 也不能绕过（硬约束）', async () => {
    await withMockServer(
      kvWith({ config: '{"uuid":"x"}' }),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        // force: true 只对 occupied / stale 生效，对 foreign 无效
        await expect(
          assertKvOwnership(client, 'acc', 'ns', {
            controlProject: 'ctl',
            mode: 'auto',
            force: true,
          })
        ).rejects.toThrow(/config|命名空间/)
      }
    )
  })

  it('含残留 CONFIG 但无清单时中止', async () => {
    await withMockServer(
      kvWith({ CONFIG: '{"uuid":"x"}' }),
      async (base) => {
        const { assertKvOwnership } = await import('../src/pages-deploy')
        const { CloudflareClient } = await import('../src/cf-api')
        const client = new CloudflareClient({ token: 't', apiBase: base })
        await expect(
          assertKvOwnership(client, 'acc', 'ns', { controlProject: 'ctl', mode: 'auto', log: () => {} })
        ).rejects.toThrow(/残留配置/)
      }
    )
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
      // KV 读取返回 404（= 键不存在），让归属判定落到 empty；
      // 不能用「200 + 空 result」——那种响应会被 getKvValue 当成真实的
      // 空字符串值返回，从而误判成「命名空间已被占用」。
      (req) =>
        req.url?.includes('/values/')
          ? { status: 404, body: { success: false, errors: [{ code: 10009, message: 'not found' }] } }
          : { status: 200, body: { success: true, result: [] } },
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

  it('项目名留空时生成随机名（GUI 可选输入框场景）', async () => {
    const { deployPagesSplit } = await import('../src/pages-deploy')
    await withMockServer(
      // 同前：KV 读取必须是 404，否则会被误判成已被占用
      (req) =>
        req.url?.includes('/values/')
          ? { status: 404, body: { success: false, errors: [{ code: 10009, message: 'not found' }] } }
          : { status: 200, body: { success: true, result: [] } },
      async (base) => {
        const result = await deployPagesSplit({
          ...baseOptions,
          controlProject: '',
          dataProject: '',
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
        // 不抛「参数不合法」，且两个名字都被填成合法的 Pages 项目名
        for (const name of [result.control.name, result.data.name]) {
          expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,57}$/)
        }
        expect(result.control.name).not.toBe(result.data.name)
      }
    )
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

describe('部署凭据写入 KV 的 CONFIG 键', () => {
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

  /** 只放行 GET（读 KV）与 PUT（写 KV），其余一律 404 */
  function kvMock(written: Map<string, string>, existing?: Record<string, string>) {
    return (req: CapturedRequest) => {
      const url = req.url
      if (req.method === 'GET' && url.includes('/values/')) {
        const key = decodeURIComponent(url.split('/values/')[1] ?? '')
        const value = existing?.[key]
        if (value === undefined) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        return { status: 200, body: value, contentType: 'text/plain' }
      }
      if (req.method === 'PUT' && url.includes('/values/')) {
        const key = decodeURIComponent(url.split('/values/')[1] ?? '')
        written.set(key, req.body)
        return { status: 200, body: 'ok', contentType: 'text/plain' }
      }
      if (req.method === 'POST' && url.endsWith('/pages/projects')) {
        const name = JSON.parse(req.body).name
        return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
      }
      if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
      return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
    }
  }

  it('把 uuid / wsPath / trojanPassword 写进大写 CONFIG 键', async () => {
    const written = new Map<string, string>()
    await withMockServer(
      kvMock(written),
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
          ...baseOptions,
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
      }
    )
    // 内核读的是大写 CONFIG
    expect(written.has('CONFIG')).toBe(true)
    const cfg = JSON.parse(written.get('CONFIG')!)
    expect(cfg.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(cfg.wsPath).toBe('/newpath123')
    expect(cfg.trojanPassword).toBe('tp-new')
    expect(cfg.enableTrojan).toBe(true)
    expect(cfg.enableXhttp).toBe(false)
  })

  it('绝不写 旧版的小写 config 键（否则会整体覆盖旧版第三方 项目的配置）', async () => {
    const written = new Map<string, string>()
    await withMockServer(
      kvMock(written),
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
          ...baseOptions,
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
      }
    )
    expect(written.has('config')).toBe(false)
  })

  it('保留用户在面板里改过的优选池等设置', async () => {
    const written = new Map<string, string>()
    // 带清单 → 归属为 owned（同一实例的原地更新），因此允许继续
    const manifest = JSON.stringify({
      v: 1,
      controlProject: 'ctl',
      dataProject: 'dat',
      controlSubdomain: 'ctl.pages.dev',
      dataSubdomain: 'dat.pages.dev',
      build: 'build-000',
      at: '2026-10-22T00:00:00.000Z',
      credentials: { panelPath: '/p', panelPassword: 'pw', uuid: 'u', trojanPassword: 't', wsPath: '/w' },
    })
    await withMockServer(
      kvMock(written, {
        CFP_DEPLOY_MANIFEST: manifest,
        CONFIG: JSON.stringify({
          uuid: 'old-uuid',
          add: 'https://keep.example/pool.txt',
          proxyIp: 'keep.proxyip.example',
          subDomain: 'keep.example.com',
          officialCount: 30,
        }),
      }),
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
          ...baseOptions,
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
      }
    )
    const cfg = JSON.parse(written.get('CONFIG')!)
    // 本次凭据覆盖
    expect(cfg.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    // 用户设置保留
    expect(cfg.add).toBe('https://keep.example/pool.txt')
    expect(cfg.proxyIp).toBe('keep.proxyip.example')
    expect(cfg.subDomain).toBe('keep.example.com')
    expect(cfg.officialCount).toBe(30)
  })

  it('KV 写入失败时记入 warnings 且不抛出', async () => {
    await withMockServer(
      (req: CapturedRequest) => {
        const url = req.url
        if (req.method === 'PUT' && url.includes('/values/CONFIG')) {
          return {
            status: 403,
            body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          }
        }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev` } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }
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
        expect(result.warnings.some((w) => w.includes('KV 凭据写入失败'))).toBe(true)
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

  it('把面板密码随结果带回（否则部署后查不到密码）', async () => {
    const mock = fullMock()
    await withMockServer(mock.handler, async (base) => {
      const { deployPagesSplit } = await import('../src/pages-deploy')
      const result = await deployPagesSplit({
        ...baseOptions,
        // 留空让向导随机生成密码，模拟 GUI 首次部署的真实场景
        panelPassword: '',
        apiBase: base,
        bundles: { control: 'x', data: 'x' },
        wait: { timeoutMs: 500, intervalMs: 10 },
        log: () => {},
      })
      expect(result.panelPassword).toBeTruthy()
      // 与写进 KV 清单、控制面环境变量的是同一个值
      expect(result.panelPassword).toBe(JSON.parse(mock.kv.get('CFP_DEPLOY_MANIFEST')).credentials.panelPassword)
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
      // 凭据写入大写 CONFIG 键（内核读的就是这个）
      const cfg = JSON.parse(mock.kv.get('CONFIG')!)
      expect(cfg.uuid).toBe('99999999-8888-7777-6666-555555555555')
      expect(cfg.wsPath).toBe('/oldpath12')
    })
  })

  it('fresh 模式在属于别人的 KV 上会被拒绝（一个 KV 只能承载一个实例）', async () => {
    const mock = fullMock({ existingManifest: oldManifest })
    await withMockServer(mock.handler, async (base) => {
      const { deployPagesSplit } = await import('../src/pages-deploy')
      await expect(
        deployPagesSplit({
          ...baseOptions,
          mode: 'fresh',
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: () => {},
        })
      ).rejects.toThrow(/另一个 CFPilot 实例/)
    })
    // 拒绝必须发生在任何写入与部署之前
    expect(mock.deploys).toEqual([])
    expect(mock.kv.get('CONFIG')).toBeUndefined()
  })

  it('fresh 模式在空 KV 上正常部署，使用新凭据', async () => {
    const mock = fullMock()
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
      const cfg = JSON.parse(mock.kv.get('CONFIG')!)
      expect(cfg.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
      expect(cfg.wsPath).toBe('/testpath12')
    })
  })
})

describe('部署重试：先原样重试，再换名', () => {
  it('8000119 时先重试同一项目，成功则不换名', async () => {
    let attempts = 0
    const logs: string[] = []
    await withMockServer(
      (req: CapturedRequest) => {
        const url = req.url
        if (req.method === 'GET' && url.includes('/deployments')) {
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: [{ id: 'dep-' + project, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] }] },
          }
        }
        if (req.method === 'POST' && url.includes('/deployments')) {
          attempts++
          // 前两次被拒，第三次放行
          if (attempts <= 2) {
            return { status: 400, body: { success: false, errors: [{ code: 8000119, message: 'Your Pages project has been blocked.' }] } }
          }
          const project = /projects\/([^/]+)\/deployments/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: { success: true, result: { id: 'dep-' + project, url: 'u', latest_stage: { name: 'deploy', status: 'success' }, stages: [] } },
          }
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
          apiBase: base,
          bundles: { control: 'x', data: 'x' },
          wait: { timeoutMs: 500, intervalMs: 10 },
          log: (m: string) => logs.push(m),
        })
        // 重试成功，不该换名
        expect(result.control.name).toBe('ctl')
        expect(result.data.name).toBe('dat')
        expect(result.warnings).toEqual([])
      }
    )
    // 控制面与数据面各重试 3 次（其中前两次被拒）
    expect(attempts).toBeGreaterThanOrEqual(4)
    expect(logs.join('\n')).toContain('同名重试')
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
        // 读单个 Pages 项目（部署向导用来核对控制面 DATA_HOST 是否指向旧域名）
        if (req.method === 'GET' && url.includes('/pages/projects/')) {
          const name = /projects\/([^/?]+)/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: {
              success: true,
              result: {
                id: name,
                name,
                subdomain: `${name}.pages.dev`,
                production_branch: 'main',
                deployment_configs: {
                  production: { env_vars: { DATA_HOST: { value: `${name}.pages.dev` } } },
                },
              },
            },
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

        // 顺序校验：两个项目创建 → PATCH 配置 → 数据面部署 → 控制面部署
        const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pages/projects'))
        const patches = calls.filter((c) => c.method === 'PATCH')
        const deploys = calls.filter((c) => c.method === 'POST' && c.path.includes('/deployments'))
        expect(creates.length).toBe(2)
        // 3 次 PATCH：控制面 + 数据面 + **控制面 DATA_HOST 同步**
        // （mock 里控制面的 DATA_HOST 指向 ctl.pages.dev，与实际数据面 dat.pages.dev 不一致，
        //   触发同步 —— 这正是「数据面换名后必须重配控制面」的保护逻辑）
        expect(patches.length).toBe(3)
        expect(deploys.length).toBe(2)
        // 数据面必须先部署（控制面的 DATA_HOST 才有效）
        expect(deploys[0]!.path).toContain('/dat/deployments')
        expect(deploys[1]!.path).toContain('/ctl/deployments')
      }
    )
  })

  it('控制面 DATA_HOST 已指向当前数据面时，不重复配置控制面', async () => {
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
        // 控制面的 DATA_HOST 已经指向数据面（dat.pages.dev）→ 不该触发同步
        if (req.method === 'GET' && url.includes('/pages/projects/')) {
          const name = /projects\/([^/?]+)/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: {
              success: true,
              result: {
                id: name,
                name,
                subdomain: `${name}.pages.dev`,
                production_branch: 'main',
                deployment_configs: { production: { env_vars: { DATA_HOST: { value: 'dat.pages.dev' } } } },
              },
            },
          }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'unhandled ' + req.method + ' ' + url }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
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

        const patches = calls.filter((c) => c.method === 'PATCH')
        // 只有控制面 + 数据面各一次 —— DATA_HOST 已一致，不该多配一次控制面
        expect(patches.length).toBe(2)
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
        // 3 个候选名 × 每个 3 次重试都失败，两边各记一条 warning
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
          // 前 3 次（原项目名重试）封禁，之后换名成功
          if (deployCount <= 3) {
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
        // 读单个 Pages 项目（部署向导用来核对控制面 DATA_HOST 是否指向旧域名）
        if (req.method === 'GET' && url.includes('/pages/projects/')) {
          const name = /projects\/([^/?]+)/.exec(url)?.[1] ?? ''
          return {
            status: 200,
            body: {
              success: true,
              result: {
                id: name,
                name,
                subdomain: `${name}.pages.dev`,
                production_branch: 'main',
                deployment_configs: {
                  production: { env_vars: { DATA_HOST: { value: `${name}.pages.dev` } } },
                },
              },
            },
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

/**
 * 8000119 换名重建后的收尾。
 *
 * 1. **自定义域名自动迁移** —— 旧项目绑的域名迁到新项目，
 *    否则用户订阅里的地址全部失效（以前要用户手动迁移）。
 * 2. **删除旧项目** —— 否则每次更新都留一个孤立项目，账号下越积越多。
 *
 * 顺序要求：先迁域名、确认成功，再删旧项目 ——
 * 反序删会让域名在一段时间内指向不存在的项目。
 */
describe('8000119 换名后的域名迁移与旧项目清理', () => {
  /** 记录 mock 收到的请求，便于断言调用顺序 */
  interface Recorded {
    method: string
    url: string
    body?: string
  }

  /**
   * 构造一个「更新模式 + 旧项目有自定义域名 + 数据面换名成功」的场景。
   *
   * 关键 mock 行为：
   *   - KV 清单返回旧项目名 `dat-old`（带自定义域名 `cf.example.com`）
   *   - `dat-old` 的部署请求返回 8000119（模拟持久封禁）
   *   - 换名后的新项目部署成功
   */
  async function runScenario(options: {
    /** 域名迁移是否失败（模拟 API 报错） */
    domainFails?: boolean
    /** 旧项目是否绑了自定义域名 */
    hasDomain?: boolean
  }): Promise<{ calls: Recorded[]; warnings: string[] }> {
    const calls: Recorded[] = []
    const { hasDomain = true, domainFails = false } = options
    // 换名后的新项目名（由向导随机生成，这里从请求里抓）
    let newDataProject = ''

    let warnings: string[] = []
    await withMockServer(
      (req) => {
        const url = req.url
        calls.push({ method: req.method, url, body: req.body })

        // 建项目
        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return {
            status: 200,
            body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev`, domains: [`${name}.pages.dev`] } },
          }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }

        // KV：清单返回旧项目
        if (req.method === 'GET' && url.includes('/values/CFP_DEPLOY_MANIFEST')) {
          return {
            status: 200,
            body: JSON.stringify({
              v: 1,
              kvNamespaceId: 'ns-1',
              controlProject: 'ctl',
              dataProject: 'dat-old',
              controlSubdomain: 'ctl.pages.dev',
              dataSubdomain: 'dat-old.pages.dev',
              dataCustomDomain: hasDomain ? 'cf.example.com' : undefined,
              build: 'old',
              at: '2026-10-24T00:00:00.000Z',
              credentials: {
                panelPath: '/p-test',
                panelPassword: 'pw',
                uuid: 'u',
                trojanPassword: 'tp',
                wsPath: '/testpath12',
              },
            }),
            contentType: 'text/plain',
          }
        }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'not found' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }

        // 读项目：旧项目带自定义域名
        if (req.method === 'GET' && /pages\/projects\/[^/]+$/.test(url)) {
          const name = url.split('/').pop()!
          const domains = [`${name}.pages.dev`]
          if (name === 'dat-old' && hasDomain) domains.push('cf.example.com')
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev`, domains } } }
        }

        // 部署：旧数据面项目必被拒（8000119）；其余成功
        if (req.method === 'POST' && url.includes('/deployments')) {
          const project = url.split('/pages/projects/')[1]!.split('/')[0]!
          if (project === 'dat-old') {
            return {
              status: 400,
              body: { success: false, errors: [{ code: 8000119, message: 'Your Pages project has been blocked.' }] },
            }
          }
          if (project.startsWith('dat-') && project !== 'dat-old') newDataProject = project
          return {
            status: 200,
            body: { success: true, result: { id: `dep-${project}`, url: `https://${project}.pages.dev`, latest_stage: { name: 'deploy', status: 'success' } } },
          }
        }

        // 读部署状态
        if (req.method === 'GET' && url.includes('/deployments')) {
          return {
            status: 200,
            body: { success: true, result: [{ id: 'dep-x', latest_stage: { name: 'deploy', status: 'success' } }] },
          }
        }

        // 迁移域名：POST /pages/projects/<name>/domains
        if (req.method === 'POST' && url.includes('/domains')) {
          if (domainFails) {
            return { status: 400, body: { success: false, errors: [{ code: 8000015, message: 'domain already in use' }] } }
          }
          return { status: 200, body: { success: true, result: {} } }
        }

        // 删除项目
        if (req.method === 'DELETE' && url.includes('/pages/projects/')) {
          return { status: 200, body: { success: true, result: {} } }
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
          panelPath: '',
          panelPassword: '',
          uuid: '',
          trojanPassword: '',
          wsPath: '',
          enableTrojan: true,
          enableXhttp: false,
          wait: { timeoutMs: 3000, intervalMs: 10 },
          apiBase: base,
          bundles: { control: 'export default {}', data: 'export default {}' },
          log: () => {},
        })
        warnings = result.warnings
        // 暴露抓到的换名结果供断言
        ;(globalThis as Record<string, unknown>).__newDataProject = newDataProject
      }
    )
    return { calls, warnings }
  }

  it('换名成功后把旧项目的自定义域名迁到新项目', async () => {
    const { calls } = await runScenario({ hasDomain: true })
    const newName = (globalThis as Record<string, unknown>).__newDataProject as string
    expect(newName).toBeTruthy()
    // 必须有一次「给新项目加域名」的调用，且域名是 cf.example.com
    const addDomain = calls.find((c) => c.method === 'POST' && c.url.includes(`/projects/${newName}/domains`))
    expect(addDomain).toBeTruthy()
    expect(addDomain!.body ?? '').toContain('cf.example.com')
  })

  it('域名迁移成功后删除旧项目', async () => {
    const { calls } = await runScenario({ hasDomain: true })
    const deleted = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/projects/'))
    expect(deleted.map((c) => c.url.split('/').pop())).toContain('dat-old')
  })

  it('域名迁移顺序：旧项目解绑 → 新项目绑定 → 删旧项目', async () => {
    // ⚠️ 真机踩坑：Pages 的同一自定义域名同时只能挂一个项目，
    // 直接绑到新项目会报 `You have already added this custom domain`。
    // 因此必须先解绑旧项目。三步顺序都不能变。
    const { calls } = await runScenario({ hasDomain: true })
    const newName = (globalThis as Record<string, unknown>).__newDataProject as string

    const unbindIdx = calls.findIndex(
      (c) => c.method === 'DELETE' && c.url.includes('/projects/dat-old/domains/')
    )
    const bindIdx = calls.findIndex(
      (c) => c.method === 'POST' && c.url.includes(`/projects/${newName}/domains`)
    )
    const delIdx = calls.findIndex(
      (c) => c.method === 'DELETE' && c.url.includes('/projects/dat-old') && !c.url.includes('/domains/')
    )

    expect(unbindIdx).toBeGreaterThan(-1)
    expect(bindIdx).toBeGreaterThan(-1)
    expect(delIdx).toBeGreaterThan(-1)
    // 解绑必须在绑定之前，绑定必须在删项目之前
    expect(unbindIdx).toBeLessThan(bindIdx)
    expect(bindIdx).toBeLessThan(delIdx)
  })

  it('域名迁移失败时不删旧项目（旧项目还挂着唯一入口）', async () => {
    const { calls, warnings } = await runScenario({ hasDomain: true, domainFails: true })
    const deleted = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/projects/'))
    expect(deleted.map((c) => c.url.split('/').pop())).not.toContain('dat-old')
    // 且必须给出可操作的告警
    expect(warnings.some((w) => /域名迁移失败|手动.*改绑/.test(w))).toBe(true)
  })

  it('旧项目没绑自定义域名时直接删除，不发域名迁移请求', async () => {
    const { calls } = await runScenario({ hasDomain: false })
    const addDomain = calls.find((c) => c.method === 'POST' && c.url.includes('/domains'))
    expect(addDomain).toBeFalsy()
    const deleted = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/projects/'))
    expect(deleted.map((c) => c.url.split('/').pop())).toContain('dat-old')
  })
})

/**
 * 自定义域名读取：必须用 `/domains` 子接口。
 *
 * `GET /pages/projects/<name>` 的 `domains` 数组**只列 active 的域名** ——
 * 刚绑定的域名在 `initializing` 期间不在里面。
 *
 * 若换名重建恰好发生在这个窗口，用 `project.domains` 就会漏掉该域名
 * → 新项目没继承它 → 用户订阅地址失效。
 * 因此迁移读取必须以 `/domains` 子接口为准。
 */
describe('自定义域名读取以 /domains 子接口为准', () => {
  it('域名在 initializing（不在 project.domains）时仍能识别并迁移', async () => {
    let newDataProject = ''
    let sawDomainsSubroute = false

    await withMockServer(
      (req) => {
        const url = req.url

        if (req.method === 'POST' && url.endsWith('/pages/projects')) {
          const name = JSON.parse(req.body).name
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev`, domains: [`${name}.pages.dev`] } } }
        }
        if (req.method === 'PATCH') return { status: 200, body: { success: true, result: {} } }

        if (req.method === 'GET' && url.includes('/values/CFP_DEPLOY_MANIFEST')) {
          return {
            status: 200,
            body: JSON.stringify({
              v: 1,
              kvNamespaceId: 'ns-1',
              controlProject: 'ctl',
              dataProject: 'dat-old',
              controlSubdomain: 'ctl.pages.dev',
              dataSubdomain: 'dat-old.pages.dev',
              build: 'old',
              at: '2026-10-24T00:00:00.000Z',
              credentials: { panelPath: '/p-test', panelPassword: 'pw', uuid: 'u', trojanPassword: 'tp', wsPath: '/testpath12' },
            }),
            contentType: 'text/plain',
          }
        }
        if (req.method === 'GET' && url.includes('/values/')) {
          return { status: 404, body: { success: false, errors: [{ code: 1, message: 'nf' }] } }
        }
        if (req.method === 'PUT' && url.includes('/values/')) {
          return { status: 200, body: 'ok', contentType: 'text/plain' }
        }

        // 关键：/domains 子接口返回 initializing 的域名
        if (req.method === 'GET' && url.endsWith('/pages/projects/dat-old/domains')) {
          sawDomainsSubroute = true
          return {
            status: 200,
            body: { success: true, result: [{ name: 'dat-old.pages.dev' }, { name: 'pending.example.com', status: 'initializing' }] },
          }
        }

        // project.domains 故意只返回 pages.dev（模拟 initializing 不在列表里）
        if (req.method === 'GET' && /pages\/projects\/[^/]+$/.test(url)) {
          const name = url.split('/').pop()!
          return { status: 200, body: { success: true, result: { id: name, name, subdomain: `${name}.pages.dev`, domains: [`${name}.pages.dev`] } } }
        }

        if (req.method === 'POST' && url.includes('/deployments')) {
          const project = url.split('/pages/projects/')[1]!.split('/')[0]!
          if (project === 'dat-old') {
            return { status: 400, body: { success: false, errors: [{ code: 8000119, message: 'blocked' }] } }
          }
          if (project.startsWith('dat-') && project !== 'dat-old') newDataProject = project
          return { status: 200, body: { success: true, result: { id: `dep-${project}`, url: `https://${project}.pages.dev`, latest_stage: { name: 'deploy', status: 'success' } } } }
        }
        if (req.method === 'GET' && url.includes('/deployments')) {
          return { status: 200, body: { success: true, result: [{ id: 'd', latest_stage: { name: 'deploy', status: 'success' } }] } }
        }
        if (req.method === 'POST' && url.includes('/domains')) {
          return { status: 200, body: { success: true, result: {} } }
        }
        if (req.method === 'DELETE' && url.includes('/pages/projects/')) {
          return { status: 200, body: { success: true, result: {} } }
        }
        return { status: 404, body: { success: false, errors: [{ code: 1, message: 'x' }] } }
      },
      async (base) => {
        const { deployPagesSplit } = await import('../src/pages-deploy')
        await deployPagesSplit({
          token: 't',
          accountId: 'acc',
          kvNamespaceId: 'ns-1',
          controlProject: 'ctl',
          dataProject: 'dat',
          panelPath: '',
          panelPassword: '',
          uuid: '',
          trojanPassword: '',
          wsPath: '',
          enableTrojan: true,
          enableXhttp: false,
          wait: { timeoutMs: 3000, intervalMs: 10 },
          apiBase: base,
          bundles: { control: 'export default {}', data: 'export default {}' },
          log: () => {},
        })
      }
    )

    expect(sawDomainsSubroute).toBe(true)
    expect(newDataProject).toBeTruthy()
  })
})
