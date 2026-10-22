/**
 * XHTTP（stream-one）入站处理
 *
 * Xray 的 XHTTP stream-one 模式下，客户端以一个 HTTP 请求承载上行数据：
 *   POST /<path> HTTP/1.1
 *   Content-Type: application/grpc
 *
 * 请求体首字节是 VLESS 协议头，其后是上行负载；
 * 服务端以 200 + 流式响应体返回下行数据。
 */
import type { UserConfig } from '../types'
import { ByteStream } from './stream'
import { parseVless, VLESS_COMMAND_TCP } from './vless'
import type { DialResult, ProxyEndpoint } from '../outbound/dial'
import { relay } from '../budget'

import { dial } from '../outbound/dial'

export interface XhttpResult {
  response: Response
  dialResult: DialResult
}

/** 解析 XHTTP 请求并建立出站连接，返回流式响应 */
export async function handleXhttp(
  request: Request,
  config: UserConfig,
  proxies: ProxyEndpoint[]
): Promise<Response> {
  const body = request.body
  if (!body) {
    return new Response('缺少请求体', { status: 400 })
  }

  const stream = new ByteStream(body)
  const parsed = await parseVless(stream, config.uuid)
  if (!parsed) {
    return new Response('VLESS 头解析失败', { status: 400 })
  }
  if (parsed.header.command !== VLESS_COMMAND_TCP) {
    return new Response('XHTTP 暂不支持 UDP', { status: 400 })
  }

  const dialResult = await dial({
    hostname: parsed.header.hostname,
    port: parsed.header.port,
    proxies,
    nat64: config.nat64,
    concurrent: config.concurrentDial,
  })

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

  // 上行：请求体剩余部分 → 出站
  void relay(parsed.payload, dialResult.writable)
  // 下行：出站 → 响应体
  void relay(dialResult.readable, writable)

  // VLESS 响应头：版本(1) + Addons 长度(1) + Addons（原样回显请求里的 Addons）。
  // Xray 客户端要求先读到这个头才认为入站已建立，缺失时会把后续下行数据当作协议错误丢弃。
  const addons = parsed.header.addons
  if (addons.byteLength > 255) {
    return new Response('Addons 长度超出 VLESS 协议上限', { status: 400 })
  }
  const header = new Uint8Array(2 + addons.byteLength)
  header[0] = parsed.header.version
  header[1] = addons.byteLength
  header.set(addons, 2)

  // 把响应头与下行流拼接：头部先行，下行数据随后。
  const headerStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(header)
      controller.close()
    },
  })

  const combined = new ReadableStream<Uint8Array>({
    async start(controller) {
      const headerReader = headerStream.getReader()
      for (;;) {
        const { done, value } = await headerReader.read()
        if (done) break
        if (value) controller.enqueue(value)
      }
      headerReader.releaseLock()
      const downReader = readable.getReader()
      try {
        for (;;) {
          const { done, value } = await downReader.read()
          if (done) break
          if (value) controller.enqueue(value)
        }
      } finally {
        downReader.releaseLock()
        controller.close()
      }
    },
    cancel(reason) {
      void readable.cancel(reason)
    },
  })

  return new Response(combined, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
