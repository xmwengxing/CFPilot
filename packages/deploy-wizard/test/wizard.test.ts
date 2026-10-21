/**
 * 部署向导主流程集成测试
 *
 * 用 vi.stubGlobal('fetch') 模拟 Cloudflare API 与面板地址，
 * 覆盖工作项的几条关键路径：
 *   - 上传后开启 workers.dev 子域与 Workers Logs
 *   - 自定义域名访问校验通过
 *   - 自定义域名 522 时自动降级 Route + CNAME
 *   - 全部失败时降级 workers.dev
 *   - --dry-run 不产生写请求
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deploy, type DeployResult } from '../src/wizard'

interface FetchCall {
  method: string
  url: string
  body: unknown
  isFormData: boolean
}

type Router = (call: FetchCall) => Response | Promise<Response>

function json(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function cfError(status: number, message: string, code = 10000): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function panelPage(): Response {
  return new Response('<html>CFPilot 面板</html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

interface RouterHooks {
  /** 自定义域名面板访问（返回 522 等） */
  customHost?: () => Response
  /** workers.dev 面板访问 */
  workersDevHost?: () => Response
}

/** 一个覆盖部署全流程的 Cloudflare API 模拟路由 */
function cloudflareRouter(hooks: RouterHooks = {}): Router {
  return (call) => {
    const url = new URL(call.url)

    // 面板真实访问校验（不是 api.cloudflare.com）
    if (url.hostname !== 'api.cloudflare.com') {
      if (url.hostname.endsWith('.workers.dev')) {
        return hooks.workersDevHost?.() ?? panelPage()
      }
      return hooks.customHost?.() ?? panelPage()
    }

    const path = url.pathname
    if (call.method === 'GET' && path === '/client/v4/accounts') {
      return json([{ id: 'acc-1', name: '测试账号' }])
    }
    if (call.method === 'GET' && path === '/client/v4/user/tokens/verify') {
      return json({ id: 'tok-1', status: 'active' })
    }
    if (call.method === 'GET' && path === '/client/v4/zones') {
      return json([{ id: 'zone-1', name: 'example.com', status: 'active' }])
    }
    if (
      call.method === 'POST' &&
      path === '/client/v4/accounts/acc-1/storage/kv/namespaces'
    ) {
      return json({ id: 'kv-1', title: 'demo-kv' })
    }
    if (call.method === 'GET' && path === '/client/v4/accounts/acc-1/workers/subdomain') {
      return json({ subdomain: 'demo' })
    }
    if (
      call.method === 'PUT' &&
      path.startsWith('/client/v4/accounts/acc-1/workers/scripts/')
    ) {
      return json({})
    }
    if (call.method === 'POST' && path.endsWith('/subdomain')) {
      return json({ enabled: true })
    }
    if (call.method === 'GET' && path.endsWith('/subdomain')) {
      return json({ enabled: true })
    }
    if (call.method === 'PATCH' && path.endsWith('/settings')) {
      return json({})
    }
    if (call.method === 'PUT' && path === '/client/v4/accounts/acc-1/workers/domains') {
      return json({
        id: 'domain-1',
        hostname: 'cf.example.com',
        service: 'demo',
        enabled: true,
      })
    }
    if (
      call.method === 'DELETE' &&
      path.startsWith('/client/v4/accounts/acc-1/workers/domains/')
    ) {
      return json({ id: 'domain-1' })
    }
    if (call.method === 'GET' && path === '/client/v4/zones/zone-1/dns_records') {
      return json([])
    }
    if (call.method === 'POST' && path === '/client/v4/zones/zone-1/dns_records') {
      return json({
        id: 'record-1',
        type: 'CNAME',
        name: 'cf.example.com',
        content: 'demo.demo.workers.dev',
        proxied: true,
      })
    }
    if (call.method === 'GET' && path === '/client/v4/zones/zone-1/workers/routes') {
      return json([])
    }
    if (call.method === 'POST' && path === '/client/v4/zones/zone-1/workers/routes') {
      return json({ id: 'route-1', pattern: 'cf.example.com/*', script: 'demo' })
    }
    return cfError(404, `测试未模拟的接口：${call.method} ${path}`, 7000)
  }
}

function stubFetch(router: Router): FetchCall[] {
  const calls: FetchCall[] = []
  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = undefined
    let isFormData = false
    if (init?.body instanceof FormData) {
      isFormData = true
    } else if (typeof init?.body === 'string') {
      body = init.body
      try {
        body = JSON.parse(init.body)
      } catch {
        /* 保持原始字符串 */
      }
    }
    const call: FetchCall = { method, url, body, isFormData }
    calls.push(call)
    return await router(call)
  }
  vi.stubGlobal('fetch', fakeFetch)
  return calls
}

function captureStdout(): string[] {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write')
  spy.mockImplementation(
    ((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as unknown as typeof process.stdout.write
  )
  return chunks
}

const FAST_ACCESS_CHECK = { attempts: 1, intervalMs: 0, timeoutMs: 1000 }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('deploy 主流程', () => {
  it('上传后开启 workers.dev 子域与 Workers Logs，自定义域名校验通过', async () => {
    const output = captureStdout()
    const calls = stubFetch(cloudflareRouter())
    const result: DeployResult = await deploy({
      token: 'demo-token',
      yes: true,
      hostname: 'cf.example.com',
      zoneName: 'example.com',
      accessCheckOptions: FAST_ACCESS_CHECK,
    })

    expect(result.mode).toBe('custom-domain')
    expect(result.workersDevEnabled).toBe(true)
    expect(result.observabilityEnabled).toBe(true)
    expect(result.scannerHost).toBe('cf.example.com')
    expect(result.url).toContain('https://cf.example.com/p-')
    expect(result.warnings).toHaveLength(0)

    // 上传后必须显式开启 workers.dev 子域（POST），否则会显示 "There is nothing here yet"
    const subdomainCall = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/subdomain')
    )
    expect(subdomainCall).toBeDefined()
    expect(subdomainCall?.body).toEqual({ enabled: true })

    // Workers Logs 必须走 multipart
    const settingsCall = calls.find(
      (call) => call.method === 'PATCH' && call.url.endsWith('/settings')
    )
    expect(settingsCall).toBeDefined()
    expect(settingsCall?.isFormData).toBe(true)

    // 绑定自定义域名 + 真实访问校验
    expect(
      calls.some((call) => call.method === 'PUT' && call.url.endsWith('/workers/domains'))
    ).toBe(true)
    expect(calls.some((call) => call.url === 'https://cf.example.com' + result.panelPath)).toBe(
      true
    )

    const text = output.join('')
    expect(text).toContain('已开启 workers.dev 子域路由')
    expect(text).toContain('已开启 Workers Logs')
    expect(text).toContain('自定义域名访问正常')
  })

  it('自定义域名绑定成功但访问 522 时，自动降级 Route + CNAME 并复检通过', async () => {
    const output = captureStdout()
    let customChecks = 0
    const calls = stubFetch(
      cloudflareRouter({
        customHost: () => {
          customChecks++
          return customChecks === 1 ? cfError(522, 'origin unreachable') : panelPage()
        },
      })
    )
    const result = await deploy({
      token: 'demo-token',
      yes: true,
      hostname: 'cf.example.com',
      zoneName: 'example.com',
      accessCheckOptions: FAST_ACCESS_CHECK,
    })

    expect(result.mode).toBe('custom-domain')
    expect(
      calls.some(
        (call) => call.method === 'DELETE' && call.url.includes('/workers/domains/domain-1')
      )
    ).toBe(true)
    expect(
      calls.some((call) => call.method === 'POST' && call.url.endsWith('/dns_records'))
    ).toBe(true)
    expect(
      calls.some((call) => call.method === 'POST' && call.url.endsWith('/workers/routes'))
    ).toBe(true)
    expect(result.warnings.join('\n')).toContain('自定义域名绑定成功但访问失败')

    const text = output.join('')
    expect(text).toContain('正在自动降级为 Route + CNAME 方案')
    expect(text).toContain('Route + CNAME 生效')
  })

  it('Route + CNAME 仍不可访问时降级 workers.dev', async () => {
    const output = captureStdout()
    const calls = stubFetch(
      cloudflareRouter({
        customHost: () => cfError(522, 'origin unreachable'),
        workersDevHost: () => panelPage(),
      })
    )
    const result = await deploy({
      token: 'demo-token',
      yes: true,
      hostname: 'cf.example.com',
      zoneName: 'example.com',
      accessCheckOptions: FAST_ACCESS_CHECK,
    })

    expect(result.mode).toBe('workers.dev')
    expect(result.scannerHost).toMatch(/^[a-z][a-z0-9]{7,9}\.demo\.workers\.dev$/)
    expect(result.url).toContain(result.scannerHost)
    expect(result.warnings.join('\n')).toContain('Route + CNAME 已创建但访问仍失败')
    expect(result.warnings.join('\n')).toContain('已降级为 workers.dev')
    // 降级后仍要校验 workers.dev 可达性
    expect(calls.some((call) => call.url.startsWith(`https://${result.scannerHost}`))).toBe(true)
    expect(output.join('')).toContain('workers.dev 地址访问正常')
  })

  it('--dry-run 不产生任何写请求', async () => {
    captureStdout()
    const calls = stubFetch(cloudflareRouter())
    const result = await deploy({
      token: 'demo-token',
      yes: true,
      hostname: 'cf.example.com',
      zoneName: 'example.com',
      dryRun: true,
    })

    expect(result.kvId).toBe('dry-run-namespace-id')
    expect(result.workersDevEnabled).toBe(false)
    expect(result.observabilityEnabled).toBe(false)
    const writes = calls.filter((call) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method))
    expect(writes).toHaveLength(0)
  })
})
