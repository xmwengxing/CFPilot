/**
 * 测试用的本地 Cloudflare API 模拟服务
 *
 * 只用于单元测试：启动一个 127.0.0.1 的随机端口 HTTP 服务，
 * 把收到的请求完整记录下来再交给 handler 决定响应。
 */
import { createServer } from 'node:http'
import { once } from 'node:events'

export interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface MockResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type MockHandler = (request: CapturedRequest) => MockResponse

function toResponseBody(body: unknown): string {
  if (typeof body === 'string') return body
  return JSON.stringify(body)
}

/** 启动模拟服务，执行 fn 后自动关闭；base 形如 http://127.0.0.1:<port>/client/v4 */
export async function withMockServer(
  handler: MockHandler,
  fn: (base: string, requests: CapturedRequest[]) => Promise<void>
): Promise<void> {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(captured)
      const result = handler(captured)
      response.writeHead(result.status, {
        'Content-Type': 'application/json',
        ...(result.headers ?? {}),
      })
      response.end(toResponseBody(result.body))
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await fn(`http://127.0.0.1:${port}/client/v4`, requests)
  } finally {
    // 关闭顺序有讲究：
    //   closeAllConnections() 会让服务端强制断开，'close' 事件可能在
    //   close() 之前就触发。若此时才注册 once('close')，就会永远等不到
    //   而挂起（表现为测试超时失败，且只在部分平台/时序下出现）。
    //   因此先注册监听，再关闭。
    const closed = once(server, 'close')
    server.closeAllConnections?.()
    server.close()
    await closed
  }
}

/** 取请求头的单值形式 */
export function headerValue(request: CapturedRequest, name: string): string {
  const value = request.headers[name]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/** Cloudflare 风格的错误响应 */
export function cfError(status: number, message: string, code = 10000): MockResponse {
  return { status, body: { success: false, errors: [{ code, message }] } }
}
