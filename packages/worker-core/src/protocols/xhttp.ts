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

/** 最近一次 XHTTP 出站诊断（isolate 级） */
const XHTTP_DIAGNOSTICS: Array<{ at: number; target: string; kind: string; message: string; candidate: string; summary: string }> = []

/** 记录 XHTTP 出站诊断 */
export function recordXhttpDiagnostics(
  target: string,
  failure: { kind: string; message: string; candidate: string },
  summary: string
): void {
  XHTTP_DIAGNOSTICS.unshift({ at: Date.now(), target, ...failure, summary })
  if (XHTTP_DIAGNOSTICS.length > 20) XHTTP_DIAGNOSTICS.length = 20
}

/** 读取 XHTTP 诊断 */
export function recentXhttpDiagnostics(): typeof XHTTP_DIAGNOSTICS {
  return XHTTP_DIAGNOSTICS
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
    // ⚠️ 这两项必须与 WS 入站路径保持一致（2026-10-23 真机发现）：
    // 少了它们，XHTTP 会**用运行时自己的 DNS 解析**目标域名 ——
    // 而运行时的解析结果可能落在 Cloudflare 网段（Worker 不能连回自家 Anycast），
    // 表现为「XHTTP 节点延迟全是 -1」，但服务端看不出任何错误。
    resolvePreferred: config.resolvePreferred,
    relayPool: {
      userEntries: config.relayPool || undefined,
      useBuiltin: config.useBuiltinRelay,
    },
    // 失败分级上报：XHTTP 出站失败此前**完全不可诊断**（表现就是客户端延迟 -1），
    // 排查时看不到任何线索。现在记录到诊断端点。
    onFailure: (failure) => {
      recordXhttpDiagnostics(
        `${parsed.header.hostname}:${parsed.header.port}`,
        failure,
        `XHTTP 出站失败（${failure.candidate}）：${failure.message}`
      )
    },
  })

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

  // 上行：请求体剩余部分 → 出站
  //
  // ⚠️ `closeTarget: false` —— 关闭 socket 的写流等于关闭整个 TCP 连接，
  // 目标站会收到 RST 而来不及把响应发回来（2026-10-23 真机发现，
  // 症状是「XHTTP 节点延迟全是 -1」）。
  // 对比：WebSocket 入站路径只 releaseLock 不 close，是正常的。
  void relay(parsed.payload, dialResult.writable, undefined, false)
  // 下行：出站 → 响应体（这里是 HTTP 响应体，结束时 close 是正确的）
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
  // ⚠️ **不能用 async start 承载整个下行**（2026-10-23 真机发现）：
  //
  // `start` 返回的 Promise 未完成时，流的 `pull` 不会被调用，
  // 而消费者（`fetch` / Xray 客户端）会一直等 —— 表现为
  // 「响应头到了，但**永远收不到后续数据**」（客户端侧就是延迟 -1）。
  //
  // 正确做法：`start` 立即返回（只把响应头入队），
  // 后续下行数据在 `pull` 里按需读取。
  let headerSent = false
  let downReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const combined = new ReadableStream<Uint8Array>({
    start(controller) {
      // 只入队响应头（2 字节），立即结束 start
      controller.enqueue(header)
      headerSent = true
    },
    async pull(controller) {
      if (!headerSent) return
      if (!downReader) downReader = readable.getReader()
      try {
        const { done, value } = await downReader.read()
        if (done) {
          controller.close()
          return
        }
        if (value && value.byteLength > 0) controller.enqueue(value)
      } catch {
        try {
          controller.close()
        } catch {
          /* 已关闭 */
        }
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
