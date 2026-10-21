/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）
 */
import type { UserConfig } from '../types'
import { ByteStream, wsToByteStream, pipeToWebSocket } from './stream'
import { parseVless, VLESS_COMMAND_TCP } from './vless'
import { parseTrojan, TROJAN_COMMAND_TCP } from './trojan'
import { dial, type ProxyEndpoint } from '../outbound/dial'
import { relay } from '../budget'

export type WsMode = 'vless' | 'trojan'

/**
 * 处理 WebSocket 升级请求，返回 101 响应并启动双向中继。
 * 解析失败时返回 400，由调用方决定如何响应。
 */
export async function handleWebSocket(
  request: Request,
  mode: WsMode,
  config: UserConfig,
  proxies: ProxyEndpoint[]
): Promise<Response> {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as unknown as [WebSocket, WebSocket]
  server.accept()

  const incoming = wsToByteStream(server)
  const stream = new ByteStream(incoming)

  const parsed =
    mode === 'vless'
      ? await parseVless(stream, config.uuid)
      : await parseTrojan(stream, config.trojanPassword)

  if (!parsed) {
    try {
      server.close(1002, '认证失败')
    } catch {
      /* 已关闭 */
    }
    return new Response('认证失败', { status: 400 })
  }

  const command = mode === 'vless' ? parsed.header.command : parsed.header.command
  if (command !== (mode === 'vless' ? VLESS_COMMAND_TCP : TROJAN_COMMAND_TCP)) {
    try {
      server.close(1003, '不支持的指令')
    } catch {
      /* 已关闭 */
    }
    return new Response('暂不支持 UDP over WebSocket', { status: 400 })
  }

  const target = parsed.header as { hostname: string; port: number }

  try {
    const dialResult = await dial({
      hostname: target.hostname,
      port: target.port,
      proxies,
      nat64: config.nat64,
      concurrent: config.concurrentDial,
    })

    // 上行：客户端 → 出站
    void relay(parsed.payload, dialResult.writable)
    // 下行：出站 → 客户端
    void pipeToWebSocket(dialResult.readable, server)
  } catch {
    try {
      server.close(1011, '出站连接失败')
    } catch {
      /* 已关闭 */
    }
    return new Response('出站连接失败', { status: 502 })
  }

  return new Response(null, { status: 101, webSocket: client })
}
