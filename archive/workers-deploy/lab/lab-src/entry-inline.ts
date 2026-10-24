/**
 * 实验入口：**完全内联形态**（edgetunnel 形态复刻）—— 仅用于 522 根因实验。
 *
 * 与 `src/entry-data-self.ts` 的唯一差异：
 *   - 全部模块**静态 import**（dial / websocket-self / xhttp / 诊断函数），
 *     产物里没有 esbuild 的 `__commonJS` / `__toESM` / `init_*` 惰性初始化机制，
 *     所有模块顶层语句在 isolate 启动时按依赖顺序一次性执行 —— 单一作用域。
 *   - `globalThis.__cfpDial` 在**模块顶层**同步赋值（不依赖动态 import 完成时机）。
 *
 * 出站 connect 仍走 `request.fetcher.connect` 注入（setConnectOverride），
 * 产物中不含任何 `cloudflare:sockets` 字样（构建期由 strip 插件剥离回退路径）。
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

// ⚠️ 模块顶层同步注入 dial —— 无动态 import、无 Promise 时序。
const __dialRef = dial as DialLike
const g = globalThis as unknown as { __cfpDial?: DialLike }
if (typeof g.__cfpDial !== 'function') g.__cfpDial = __dialRef

/** 注入 connect（request.fetcher.connect 代替 cloudflare:sockets） */
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
            { ok: true, impl: 'self-inline-lab', recent: recentDiagnostics(), xhttp: recentXhttpDiagnostics() },
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
