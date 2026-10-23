/**
 * 最小探针：隔离验证 HTTPS 代理的 **TLS 模式**与 **证书校验行为**。
 *
 * 端点：GET /?host=..&port=..&mode=on|starttls
 *
 * ## 要验证的两件事
 *
 * 1. `connect(address, options)` 的 **options 是第二个参数** ——
 *    塞进第一个参数会被运行时静默忽略（表现为「TLS 没生效」）。
 * 2. `secureTransport:'on'`（Cloudflare 原生 TLS）与
 *    `secureTransport:'starttls'` + `startTls()`（机会式 TLS）
 *    对**自签证书**的处理差异。
 *
 * 探针只做「连上 + TLS 握手 + 读一个字节」，
 * 不发 CONNECT —— 这样能把「TLS 层」与「代理协议层」分开定位。
 */
import { connect } from 'cloudflare:sockets'

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const host = url.searchParams.get('host') ?? '47.104.173.139'
    const port = Number(url.searchParams.get('port') ?? 39082)
    const mode = url.searchParams.get('mode') ?? 'starttls'
    // 证书校验策略：''（不传）/ 'hostname'（传 expectedServerHostname）
    const validate = url.searchParams.get('validate') ?? ''

    const steps: string[] = []

    let socket: any
    try {
      // ✅ 正确写法：options 是**第二个**参数
      socket = connect({ hostname: host, port }, { secureTransport: mode } as any)
      steps.push(`connect({hostname,port},{secureTransport:'${mode}'}) → 返回 socket`)
    } catch (err) {
      steps.push(`connect 抛错：${err instanceof Error ? err.message : String(err)}`)
      return json({ ok: false, steps })
    }

    try {
      await Promise.race([
        socket.opened,
        new Promise((_, rej) => setTimeout(() => rej(new Error('opened 超时 8s')), 8000)),
      ])
      steps.push('socket.opened → TCP 建连成功')
    } catch (err) {
      steps.push(`opened 失败：${err instanceof Error ? err.message : String(err)}`)
      return json({ ok: false, steps })
    }

    steps.push(`socket.secureTransport = ${socket.secureTransport}`)

    // 'on' 模式：TLS 握手由运行时在连接时完成，直接用 socket
    // 'starttls' 模式：需要显式调用 startTls()
    let tlsSocket = socket
    if (mode === 'starttls') {
      if (typeof socket.startTls !== 'function') {
        steps.push('socket.startTls 不存在')
        return json({ ok: false, steps })
      }
      try {
        const opts = validate ? { expectedServerHostname: validate } : undefined
        tlsSocket = socket.startTls(opts)
        steps.push(`startTls(${opts ? JSON.stringify(opts) : '无参'}) → 返回新 socket`)
      } catch (err) {
        steps.push(`startTls 抛错：${err instanceof Error ? err.message : String(err)}`)
        return json({ ok: false, steps })
      }
      try {
        await Promise.race([
          tlsSocket.opened,
          new Promise((_, rej) => setTimeout(() => rej(new Error('secure.opened 超时 8s')), 8000)),
        ])
        steps.push('secure.opened → TLS 握手完成')
      } catch (err) {
        steps.push(`secure.opened 失败（TLS 握手被拒）：${err instanceof Error ? err.message : String(err)}`)
        return json({ ok: false, steps })
      }
    }

    // 读一点数据：TLS 成功时对端（TLS 服务器）等我们说话，不会主动发。
    // 这里改为写一个 TLS Alert 前无意义，所以用「写一个字节看是否被接受」判断 TLS 层是否正常。
    try {
      const w = tlsSocket.writable.getWriter()
      await w.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
      steps.push('向 TLS socket 写入明文 → 成功（说明已是 TLS 通道）')
      w.releaseLock()
    } catch (err) {
      steps.push(`向 TLS socket 写入失败：${err instanceof Error ? err.message : String(err)}`)
      return json({ ok: false, steps })
    }

    // 读响应
    try {
      const r = tlsSocket.readable.getReader()
      let text = ''
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        const chunk: any = await Promise.race([
          r.read(),
          new Promise((res) => setTimeout(() => res({ value: null }), 2000)),
        ])
        if (chunk?.value) {
          text += new TextDecoder().decode(chunk.value)
          break
        }
        if (chunk?.done) break
      }
      steps.push(`读到 ${text.length} 字节：${text.slice(0, 120).replace(/\r?\n/g, ' | ')}`)
    } catch (err) {
      steps.push(`读取失败：${err instanceof Error ? err.message : String(err)}`)
    }

    return json({ ok: true, steps })
  },
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
