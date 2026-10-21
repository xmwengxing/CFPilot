/**
 * 控制面入口：面板 + 订阅 + 探针。
 *
 * 部署说明见 `routes/control.ts` 顶部：控制面必须与数据面**分开部署**，
 * 否则合并后的 bundle 会被 Cloudflare 在二次部署时封禁（8000119）。
 */
import type { Env } from './types'
import { routeControlPlane } from './routes/control'
import { neutralPage } from './ui/neutral'

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    void ctx
    try {
      return (await routeControlPlane(request, env)) ?? neutralPage(200)
    } catch {
      return neutralPage(500)
    }
  },
}
