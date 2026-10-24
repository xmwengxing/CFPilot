/**
 * CFPilot Worker 内核 —— 单一部署入口（控制面 + 数据面）。
 *
 * 路由顺序：
 *   1. 控制面：/__edge_probe、/api/v1/*、/sub/<token>、/<panelPath>
 *   2. 数据面：VLESS-WS / Trojan-WS / VLESS-XHTTP
 *
 * 当前合并产物尚未通过生产稳定性验证：Pages 更新复现过 8000119，
 * Workers 路由复现过延迟出现的 1101；具体触发原因未获平台确认。
 * 单次部署或短时成功不能视为生产可用，禁止向用户承诺可靠部署。
 */
import type { Env } from './types'
import { routeControlPlane } from './routes/control'
import { routeDataPlane } from './routes/data'
import { neutralPage } from './ui/neutral'

export default {
  /**
   * 捕获路由调用中的异常；不覆盖模块初始化、后台任务或响应流阶段的错误。
   */
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      return (
        (await routeControlPlane(request, env)) ??
        (await routeDataPlane(request, env, ctx)) ??
        neutralPage(200)
      )
    } catch {
      return neutralPage(500)
    }
  },
}
