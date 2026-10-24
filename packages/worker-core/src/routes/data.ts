/**
 * 数据面路由：WebSocket / XHTTP 代理入站 + 真连接探针。
 *
 * 与控制面分开部署时，这个 worker **只做转发**，不含面板与订阅。
 * 真机实测：控制面与数据面拆开后，两边都能在 Pages 上原地更新；
 * 合并成一个 bundle 会被 Cloudflare 判定为完整代理服务并在二次部署时封禁（8000119）。
 */
import type { Env, UserConfig } from '../types'
import { handleEdgeProbe } from '../probe'
import { resolveDataPlaneImpl } from '../protocols/dataplane'
import { handleXhttp } from '../protocols/xhttp'
import { parseProxyPool, type ProxyEndpoint } from '../outbound/proxy-pool'
import { jsonError } from '../ui/neutral'
import { loadDataPlaneConfig } from './control'

/**
 * 按实现选择取 WS 处理器。
 *
 * ⚠️ **不要在模块顶层静态 import `protocols/websocket`**：它会把 vendor
 *（`vendor/cfnext-dataplane.js`，232KB）一起打进产物 —— 真机实测
 * 该组合在 Workers 通道会 isolate 启动失败（HTTP 522），Pages 通道正常。
 *
 * 因此：
 *   - `self`（默认）→ 直接用自研的 `websocket-self`（零 vendor 依赖）；
 *   - `vendor`      → 动态 import `protocols/websocket`（只有显式切回才加载 vendor）。
 *
 * 这样默认产物既能在 Pages 上正常工作，也能在 Workers 上跑起来。
 */
async function resolveWsHandler(impl: 'self' | 'vendor'): Promise<
  (typeof import('../protocols/websocket-self'))['handleWebSocket']
> {
  if (impl === 'self') {
    const mod = await import('../protocols/websocket-self')
    return mod.handleWebSocket
  }
  const mod = await import('../protocols/websocket')
  return mod.handleWebSocket as unknown as (typeof import('../protocols/websocket-self'))['handleWebSocket']
}

/** 汇总出站代理池 */
export function collectProxies(config: UserConfig): ProxyEndpoint[] {
  const proxies: ProxyEndpoint[] = []
  // PROXYIP 是「指定落地地址」，不是 SOCKS5 代理；裸 host:port 必须按直连语义解析。
  // 历史上这里固定传 'socks5'，导致 BPB 风格的 ProxyIP 配置被当成 SOCKS5 握手而全部失败。
  proxies.push(...parseProxyPool(config.proxyIp, 'direct'))
  proxies.push(...parseProxyPool(config.socks5, 'socks5'))
  // HTTP_PROXY 里的 `https://` 前缀会被 parseProxyEntry 识别为 'https' 类型
  // （代理服务器本身走 TLS，需 connect({secureTransport:'on'})）。
  proxies.push(...parseProxyPool(config.httpProxy, 'http'))
  return proxies
}

/**
 * 处理数据面请求；不匹配时返回 null。
 */
export async function routeDataPlane(
  request: Request,
  env: Env,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/__edge_probe') {
    return handleEdgeProbe(request)
  }

  // 出站诊断端点：自研数据面专有。
  //
  // 完整诊断装不进 WebSocket close frame（最多 123 字节），
  // 超长还会被 Cloudflare 边缘**静默丢弃整个 close frame**（真机实测）。
  // 所以另辟这个端点，让「为什么连不上」能被完整看到。
  if (url.pathname === '/__diag') {
    const { recentDiagnostics } = await import('../protocols/websocket-self')
    const { recentXhttpDiagnostics } = await import('../protocols/xhttp')
    return new Response(
      JSON.stringify(
        {
          ok: true,
          impl: resolveDataPlaneImpl(env.DATAPLANE as string | undefined),
          recent: recentDiagnostics(),
          xhttp: recentXhttpDiagnostics(),
        },
        null,
        2
      ),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  const config = await loadDataPlaneConfig(env)
  const upgrade = request.headers.get('Upgrade')?.toLowerCase()
  // 数据面实现选择：默认 vendor（生产验证过），DATAPLANE=self 切自研
  const impl = resolveDataPlaneImpl(env.DATAPLANE as string | undefined)

  if (url.pathname === config.wsPath) {
    if (upgrade !== 'websocket') {
      return jsonError('该路径需要 WebSocket 升级', 400)
    }
    const handler = await resolveWsHandler(impl)
    return await handler(request, 'vless', config, collectProxies(config), ctx)
  }

  if (config.enableTrojan && url.pathname === config.trojanPath) {
    if (upgrade !== 'websocket') {
      return jsonError('该路径需要 WebSocket 升级', 400)
    }
    const handler = await resolveWsHandler(impl)
    return await handler(request, 'trojan', config, collectProxies(config), ctx)
  }

  if (config.enableXhttp && url.pathname === config.xhttpPath) {
    if (request.method !== 'POST') {
      return jsonError('XHTTP 需要 POST 请求', 405)
    }
    return await handleXhttp(request, config, collectProxies(config))
  }

  return null
}
