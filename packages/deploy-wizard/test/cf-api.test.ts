import { describe, expect, it } from 'vitest'
import { CloudflareClient, CloudflareError } from '../src/cf-api'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

interface MockResponse {
  status: number
  body: unknown
  contentType?: string
}

async function withMockServer(
  handler: (url: URL, req: import('node:http').IncomingMessage) => MockResponse,
  fn: (base: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const result = handler(url, req)
      res.writeHead(result.status, { 'Content-Type': result.contentType ?? 'application/json' })
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await fn(`http://127.0.0.1:${port}/client/v4`)
  } finally {
    // 先注册监听再关闭：否则 'close' 可能已触发，once 会永远等不到
    const closed = once(server, 'close')
    server.close()
    await closed
  }
}

describe('CloudflareClient', () => {
  const uploadOptions = {
    mainModule: 'worker.js',
    code: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-01-01',
    bindings: [],
  }

  for (const operation of ['json', 'settings', 'upload'] as const) {
    it(`${operation} 不得把 HTTP 200 的 API 失败当成成功`, async () => {
      await withMockServer(
        () => ({
          status: 200,
          body: { success: false, errors: [{ code: 8000119, message: 'Project blocked' }] },
        }),
        async (base) => {
          const client = new CloudflareClient({ token: 'abc', apiBase: base })
          const action = operation === 'json'
            ? client.listAccounts()
            : operation === 'settings'
              ? client.patchScriptSettings('acc', 'demo', { observability: { enabled: true } })
              : client.uploadScript('acc', 'demo', uploadOptions)
          await expect(action).rejects.toMatchObject({
            name: 'CloudflareError', status: 200, code: 8000119, message: 'Project blocked',
          })
        }
      )
    })

    it(`${operation} 拒绝 HTTP 200 的非 JSON 响应`, async () => {
      await withMockServer(
        () => ({ status: 200, body: '<html>upstream error</html>' }),
        async (base) => {
          const client = new CloudflareClient({ token: 'abc', apiBase: base })
          const action = operation === 'json'
            ? client.listAccounts()
            : operation === 'settings'
              ? client.patchScriptSettings('acc', 'demo', {})
              : client.uploadScript('acc', 'demo', uploadOptions)
          await expect(action).rejects.toBeInstanceOf(CloudflareError)
        }
      )
    })
  }

  it('解析成功响应中的 result', async () => {
    await withMockServer(
      () => ({ status: 200, body: { success: true, result: { id: 'tok', status: 'active' } } }),
      async (base) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        const verify = await client.verifyToken()
        expect(verify.status).toBe('active')
      }
    )
  })

  it('错误响应抛出 CloudflareError 并带上错误信息', async () => {
    await withMockServer(
      () => ({
        status: 403,
        body: { success: false, errors: [{ code: 10000, message: 'Invalid API Token' }] },
      }),
      async (base) => {
        const client = new CloudflareClient({ token: 'bad', apiBase: base })
        await expect(client.verifyToken()).rejects.toThrowError(CloudflareError)
        await expect(client.verifyToken()).rejects.toThrowError(/Invalid API Token/)
      }
    )
  })

  it('创建 KV 命名空间时提交 title', async () => {
    await withMockServer(
      (_url, req) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          void body
        })
        return { status: 200, body: { success: true, result: { id: 'ns-id', title: 'demo-kv' } } }
      },
      async (base) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        const ns = await client.createKvNamespace('acc', 'demo-kv')
        expect(ns.id).toBe('ns-id')
        expect(ns.title).toBe('demo-kv')
      }
    )
  })

  it('上传脚本使用 multipart 且带上 metadata 段', async () => {
    let contentType = ''
    let body = ''
    await withMockServer(
      (_url, req) => {
        contentType = req.headers['content-type'] ?? ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          void body
        })
        return { status: 200, body: { success: true, result: {} } }
      },
      async (base) => {
        const client = new CloudflareClient({ token: 'abc', apiBase: base })
        await client.uploadScript('acc', 'cfpilot-x', {
          mainModule: 'worker.js',
          code: 'export default { fetch(){ return new Response("ok") } }',
          compatibilityDate: '2026-01-01',
          bindings: [
            { type: 'kv_namespace', name: 'KV', namespace_id: 'ns' },
            { type: 'plain_text', name: 'PANEL_PASSWORD', text: 'secret' },
          ],
        })
        expect(contentType).toContain('multipart/form-data')
        expect(body).toContain('name="metadata"')
        expect(body).toContain('name="worker.js"')
        expect(body).toContain('main_module')
        expect(body).toContain('kv_namespace')
      }
    )
  })
})
