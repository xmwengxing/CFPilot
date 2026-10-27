/**
 * 单文件合并入口（供「上游文件 + 我们的控制面」拼接使用）。
 *
 * 与 `entry-control.ts` 的区别：匹配不到时返回 **null**，
 * 交给上游的 fetch 继续处理代理路径。
 */
import type { Env } from './types'
import { routeControlPlane } from './routes/control'

export async function route(
  request: Request,
  env: Env,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<Response | null> {
  void ctx
  try {
    return await routeControlPlane(request, env)
  } catch {
    return null
  }
}
