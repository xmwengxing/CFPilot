/**
 * 数据面路由：WebSocket / XHTTP 代理入站 + 真连接探针。
 *
 * 与控制面分开部署时，这个 worker **只做转发**，不含面板与订阅。
 * 真机实测：控制面与数据面拆开后，两边都能在 Pages 上原地更新；
 * 合并成一个 bundle 会被 Cloudflare 判定为完整代理服务并在二次部署时封禁（8000119）。
 *
 * ## 只有一套数据面实现（2026-10-25）
 *
 * vendor（CFNext 的 `wsHandler`）已于 2026-10-25 **完全移除**：
 * 它占产物体积 77%（250KB 里 193KB），让数据面长期超出 80KB 预算，
 * 且自带 `cloudflare:sockets` 静态 import。自研实现（`websocket-self.ts`）
 * 覆盖 VLESS-WS / Trojan-WS / XHTTP + 代理池 + 分级诊断，早已是生产默认。
 */
import type { Env, UserConfig } from '../types'
import { handleEdgeProbe } from '../probe'
import { handleWebSocket } from '../protocols/websocket-self'
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
          // 只有一套实现了（vendor 已于 2026-10-25 移除），固定返回 self
          impl: 'self',
          recent: recentDiagnostics(),
          xhttp: recentXhttpDiagnostics(),
        },
        null,
        2
      ),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  // 出口地区端点（借鉴 cfnew 的 `GET /region`）。
  //
  // 报告当前请求落在哪个边缘机房、推断出哪个国家/地区，
  // 以及反代入口的地区优先级。用途：
  //   - 用户想知道「我的流量从哪出国」
  //   - 排查「为什么这个地区连不上」（反代入口按地区选）
  //
  // ⚠️ 只读 GET 且不触碰 KV，因此放在 loadDataPlaneConfig 之前 ——
  // 避免为一个纯诊断请求付出一次 KV 读取。
  if (url.pathname === '/region' && request.method === 'GET') {
    const { coloToCountry, rankRegions } = await import('../outbound/relay')
    const colo = (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? ''
    const region = colo ? coloToCountry(colo) : ''
    return new Response(
      JSON.stringify(
        {
          ok: true,
          colo,
          region,
          // 反代入口的地区优先级：当前地区 → 邻接 → 其余
          relayPreference: region ? rankRegions(region) : [],
          timestamp: new Date().toISOString(),
        },
        null,
        2
      ),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  const config = await loadDataPlaneConfig(env)
  const upgrade = request.headers.get('Upgrade')?.toLowerCase()

  if (url.pathname === config.wsPath) {
    if (upgrade !== 'websocket') {
      return jsonError('该路径需要 WebSocket 升级', 400)
    }
    return await handleWebSocket(request, 'vless', config, collectProxies(config), ctx)
  }

  if (config.enableTrojan && url.pathname === config.trojanPath) {
    if (upgrade !== 'websocket') {
      return jsonError('该路径需要 WebSocket 升级', 400)
    }
    return await handleWebSocket(request, 'trojan', config, collectProxies(config), ctx)
  }

  if (config.enableXhttp && url.pathname === config.xhttpPath) {
    if (request.method !== 'POST') {
      return jsonError('XHTTP 需要 POST 请求', 405)
    }
    return await handleXhttp(request, config, collectProxies(config))
  }

  return null
}
