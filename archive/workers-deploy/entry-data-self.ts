/**
 * 数据面入口（**Workers 通道专用**）—— 纯自研实现，零 vendor 依赖。
 *
 * ## 为什么需要单独一个入口
 *
 * 真机结论（2026-10-24，两个账号、60+ 轮对照）：
 *
 * | 产物内容                                            | Workers |
 * |-----------------------------------------------------|---------|
 * | 数据面 + vendor（`vendor/cfnext-dataplane.js` 232KB） | **522** |
 * | 数据面 + 纯自研（无 vendor，38KB）                    | **200** |
 *
 * vendor 与自研实现混在同一个产物里，会让 Workers 的 isolate 启动失败
 * （对外 HTTP 522），而 Pages 通道完全正常。
 *
 * 因此 Workers 通道专用本入口：
 *   - 只用自研 `websocket-self` / `xhttp`，**不引入 vendor**；
 *   - 出站能力由本入口持有并通过 `globalThis` 注入（对齐 edgetunnel 做法），
 *     深层模块不做静态依赖。
 *
 * Pages 通道仍用原来的 `entry-data.ts`（含 vendor 回退能力）。
 */
import type { Env } from './types'
import { handleEdgeProbe } from './probe'
import { handleWebSocket } from './protocols/websocket-self'
import { handleXhttp } from './protocols/xhttp'
import { parseProxyPool, type ProxyEndpoint } from './outbound/proxy-pool'
import { jsonError } from './ui/neutral'
import { getStore, getConfig } from './routes/shared'
import { VERSION_PATH, versionResponse } from './version'
import { setConnectOverride } from './outbound/dial'
import type { DialLike } from './protocols/websocket-self'

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

/** 汇总出站代理池（与 `routes/data.ts` 的 collectProxies 同语义） */
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

/** 拨号模块的加载 Promise（isolate 内只加载一次） */
let dialPromise: Promise<DialLike> | null = null

/**
 * 注入出站能力。
 *
 * 两个注入点，缺一不可：
 *   1. `setConnectOverride` —— 拨号层用 `request.fetcher.connect` 代替
 *      `cloudflare:sockets`（静态导入会让 Workers 522）；
 *   2. `globalThis.__cfpDial` —— 供 `websocket-self` 的 `resolveDial()` 取用，
 *      避免它对 `outbound/dial` 产生静态/动态依赖。
 */
function installOutbound(request: Request): void {
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

  const g = globalThis as unknown as { __cfpDial?: DialLike }
  if (typeof g.__cfpDial !== 'function') {
    dialPromise ??= (async () => {
      const mod = (await import('./outbound/dial')) as { dial: DialLike }
      return mod.dial
    })()
    void dialPromise.then((dial) => {
      const cur = globalThis as unknown as { __cfpDial?: DialLike }
      if (typeof cur.__cfpDial !== 'function') cur.__cfpDial = dial
    })
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      // 必须早于任何出站调用
      installOutbound(request)

      const url = new URL(request.url)
      if (url.pathname === VERSION_PATH) return versionResponse()
      if (url.pathname === '/__edge_probe') return handleEdgeProbe(request)

      if (url.pathname === '/__diag') {
        const { recentDiagnostics } = await import('./protocols/websocket-self')
        const { recentXhttpDiagnostics } = await import('./protocols/xhttp')
        return new Response(
          JSON.stringify(
            { ok: true, impl: 'self-workers', recent: recentDiagnostics(), xhttp: recentXhttpDiagnostics() },
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
