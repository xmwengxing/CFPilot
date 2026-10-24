/**
 * 实验变体 A：完全内联形态，但**不在模块顶层写 globalThis.__cfpDial** ——
 * 改成与现行形态一样在每个请求里（installConnect 内）同步赋值。
 *
 * 用途：与 lab-inline（顶层写入 → 522）对照，检验「isolate 启动阶段写
 * globalThis」是否就是 522 的触发点。
 */
import type { Env } from '../src/types'
import { handleEdgeProbe } from '../src/probe'
import { handleWebSocket } from '../src/protocols/websocket-self'
import { handleXhttp } from '../src/protocols/xhttp'
import { recentDiagnostics } from '../src/protocols/websocket-self'
import { recentXhttpDiagnostics } from '../src/protocols/xhttp'
import { parseProxyPool, type ProxyEndpoint } from '../src/outbound/proxy-pool'
import { jsonError } from '../src/ui/neutral'
import { getStore, getConfig } from '../src/routes/shared'
import { VERSION_PATH, versionResponse } from '../src/version'
import { setConnectOverride, dial } from '../src/outbound/dial'
import type { DialLike } from '../src/protocols/websocket-self'

/** `request.fetcher.connect` 的参数形状 */
interface SocketOptionsLike {
  secureTransport?: 'off' | 'on' | 'starttls'
  allowHalfOpen?: boolean
}

/** `request.fetcher` 的最小形状 */
interface RequestFetcher {
  connect?: (
    address: { hostname: string; port: number },
    options?: SocketOptionsLike
  ) => unknown
}

/** 汇总出站代理池（与 routes/data.ts 的 collectProxies 同语义） */
function collectProxies(config: {
  proxyIp: string
  socks5: string
  httpProxy: string
}): ProxyEndpoint[] {
  const proxies: ProxyEndpoint[] = []
  proxies.push(...parseProxyPool(config.proxyIp, 'direct'))
  proxies.push(...parseProxyPool(config.socks5, 'socks5'))
  proxies.push(...parseProxyPool(config.httpProxy, 'http'))
  return proxies
}

const __dialRef = dial as DialLike

/** 注入出站能力（connect + dial 都在请求时注入，isolate 启动阶段零 globalThis 写入） */
function installConnect(request: Request): void {
  const fetcher = (request as unknown as { fetcher?: RequestFetcher }).fetcher
  const fn = fetcher?.connect
  if (typeof fn === 'function') {
    const bound = fn.bind(fetcher) as NonNullable<RequestFetcher['connect']>
    setConnectOverride(
      ((address: { hostname: string; port: number }, options?: SocketOptionsLike) =>
        options === undefined ? bound(address) : bound(address, options)) as never
    )
  } else {
    setConnectOverride(null)
  }

  // dial 也在请求时注入（与现行形态语义一致）
  const g = globalThis as unknown as { __cfpDial?: DialLike }
  if (typeof g.__cfpDial !== 'function') g.__cfpDial = __dialRef
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      installConnect(request)

      const url = new URL(request.url)
      if (url.pathname === VERSION_PATH) return versionResponse()
      if (url.pathname === '/__edge_probe') return handleEdgeProbe(request)

      if (url.pathname === '/__diag') {
        return new Response(
          JSON.stringify(
            { ok: true, impl: 'self-inline-noglobal', recent: recentDiagnostics(), xhttp: recentXhttpDiagnostics() },
            null,
            2
          ),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )
      }

      const store = getStore(env)
      const config = await getConfig(store, env)
      const upgrade = request.headers.get('Upgrade')?.toLowerCase()

      if (url.pathname === config.wsPath) {
        if (upgrade !== 'websocket') return jsonError('该路径需要 WebSocket 升级', 400)
        return await handleWebSocket(request, 'vless', config, collectProxies(config), ctx)
      }

      if (config.enableTrojan && url.pathname === config.trojanPath) {
        if (upgrade !== 'websocket') return jsonError('该路径需要 WebSocket 升级', 400)
        return await handleWebSocket(request, 'trojan', config, collectProxies(config), ctx)
      }

      if (config.enableXhttp && url.pathname === config.xhttpPath) {
        if (request.method !== 'POST') return jsonError('XHTTP 需要 POST 请求', 405)
        return await handleXhttp(request, config, collectProxies(config))
      }

      return new Response('ok', { status: 200 })
    } catch (err) {
      return new Response('err ' + (err instanceof Error ? err.message : ''), { status: 500 })
    }
  },
}
