/**
 * 数据面路由：WebSocket / XHTTP 代理入站 + 真连接探针。
 *
 * 与控制面分开部署时，这个 worker **只做转发**，不含面板与订阅。
 * 真机实测：控制面与数据面拆开后，两边都能在 Pages 上原地更新；
 * 合并成一个 bundle 会被 Cloudflare 判定为完整代理服务并在二次部署时封禁（8000119）。
 */
import type { Env, UserConfig } from '../types'
import { handleEdgeProbe } from '../probe'
import { handleWebSocket } from '../protocols/websocket'
import { handleXhttp } from '../protocols/xhttp'
import { parseProxyPool, type ProxyEndpoint } from '../outbound/proxy-pool'
import { jsonError } from '../ui/neutral'
import { loadDataPlaneConfig } from './control'

/** 汇总出站代理池 */
export function collectProxies(config: UserConfig): ProxyEndpoint[] {
  const proxies: ProxyEndpoint[] = []
  // PROXYIP 是「指定落地地址」，不是 SOCKS5 代理；裸 host:port 必须按直连语义解析。
  // 历史上这里固定传 'socks5'，导致 BPB 风格的 ProxyIP 配置被当成 SOCKS5 握手而全部失败。
  proxies.push(...parseProxyPool(config.proxyIp, 'direct'))
  proxies.push(...parseProxyPool(config.socks5, 'socks5'))
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

  const config = await loadDataPlaneConfig(env)
  const upgrade = request.headers.get('Upgrade')?.toLowerCase()

  if (url.pathname === config.wsPath) {
    if (upgrade !== 'websocket') {
      return jsonError('该路径需要 WebSocket 升级', 400)
    }
    return handleWebSocket(request, 'vless', config, collectProxies(config), ctx)
  }

  if (config.enableTrojan && url.pathname === config.trojanPath) {
    if (upgrade !== 'websocket') {
      return jsonError('该路径需要 WebSocket 升级', 400)
    }
    return handleWebSocket(request, 'trojan', config, collectProxies(config), ctx)
  }

  if (config.enableXhttp && url.pathname === config.xhttpPath) {
    if (request.method !== 'POST') {
      return jsonError('XHTTP 需要 POST 请求', 405)
    }
    return await handleXhttp(request, config, collectProxies(config))
  }

  return null
}
