/**
 * CFPilot Worker 内核入口
 *
 * 路由顺序：
 *   1. /__edge_probe        真连接探针（WebSocket 101 校验 + 流式测速）
 *   2. /api/v1/*            面板 API
 *   3. /sub/<token>         订阅输出（Base64 / Clash / Sing-box）
 *   4. /<panelPath>         中文管理面板
 *   5. VLESS-WS / Trojan-WS / VLESS-XHTTP 代理入站
 */
import type { Env, UserConfig } from './types'
import { createStore, type Store } from './store'
import { loadConfig, LOCAL_IPS_KEY } from './config'
import { ensureBootstrap, type AuthContext } from './auth'
import { handleApi } from './api'
import { handleEdgeProbe } from './probe'
import { handleWebSocket } from './protocols/websocket'
import { handleXhttp } from './protocols/xhttp'
import { collectNodes, renderSubscription, type RenderContext, type SubFormat } from './sub-engine'
import { parseProxyPool, type ProxyEndpoint } from './outbound/dial'
import { getPanelHtml } from './ui/panel'

const CONFIG_TTL_MS = 15_000
const AUTH_TTL_MS = 60_000

interface Caches {
  config: UserConfig | null
  configAt: number
  auth: AuthContext | null
  authAt: number
  store: Store | null
}

const caches: Caches = {
  config: null,
  configAt: 0,
  auth: null,
  authAt: 0,
  store: null,
}

function getStore(env: Env): Store {
  if (!caches.store) caches.store = createStore(env)
  return caches.store
}

async function getConfig(store: Store, env: Env): Promise<UserConfig> {
  if (caches.config && Date.now() - caches.configAt < CONFIG_TTL_MS) return caches.config
  const config = await loadConfig(store, env)
  caches.config = config
  caches.configAt = Date.now()
  return config
}

function invalidateConfig(): void {
  caches.config = null
  caches.configAt = 0
}

async function getAuth(store: Store, env: Env): Promise<AuthContext> {
  if (caches.auth && Date.now() - caches.authAt < AUTH_TTL_MS) return caches.auth
  const auth = await ensureBootstrap(store, env.PANEL_PASSWORD, env.PANEL_PATH)
  caches.auth = auth
  caches.authAt = Date.now()
  return auth
}

/** 解析订阅格式参数 */
function resolveFormat(value: string | null): SubFormat {
  switch ((value ?? '').toLowerCase()) {
    case 'clash':
    case 'mihomo':
    case 'yaml':
      return 'clash'
    case 'singbox':
    case 'sing-box':
    case 'json':
      return 'singbox'
    case 'v2ray':
      return 'v2ray'
    case 'base64':
    default:
      return 'base64'
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const store = getStore(env)

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // 1) 真连接探针
    if (url.pathname === '/__edge_probe') {
      return handleEdgeProbe(request)
    }

    // 2) 面板 API
    const apiResponse = await handleApi(request, url, {
      store,
      env,
      config: await getConfig(store, env),
      auth: await getAuth(store, env),
      onConfigChanged: invalidateConfig,
    })
    if (apiResponse) return apiResponse

    // 3) 订阅
    if (url.pathname === '/sub' || url.pathname.startsWith('/sub/')) {
      return await handleSubscription(request, url, store, env)
    }

    const config = await getConfig(store, env)
    const auth = await getAuth(store, env)

    // 4) 面板
    if (url.pathname === auth.panelPath || url.pathname === `${auth.panelPath}/`) {
      return new Response(await getPanelHtml(), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      })
    }

    // 5) 代理入站
    const proxies = collectProxies(config)
    const upgrade = request.headers.get('Upgrade')?.toLowerCase()

    if (url.pathname === config.wsPath) {
      if (upgrade !== 'websocket') {
        return jsonError('该路径需要 WebSocket 升级', 400)
      }
      return await handleWebSocket(request, 'vless', config, proxies)
    }

    if (config.enableTrojan && url.pathname === config.trojanPath) {
      if (upgrade !== 'websocket') {
        return jsonError('该路径需要 WebSocket 升级', 400)
      }
      return await handleWebSocket(request, 'trojan', config, proxies)
    }

    if (config.enableXhttp && url.pathname === config.xhttpPath) {
      if (request.method !== 'POST') {
        return jsonError('XHTTP 需要 POST 请求', 405)
      }
      return await handleXhttp(request, config, proxies)
    }

    return jsonError('未找到匹配的路由', 404)
  },
}

/** 汇总出站代理池 */
function collectProxies(config: UserConfig): ProxyEndpoint[] {
  const proxies: ProxyEndpoint[] = []
  proxies.push(...parseProxyPool(config.proxyIp, 'socks5'))
  proxies.push(...parseProxyPool(config.socks5, 'socks5'))
  proxies.push(...parseProxyPool(config.httpProxy, 'http'))
  return proxies
}

/** 订阅输出 */
async function handleSubscription(
  request: Request,
  url: URL,
  store: Store,
  env: Env
): Promise<Response> {
  const config = await getConfig(store, env)
  const token = url.pathname.slice('/sub/'.length).split('/')[0] ?? ''
  const authorized =
    token === config.uuid ||
    token === config.trojanPassword ||
    url.searchParams.get('token') === config.uuid
  if (!authorized) {
    return jsonError('订阅令牌无效', 403)
  }

  const format = resolveFormat(url.searchParams.get('target') ?? url.searchParams.get('format'))
  const localIps = (await store.get(LOCAL_IPS_KEY)) ?? ''
  const collected = await collectNodes(config, localIps)

  const domain = config.subDomain || url.hostname
  const ctx: RenderContext = {
    nodes: collected.nodes,
    config,
    domain,
    port: 443,
    protocol: config.subProtocol,
    transport: config.subTransport,
  }
  const rendered = renderSubscription(format, ctx)

  return new Response(rendered.body, {
    status: 200,
    headers: {
      'Content-Type': rendered.contentType,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${rendered.fileName}"`,
      'Profile-Title': 'CFPilot',
      'Subscription-Userinfo': '',
    },
  })
}
