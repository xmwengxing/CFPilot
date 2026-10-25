/**
 * 控制面路由：面板 API + 订阅 + 面板页面 + 探针。
 *
 * 这一层**不引入 `cloudflare:sockets`**（不含任何出站 TCP 代码），
 * 因为真机实测：把「面板+订阅+探针」与「出站拨号」放进同一个 bundle 时，
 * Cloudflare 会在第二次部署时把项目标记为 blocked（8000119）；
 * 拆开后两边都能原地更新。详见 HANDOVER 的 §0.10。
 */
import type { Env, UserConfig } from '../types'
import type { Store } from '../store'
import { LOCAL_IPS_KEY, ROUTE_PROFILE_KEY } from '../config'
import { loadRouteProfileText } from '../route-profile.generated'
import type { RenderContext, SubFormat } from '../sub-engine'
import { collectNodes, renderSubscription, resolveSubPorts, sanitizeSubName } from '../sub-engine'
import { handleEdgeProbe } from '../probe'
import { getPanelHtml } from '../ui/panel'
import { jsonError } from '../ui/neutral'
import { getStore, getConfig, getAuth, invalidateConfig, resolveFormat, resolveFormatByUserAgent, normalizeNodeDomain } from './shared'

// 从 shared 再导出：历史 import 路径（含测试）保持不变，同时避免 api.ts ↔ control.ts 循环依赖
export { normalizeNodeDomain } from './shared'

type ApiModule = typeof import('../api')
let apiModule: ApiModule | null = null
async function loadApi(): Promise<ApiModule> {
  if (!apiModule) apiModule = await import('../api')
  return apiModule
}

/**
 * 订阅输出 */
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

  // 格式判定优先级：URL 显式参数 > User-Agent > 默认 base64。
  //
  // 客户端导入订阅时只给 URL、不加 `?target=clash`，
  // 而是靠 User-Agent 表明身份（Clash Verge 发 `clash-verge/…`）。
  // 只认 URL 参数的话，Clash Verge 拿到的是 base64 文本，按 YAML 解析必然失败。
  const explicit = url.searchParams.get('target') ?? url.searchParams.get('format')
  const format = explicit
    ? resolveFormat(explicit)
    : (resolveFormatByUserAgent(request.headers.get('User-Agent')) ?? resolveFormat(null))
  const localIps = (await store.get(LOCAL_IPS_KEY)) ?? ''
  const collected = await collectNodes(config, localIps)

  // 分流规则配置：KV 的 `ROUTE_PROFILE` 优先，留空则用内置（assets/route-profiles.ini）。
  //
  // 为什么要 KV 可覆盖：内置配置是构建期内联的，改它要发新版；
  // 而用户可能想换一套分组（比如只要 Netflix 分流）。给个覆盖口子，
  // 又不必为此把整个订阅生成改成运行时 fetch（铁律 8）。
  const routeProfile = (await store.get(ROUTE_PROFILE_KEY)) ?? (await loadRouteProfileText())

  // 拆分部署时控制面域名 ≠ 数据面域名，必须用 subDomain（或 DATA_HOST）指定节点地址
  const domain = normalizeNodeDomain(config.subDomain || env.DATA_HOST || url.hostname)
  const ctx: RenderContext = {
    nodes: collected.nodes,
    groups: collected.groups,
    config,
    domain,
    port: 443,
    ports: resolveSubPorts(config),
    protocol: config.subProtocol,
    transport: config.subTransport,
    routeProfile,
  }
  const rendered = renderSubscription(format, ctx)

  return new Response(rendered.body, {
    status: 200,
    headers: {
      'Content-Type': rendered.contentType,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${rendered.fileName}"`,
      // 部分客户端（如 Shadowrocket）优先读 Profile-Title 作为订阅名
      'Profile-Title': sanitizeSubName(config.subName),
      'Subscription-Userinfo': '',
    },
  })
}

/**
 * 处理控制面请求；不匹配时返回 null（交给上层兜底或数据面）。
 */
export async function routeControlPlane(
  request: Request,
  env: Env
): Promise<Response | null> {
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

  // 真连接探针（无 sockets 依赖，控制面也保留一份，方便面板自测）
  if (url.pathname === '/__edge_probe') {
    return handleEdgeProbe(request)
  }

  // 面板 API
  if (url.pathname.startsWith('/api/')) {
    const { handleApi } = await loadApi()
    const apiResponse = await handleApi(request, url, {
      store,
      env,
      config: await getConfig(store, env),
      auth: await getAuth(store, env),
      onConfigChanged: invalidateConfig,
    })
    if (apiResponse) return apiResponse
  }

  // 订阅
  if (url.pathname === '/sub' || url.pathname.startsWith('/sub/')) {
    return await handleSubscription(request, url, store, env)
  }

  // 面板页面
  const auth = await getAuth(store, env)
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

  return null
}

/** 供数据面复用：读取当前配置（数据面只需要 uuid / 路径 / 出站设置） */
export async function loadDataPlaneConfig(env: Env): Promise<UserConfig> {
  const store = getStore(env)
  return await getConfig(store, env)
}
