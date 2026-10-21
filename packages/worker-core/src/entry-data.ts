/**
 * 数据面入口：VLESS/Trojan over WebSocket + XHTTP + 真连接探针。
 *
 * 不含面板与订阅，部署在用户实际连接的域名上。
 * 与控制面分开部署的原因见 `routes/control.ts` 顶部说明。
 */
import type { Env } from './types'
import { routeDataPlane } from './routes/data'
import { neutralPage } from './ui/neutral'

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      return (await routeDataPlane(request, env, ctx)) ?? neutralPage(200)
    } catch {
      return neutralPage(500)
    }
  },
}
