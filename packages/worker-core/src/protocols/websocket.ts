/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）—— 数据面实现选择
 *
 * ## 两套实现
 *
 * | 实现 | 文件 | 特点 |
 * |------|------|------|
 * | **vendor**（默认） | `vendor/cfnext-dataplane.js` | CFNext 的 `wsHandler`，生产验证过 |
 * | **自研** | `protocols/websocket-self.ts` | 本项目自研，出站选路可诊断、支持代理池 |
 *
 * 切换方式：环境变量 `DATAPLANE=vendor`（默认）或 `DATAPLANE=self`。
 *
 * ## ⚠️ 更正此前的错误归因（2026-10-23 真机复验）
 *
 * 本文件此前写着「该环境下只要触及 `cloudflare:sockets` 就无法运行」，
 * 并称「30 行 sockets-only 脚本同样复现 TCP Loop detected」。
 * **该结论已被推翻**：
 *
 *   - 静态 import sockets 但**从不调用** → 部署 success、响应正常
 *   - 静态 import 且**真的调用 connect()** → 部署 success，运行时才报错
 *
 * 真实限制是：**Worker 不能主动连回 Cloudflare 自家的 Anycast 地址**
 * （`1.1.1.1` / `cloudflare.com` / `104.16.0.1` 一律被拒，报 `TCP Loop detected`）；
 * **第三方 IP 的 443 完全可用**。vendor 数据面能工作，
 * 是因为它的优选 IP 来自**域名解析**（`proxyip.hk.<域名>`），
 * 解析结果未必落在 CF Anycast 段。
 *
 * 完整实验矩阵见 docs/self-developed-dataplane-design.md §1。
 *
 * ## vendor 数据面说明
 *
 * 来源：https://github.com/PAICNI/CFNext 的 `CFNext-明文版.js`，
 * 详见 `vendor/cfnext-dataplane.d.ts`。它内部完成 VLESS/Trojan 认证与出站拨号。
 *
 * 注意：用户配置的 SOCKS5 / HTTP 代理池当前**不会**传给 vendor
 * （其入参只有 proxyIP 一个字段）。这是已知限制，见
 * docs/cloudflare-deployment-diagnosis.md。自研实现**支持**代理池。
 */
import type { UserConfig } from '../types'
import type { ProxyEndpoint } from '../outbound/proxy-pool'
import { wsHandler } from '../vendor/cfnext-dataplane.js'
import { handleWebSocket as handleWebSocketSelf, type WsDiagnostics } from './websocket-self'

export type WsMode = 'vless' | 'trojan'

import type { DataPlaneImpl } from './dataplane'

export type { DataPlaneImpl } from './dataplane'

/**
 * 处理 WebSocket 升级请求，返回 101 响应并启动双向中继。
 *
 * vendor 路径的认证由 vendor 实现内部完成（VLESS 校验 UUID，Trojan 校验 SHA224 口令）；
 * 自研路径由本项目自己完成，失败原因会分级上报（`diagnostics`）。
 */
export async function handleWebSocket(
  request: Request,
  mode: WsMode,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  ctx?: { waitUntil(promise: Promise<unknown>): void },
  options?: { impl?: DataPlaneImpl; diagnostics?: WsDiagnostics }
): Promise<Response> {
  const impl = options?.impl ?? 'vendor'

  if (impl === 'self') {
    return await handleWebSocketSelf(request, mode, config, proxies, ctx, options?.diagnostics)
  }

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
