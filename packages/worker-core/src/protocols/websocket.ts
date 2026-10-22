/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）—— 使用 CFNext 数据面
 *
 * ## 为什么用 vendor 实现而不是自研
 *
 * 2026-10-22 做过完整自研实现（含 DoH 优选 IP 库、机房中转、首包缓存），
 * 本地 161 项测试全绿，但真机对照实验得到结论：
 *
 *   同一 zone 路由、同一账号：
 *   - 极简脚本（无 sockets）        6/6 正常
 *   - CFPilot 控制面（无 sockets）  4/4 正常
 *   - 自研数据面（静态 import sockets） 0/4 全部 1101
 *   - edgetunnel 原版（无 sockets）  5/5 正常
 *
 * 即：该环境下只要触及 `cloudflare:sockets` 就无法运行（30 行 sockets-only
 * 脚本同样复现 `TCP Loop detected`，与代码无关）。edgetunnel 的做法是
 * **完全不用 TCP socket**，改用 `fetch()` 落地。
 *
 * 自研实现已归档到 `archive/self-developed-dataplane/`，保留完整代码与测试。
 * 若将来要在本环境启用，需先把它改成 fetch() 落地（架构级改动）。
 *
 * ## vendor 数据面说明
 *
 * 来源：https://github.com/PAICNI/CFNext 的 `CFNext-明文版.js`，
 * 详见 `vendor/cfnext-dataplane.d.ts`。它内部完成 VLESS/Trojan 认证与出站拨号。
 *
 * 注意：用户配置的 SOCKS5 / HTTP 代理池当前**不会**传给 vendor
 * （其入参只有 proxyIP 一个字段）。这是已知限制，见
 * docs/cloudflare-deployment-diagnosis.md。
 */
import type { UserConfig } from '../types'
import type { ProxyEndpoint } from '../outbound/proxy-pool'
import { wsHandler } from '../vendor/cfnext-dataplane.js'

export type WsMode = 'vless' | 'trojan'

/**
 * 处理 WebSocket 升级请求，返回 101 响应并启动双向中继。
 *
 * 认证由 vendor 实现内部完成（VLESS 校验 UUID，Trojan 校验 SHA224 口令），
 * 校验失败会以 1002/1011 关闭连接。
 */
export function handleWebSocket(
  request: Request,
  mode: WsMode,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Response {
  // vendor 的入参不含代理池，这里显式忽略以免误以为已生效
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
