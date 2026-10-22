import { describe, expect, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import {
  checkUrlAccess,
  describeFetchError,
  describeHttpStatus,
  panelAccessUrl,
} from '../src/access-check'

interface TestServer {
  baseUrl: string
  close: () => Promise<void>
}

/** 启动一个本地 HTTP 服务，count 从 1 开始递增 */
async function startServer(
  handler: (response: ServerResponse, count: number) => void
): Promise<TestServer> {
  let count = 0
  const server = createServer((_request, response) => {
    count++
    handler(response, count)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      // 先注册监听再关闭：closeAllConnections() 可能让 'close' 提前触发，
      // 之后再注册 once('close') 会永远等不到（测试挂起）。
      const closed = once(server, 'close')
      server.closeAllConnections?.()
      server.close()
      await closed
    },
  }
}

describe('checkUrlAccess', () => {
  it('2xx 判定为可访问', async () => {
    const server = await startServer((response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>ok</html>')
    })
    try {
      const result = await checkUrlAccess(`${server.baseUrl}/p-abc`, { attempts: 1 })
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.attempts).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('522 判定为不可访问且给出人话原因', async () => {
    const server = await startServer((response) => {
      response.writeHead(522, { 'Content-Type': 'text/html' })
      response.end('origin unreachable')
    })
    try {
      const result = await checkUrlAccess(`${server.baseUrl}/p-abc`, { attempts: 1 })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(522)
      expect(result.detail).toContain('522')
      expect(result.detail).toContain('未生效')
    } finally {
      await server.close()
    }
  })

  it('首次 500、重试后 200 时返回成功', async () => {
    const server = await startServer((response, count) => {
      if (count === 1) {
        response.writeHead(500)
        response.end('boom')
        return
      }
      response.writeHead(200)
      response.end('ok')
    })
    try {
      const result = await checkUrlAccess(`${server.baseUrl}/p-abc`, {
        attempts: 3,
        intervalMs: 10,
        timeoutMs: 2000,
      })
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.attempts).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('请求超时判定为不可访问', async () => {
    const server = await startServer(() => {
      // 永不响应，等待客户端超时
    })
    try {
      const result = await checkUrlAccess(`${server.baseUrl}/p-abc`, {
        attempts: 1,
        timeoutMs: 120,
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(0)
      expect(result.detail).toContain('超时')
    } finally {
      await server.close()
    }
  })
})

describe('access-check 工具函数', () => {
  it('panelAccessUrl 会补齐前导斜杠并拼上 https', () => {
    expect(panelAccessUrl('cf.example.com', '/p-abc')).toBe('https://cf.example.com/p-abc')
    expect(panelAccessUrl('cf.example.com', 'p-abc')).toBe('https://cf.example.com/p-abc')
  })

  it('describeHttpStatus / describeFetchError 输出中文原因', () => {
    expect(describeHttpStatus(522)).toContain('522')
    expect(describeHttpStatus(530)).toContain('CNAME')
    expect(describeHttpStatus(418)).toBe('HTTP 418')
    expect(describeFetchError(new Error('socket hang up'))).toContain('socket hang up')
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    expect(describeFetchError(timeout)).toContain('超时')
  })
})
