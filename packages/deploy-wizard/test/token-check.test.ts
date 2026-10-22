import { describe, expect, it } from 'vitest'
import { checkTokenPermissions, renderPermissionTable, renderTokenCheck } from '../src/token-check'
import {
  cfError,
  withMockServer,
  type MockHandler,
  type MockResponse,
} from './mock-server'

const ok = (result: unknown): MockResponse => ({ status: 200, body: { success: true, result } })

/** 一个「权限齐全」的 Cloudflare API 模拟服务 */
const fullPermissionHandler: MockHandler = (request) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname.replace(/^\/client\/v4/, '')
  const method = request.method

  if (method === 'GET' && path === '/accounts') {
    return ok([{ id: 'acc-1', name: '测试账号' }])
  }
  if (method === 'GET' && path === '/user/tokens/verify') {
    return ok({ id: 'tok-1', status: 'active' })
  }
  if (method === 'GET' && path === '/zones') {
    return ok([{ id: 'zone-1', name: 'example.com', status: 'active' }])
  }
  if (method === 'GET' && path === '/accounts/acc-1/storage/kv/namespaces') {
    return ok([{ id: 'kv-1', title: 'demo-kv' }])
  }
  if (method === 'GET' && path === '/accounts/acc-1/workers/scripts') {
    return ok(['existing-worker'])
  }
  if (method === 'GET' && path === '/accounts/acc-1/workers/subdomain') {
    return ok({ subdomain: 'demo-sub' })
  }
  if (
    method === 'GET' &&
    /^\/accounts\/acc-1\/workers\/scripts\/[^/]+\/subdomain$/.test(path)
  ) {
    // 探测用的随机脚本一定不存在：404 说明有权限
    return cfError(404, 'workers.api.error.script_not_found', 10007)
  }
  if (method === 'GET' && path === '/zones/zone-1/dns_records') {
    return ok([])
  }
  if (method === 'GET' && path === '/zones/zone-1/workers/routes') {
    return ok([])
  }
  if (method === 'GET' && path === '/accounts/acc-1/pages/projects') {
    return ok([])
  }
  return cfError(404, `测试未模拟的接口：${method} ${path}`, 7000)
}

describe('checkTokenPermissions', () => {
  it('权限齐全时全部通过', async () => {
    await withMockServer(fullPermissionHandler, async (base) => {
      const result = await checkTokenPermissions({ token: 'abc', apiBase: base })
      expect(result.ok).toBe(true)
      expect(result.missing).toBe(0)
      expect(result.accountName).toBe('测试账号')
      expect(result.accountId).toBe('acc-1')
      expect(result.zoneName).toBe('example.com')
      expect(result.rows).toHaveLength(10)
      expect(result.rows.every((row) => row.status === 'ok')).toBe(true)
      expect(result.rows.map((row) => row.name)).toEqual([
        '账号读取',
        'Token 元信息',
        '域名列表（Zone）',
        'Workers KV Storage',
        'Workers 脚本',
        'workers.dev 子域读取',
        'workers.dev 路由开关',
        'Pages 项目',
        'DNS 记录',
        'Worker Routes',
      ])
      // Pages 是 pages-split 的必需项
      const pages = result.rows.find((row) => row.name === 'Pages 项目')!
      expect(pages.required).toBe(true)
      expect(pages.hint).toContain('Developer Platform / Pages / Edit')
    })
  })

  it('缺 DNS / Routes 权限时标记为缺失，但未要求自定义域名时整体仍通过', async () => {
    const handler: MockHandler = (request) => {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname.startsWith('/client/v4/zones/zone-1/')) {
        return cfError(403, 'No access to the specified resource.', 10000)
      }
      return fullPermissionHandler(request)
    }
    await withMockServer(handler, async (base) => {
      const result = await checkTokenPermissions({ token: 'abc', apiBase: base })
      expect(result.ok).toBe(true)
      const dns = result.rows.find((row) => row.name === 'DNS 记录')!
      const routes = result.rows.find((row) => row.name === 'Worker Routes')!
      expect(dns.status).toBe('missing')
      expect(dns.required).toBe(false)
      expect(dns.detail).toContain('403')
      expect(routes.status).toBe('missing')
      expect(routes.hint).toContain('Zone / Workers Routes / Edit')
    })
  })

  it('要求自定义域名时，DNS / Routes 缺失会导致预检失败', async () => {
    const handler: MockHandler = (request) => {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname.startsWith('/client/v4/zones/zone-1/')) {
        return cfError(403, 'No access to the specified resource.', 10000)
      }
      return fullPermissionHandler(request)
    }
    await withMockServer(handler, async (base) => {
      const result = await checkTokenPermissions({
        token: 'abc',
        apiBase: base,
        zoneName: 'example.com',
        expectCustomDomain: true,
      })
      expect(result.ok).toBe(false)
      expect(result.missing).toBe(2)
      const dns = result.rows.find((row) => row.name === 'DNS 记录')!
      expect(dns.required).toBe(true)
      expect(dns.status).toBe('missing')
      const text = renderTokenCheck(result)
      expect(text).toContain('❌ 2 项必需权限未通过')
      expect(text).toContain('Zone / DNS / Edit')
      expect(text).toContain('Zone / Workers Routes / Edit')
    })
  })

  it('账号读取失败时立即返回，不继续探测', async () => {
    let requestCount = 0
    await withMockServer(
      () => {
        requestCount++
        return cfError(403, 'Invalid API Token', 10000)
      },
      async (base) => {
        const result = await checkTokenPermissions({ token: 'bad', apiBase: base })
        expect(result.ok).toBe(false)
        expect(result.missing).toBe(1)
        expect(result.rows).toHaveLength(1)
        expect(result.rows[0]!.name).toBe('账号读取')
        expect(result.rows[0]!.status).toBe('missing')
        expect(requestCount).toBe(1)
      }
    )
  })

  it('账号下没有域名时，DNS / Routes 标记为未知', async () => {
    const handler: MockHandler = (request) => {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === '/client/v4/zones') return ok([])
      return fullPermissionHandler(request)
    }
    await withMockServer(handler, async (base) => {
      const result = await checkTokenPermissions({
        token: 'abc',
        apiBase: base,
        expectCustomDomain: true,
      })
      expect(result.ok).toBe(false)
      const zoneRow = result.rows.find((row) => row.name === '域名列表（Zone）')!
      const dns = result.rows.find((row) => row.name === 'DNS 记录')!
      const routes = result.rows.find((row) => row.name === 'Worker Routes')!
      expect(zoneRow.status).toBe('missing')
      expect(dns.status).toBe('unknown')
      expect(routes.status).toBe('unknown')
      expect(dns.detail).toContain('没有可用域名')
    })
  })

  it('workers.dev 路由探测遇到 403 时标记缺失', async () => {
    const handler: MockHandler = (request) => {
      const url = new URL(request.url, 'http://localhost')
      if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(url.pathname)) {
        return cfError(403, 'No access to the specified resource.', 10000)
      }
      return fullPermissionHandler(request)
    }
    await withMockServer(handler, async (base) => {
      const result = await checkTokenPermissions({ token: 'abc', apiBase: base })
      expect(result.ok).toBe(false)
      const row = result.rows.find((item) => item.name === 'workers.dev 路由开关')!
      expect(row.status).toBe('missing')
      expect(row.consequence).toContain('There is nothing here yet')
    })
  })

  it('指定的账号不存在时抛出可读错误', async () => {
    await withMockServer(fullPermissionHandler, async (base) => {
      await expect(
        checkTokenPermissions({ token: 'abc', apiBase: base, accountId: 'acc-404' })
      ).rejects.toThrowError(/不在该 Token 可见的账号列表中/)
    })
  })
})

describe('权限表格渲染', () => {
  it('输出三列表头与三种状态', () => {
    const table = renderPermissionTable([
      {
        name: '账号读取',
        required: true,
        status: 'ok',
        consequence: '无法部署',
        detail: '共 1 个账号',
        hint: 'x',
      },
      {
        name: 'DNS 记录',
        required: false,
        status: 'missing',
        consequence: '无法创建 CNAME',
        detail: 'HTTP 403',
        hint: 'Zone / DNS / Edit',
      },
      {
        name: 'Worker Routes',
        required: false,
        status: 'unknown',
        consequence: '无法回退',
        detail: '网络错误',
        hint: 'Zone / Workers Routes / Edit',
      },
    ])
    expect(table).toContain('权限项')
    expect(table).toContain('状态')
    expect(table).toContain('缺失后果')
    expect(table).toContain('✅ 通过')
    expect(table).toContain('❌ 缺失')
    expect(table).toContain('❓ 未知')
    expect(table).toContain('账号读取（必需）')
    expect(table).toContain('DNS 记录（可选）')
  })
})
