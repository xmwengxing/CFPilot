/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）
 *
 * ## 为什么这里用的是「移植实现」
 *
 * 我们自己写过完整实现（101 优先返回、Blob 兼容、事件内同步拨号），但在真机的
 * WebSocket 消息上下文里 `connect()` 恒定抛 `TCP Loop detected`：
 *
 *   - 同一个 Worker 的普通 HTTP 请求上下文里 `connect()` 完全正常（DIAL_OK）
 *   - 换上 CFNext 的实现后同账号、同目标 10/10 成功，我们是 0/10
 *
 * 已经排除：目标形态（IP/域名/端口/ProxyIP）、`accept({allowHalfOpen})`、
 * `binaryType`、await 时序、兼容日期、项目新旧、Workers/Pages 通道、模块上下文。
 * 因此在定位到根因之前，数据面直接复用 CFNext 的处理器
 * （来源与说明见 `vendor/cfnext-dataplane.d.ts`）。
 *
 * 面板、订阅、优选池、探针仍然是 CFPilot 自己的实现，不受影响。
 */
import type { UserConfig } from '../types'
import type { ProxyEndpoint } from '../outbound/proxy-pool'
import { wsHandler } from '../vendor/cfnext-dataplane.js'

export type WsMode = 'vless' | 'trojan'

/**
 * 处理 WebSocket 升级请求，返回 101 响应并启动双向中继。
 *
 * 认证由移植实现内部完成（VLESS 校验 UUID，Trojan 校验 SHA224 口令），
 * 校验失败会以 1002/1011 关闭连接。
 */
export function handleWebSocket(
  request: Request,
  mode: WsMode,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Response {
  void mode
  void proxies
  void ctx
  try {
    return wsHandler(request, {
      uuid: config.uuid,
      enableTrojan: config.enableTrojan,
      trojanPassword: config.trojanPassword,
      proxyIP: config.proxyIp,
      outboundProxy: '',
      outboundMode: '',
      path: config.wsPath.replace(/^\//, ''),
    })
  } catch {
    return new Response('服务暂不可用', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
