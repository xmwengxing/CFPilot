/**
 * 本地明文 HTTP 回显服务器 —— 作为自研数据面的**出站目标**。
 *
 * ## 为什么需要它
 *
 * VLESS over WebSocket 是 TLS 透传代理：TLS 由客户端与目标站直接完成，
 * Worker 只搬字节（见 docs/self-developed-dataplane-design.md §1.4d）。
 * 因此验证出站链路时，**不能**用「明文 HTTP 去请求 HTTPS 站」——
 * 那样必然拿不到响应，会误判成实现缺陷。
 *
 * 用一个明文 HTTP 目标站，才能真正验证：
 *   VLESS 握手 → 协议解析 → 出站建连 → 请求转发 → 响应回传
 * 这一整条链路是否走通。
 *
 * 端点：
 *   GET /echo?x=1   → 回显请求的 method / path / query / body
 *   GET /slow?ms=N  → 延迟 N 毫秒后返回（用于测首包与超时）
 *   GET /bytes?n=N  → 返回 N 字节可预测内容（用于验证数据完整性）
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.ECHO_PORT || 18080)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  // 允许跨源，方便浏览器/脚本访问
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === '/echo') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: {
            host: req.headers.host ?? null,
            'user-agent': req.headers['user-agent'] ?? null,
            'x-forwarded-for': req.headers['x-forwarded-for'] ?? null,
          },
          body,
          echo: 'CF-PILOT-ECHO-OK',
        })
      )
    })
    return
  }

  if (url.pathname === '/slow') {
    const ms = Number(url.searchParams.get('ms') ?? 500)
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`slow-ok-${ms}`)
    }, ms)
    return
  }

  if (url.pathname === '/bytes') {
    const n = Number(url.searchParams.get('n') ?? 1024)
    // 可预测内容：0x00..0xFF 循环
    const buf = Buffer.alloc(n)
    for (let i = 0; i < n; i++) buf[i] = i & 0xff
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(n),
    })
    res.end(buf)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[echo] 明文 HTTP 回显服务器已启动: http://127.0.0.1:${PORT}\n`)
  process.stdout.write(`[echo] 端点: /echo?x=1  /slow?ms=500  /bytes?n=1024\n`)
})
