/**
 * 实验变体 B：现行形态（惰性 init 机制原样保留），但**在模块顶层静态写入
 * `globalThis.__cfpDial`**（现行形态是在请求时经动态 import 完成后写入）。
 *
 * 用途：与 lab-current（顶层不写入 → 200）对照，检验「isolate 启动阶段写
 * globalThis」是否**足以**单独触发 522。
 *
 * 其余逻辑与 src/entry-data-self.ts 逐行一致（含 __diag 的动态 import）。
 */
import type { Env } from '../src/types'
import { handleEdgeProbe } from '../src/probe'
import { handleWebSocket } from '../src/protocols/websocket-self'
import { handleXhttp } from '../src/protocols/xhttp'
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

// ⚠️ 实验点：现行形态这里是**空的**（顶层不碰 globalThis）；
// 变体 B 在这里顶层同步写入 dial —— 其余与 entry-data-self.ts 完全一致。
const __bLabDial = dial as DialLike
const __bLabGlobal = globalThis as unknown as { __cfpDial?: DialLike }
if (typeof __bLabGlobal.__cfpDial !== 'function') __bLabGlobal.__cfpDial = __bLabDial

/** 拨号模块的加载 Promise（isolate 内只加载一次） */
let dialPromise: Promise<DialLike> | null = null

/**
 * 注入出站能力（与 entry-data-self.ts 逐行一致）。
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
      const mod = (await import('../src/outbound/dial')) as { dial: DialLike }
      return mod.dial
    })()
    void dialPromise.then((dialFn) => {
      const cur = globalThis as unknown as { __cfpDial?: DialLike }
      if (typeof cur.__cfpDial !== 'function') cur.__cfpDial = dialFn
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
        const { recentDiagnostics } = await import('../src/protocols/websocket-self')
        const { recentXhttpDiagnostics } = await import('../src/protocols/xhttp')
        return new Response(
          JSON.stringify(
            { ok: true, impl: 'self-current-topleveldial', recent: recentDiagnostics(), xhttp: recentXhttpDiagnostics() },
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
