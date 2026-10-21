import { describe, expect, it } from 'vitest'
import { CloudflareClient, CloudflareError } from '../src/cf-api'
import {
  cfError,
  headerValue,
  withMockServer,
  type CapturedRequest,
  type MockHandler,
  type MockResponse,
} from './mock-server'

const ok = (result: unknown): MockResponse => ({ status: 200, body: { success: true, result } })

describe('CloudflareClient：workers.dev 子域', () => {
  it('查询子域开关使用 GET .../subdomain', async () => {
    await withMockServer(
      () => ok({ enabled: true }),
      async (base, requests) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        const state = await client.getScriptSubdomain('acc', 'demo-worker')
        expect(state.enabled).toBe(true)
        expect(requests).toHaveLength(1)
        expect(requests[0]!.method).toBe('GET')
        expect(requests[0]!.url).toBe(
          '/client/v4/accounts/acc/workers/scripts/demo-worker/subdomain'
        )
      }
    )
  })

  it('开启子域路由使用 POST + JSON {"enabled":true}', async () => {
    await withMockServer(
      () => ok({ enabled: true }),
      async (base, requests) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        await client.putScriptSubdomain('acc', 'demo-worker', true)
        const request = requests[0]!
        expect(request.method).toBe('POST')
        expect(request.url).toBe('/client/v4/accounts/acc/workers/scripts/demo-worker/subdomain')
        expect(headerValue(request, 'content-type')).toContain('application/json')
        expect(JSON.parse(request.body)).toEqual({ enabled: true })
      }
    )
  })

  it('脚本不存在时抛出 404 + 错误码 10007', async () => {
    await withMockServer(
      () => cfError(404, 'workers.api.error.script_not_found', 10007),
      async (base) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        await expect(client.getScriptSubdomain('acc', 'not-exist')).rejects.toMatchObject({
          status: 404,
          code: 10007,
        })
      }
    )
  })
})

describe('CloudflareClient：脚本设置', () => {
  it('PATCH settings 必须使用 multipart/form-data 且字段名为 settings', async () => {
    await withMockServer(
      () => ok({}),
      async (base, requests) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        await client.patchScriptSettings('acc', 'demo-worker', {
          observability: { enabled: true, head_sampling_rate: 1 },
        })
        const request = requests[0]!
        expect(request.method).toBe('PATCH')
        expect(request.url).toBe('/client/v4/accounts/acc/workers/scripts/demo-worker/settings')
        expect(headerValue(request, 'content-type')).toContain('multipart/form-data')
        expect(headerValue(request, 'content-type')).toContain('boundary=')
        expect(request.body).toContain('name="settings"')
        expect(request.body).toContain('"observability"')
        expect(request.body).toContain('"head_sampling_rate":1')
      }
    )
  })
})

describe('CloudflareClient：DNS 记录', () => {
  it('查询时按名称过滤并携带分页参数，删除时走 DELETE', async () => {
    const handler: MockHandler = (request) => {
      if (request.method === 'DELETE') return ok({ id: 'rec-1' })
      return ok([
        { id: 'rec-1', type: 'A', name: 'cf.example.com', content: '1.2.3.4', proxied: true },
      ])
    }
    await withMockServer(handler, async (base, requests) => {
      const client = new CloudflareClient({ token: 'abc', apiBase: base })
      const records = await client.getDnsRecords('zone-1', 'cf.example.com')
      expect(records).toHaveLength(1)
      expect(records[0]!.content).toBe('1.2.3.4')

      await client.deleteDnsRecord('zone-1', 'rec-1')
      expect(requests[0]!.method).toBe('GET')
      expect(requests[0]!.url).toBe(
        '/client/v4/zones/zone-1/dns_records?per_page=100&name=cf.example.com'
      )
      expect(requests[1]!.method).toBe('DELETE')
      expect(requests[1]!.url).toBe('/client/v4/zones/zone-1/dns_records/rec-1')
    })
  })
})

describe('CloudflareClient：Routes 与自定义域名', () => {
  it('列出 / 创建 / 删除 Route', async () => {
    const handler: MockHandler = (request) => {
      if (request.method === 'GET') return ok([{ id: 'route-1', pattern: 'cf.example.com/*', script: 'w' }])
      if (request.method === 'DELETE') return ok({ id: 'route-1' })
      return ok({ id: 'route-2', pattern: 'api.example.com/*', script: 'w' })
    }
    await withMockServer(handler, async (base, requests) => {
      const client = new CloudflareClient({ token: 'abc', apiBase: base })
      const routes = await client.listRoutes('zone-1')
      expect(routes[0]!.pattern).toBe('cf.example.com/*')

      await client.createRoute('zone-1', { pattern: 'api.example.com/*', script: 'w' })
      expect(requests[1]!.method).toBe('POST')
      expect(JSON.parse(requests[1]!.body)).toEqual({ pattern: 'api.example.com/*', script: 'w' })

      await client.deleteRoute('zone-1', 'route-1')
      expect(requests[2]!.method).toBe('DELETE')
      expect(requests[2]!.url).toBe('/client/v4/zones/zone-1/workers/routes/route-1')
    })
  })

  it('绑定 / 查询 / 删除自定义域名', async () => {
    const domain = {
      id: 'domain-1',
      hostname: 'cf.example.com',
      service: 'w',
      zone_id: 'zone-1',
      enabled: true,
    }
    const handler: MockHandler = (request) => {
      if (request.method === 'PUT') return ok(domain)
      if (request.method === 'GET') return ok(domain)
      return ok({ id: 'domain-1' })
    }
    await withMockServer(handler, async (base, requests) => {
      const client = new CloudflareClient({ token: 'abc', apiBase: base })
      const attached = await client.attachCustomDomain('acc', {
        hostname: 'cf.example.com',
        service: 'w',
        zoneId: 'zone-1',
      })
      expect(attached.id).toBe('domain-1')
      expect(requests[0]!.method).toBe('PUT')
      expect(JSON.parse(requests[0]!.body)).toMatchObject({
        hostname: 'cf.example.com',
        service: 'w',
        zone_id: 'zone-1',
        environment: 'production',
      })

      const found = await client.getWorkerDomainById('acc', 'domain-1')
      expect(found.hostname).toBe('cf.example.com')
      expect(requests[1]!.url).toBe('/client/v4/accounts/acc/workers/domains/domain-1')

      await client.deleteWorkerDomain('acc', 'domain-1')
      expect(requests[2]!.method).toBe('DELETE')
      expect(requests[2]!.url).toBe('/client/v4/accounts/acc/workers/domains/domain-1')
    })
  })
})

describe('CloudflareClient：错误与空响应', () => {
  it('403 错误保留 HTTP 状态与错误码', async () => {
    await withMockServer(
      () => cfError(403, 'No access to the specified resource.', 10000),
      async (base) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        let caught: unknown
        try {
          await client.listRoutes('zone-1')
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(CloudflareError)
        expect((caught as CloudflareError).status).toBe(403)
        expect((caught as CloudflareError).message).toContain('No access')
      }
    )
  })

  it('DELETE 返回空 body 时不抛错', async () => {
    await withMockServer(
      () => ({ status: 200, body: '' }),
      async (base) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        await expect(client.deleteRoute('zone-1', 'route-1')).resolves.toBeUndefined()
      }
    )
  })

  it('上传脚本使用 multipart 且带 metadata 段', async () => {
    await withMockServer(
      () => ok({}),
      async (base, requests) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        await client.uploadScript('acc', 'w', {
          mainModule: 'worker.js',
          code: 'export default { fetch(){ return new Response("ok") } }',
          compatibilityDate: '2026-01-01',
          bindings: [{ type: 'plain_text', name: 'PANEL_PATH', text: '/p-x' }],
        })
        const request: CapturedRequest = requests[0]!
        expect(headerValue(request, 'content-type')).toContain('multipart/form-data')
        expect(request.body).toContain('name="metadata"')
        expect(request.body).toContain('name="worker.js"')
        expect(request.body).toContain('main_module')
        expect(request.body).toContain('PANEL_PATH')
      }
    )
  })
})
