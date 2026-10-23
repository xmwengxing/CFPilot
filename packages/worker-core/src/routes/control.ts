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
import { LOCAL_IPS_KEY } from '../config'
import type { RenderContext, SubFormat } from '../sub-engine'
import { collectNodes, renderSubscription } from '../sub-engine'
import { handleEdgeProbe } from '../probe'
import { getPanelHtml } from '../ui/panel'
import { jsonError } from '../ui/neutral'
import { getStore, getConfig, getAuth, invalidateConfig, resolveFormat, resolveFormatByUserAgent } from './shared'

type ApiModule = typeof import('../api')
let apiModule: ApiModule | null = null
async function loadApi(): Promise<ApiModule> {
  if (!apiModule) apiModule = await import('../api')
  return apiModule
}

/**
 * 把「节点域名」配置规范化成裸域名。
 *
 * ## 为什么需要（2026-10-23 真机踩坑）
 *
 * `DATA_HOST` / `subDomain` 的值会被**原样**用作订阅节点里的
 * `sni` / `host` / `servername` / Clash `Host` 头。
 * 用户在面板里很容易顺手填成完整 URL（`https://xxx.pages.dev/`），
 * 于是 SNI 变成 `https://xxx.pages.dev/` —— TLS 握手必败，
 * 且**没有任何报错**（客户端只表现为「全部节点连不上」）。
 *
 * 部署向导写的一直是裸域名（`result.data.subdomain`），
 * 所以这个坑只在**用户手改**时出现；这里兜底，防再犯。
 */
export function normalizeNodeDomain(value: string): string {
  let text = String(value ?? '').trim()
  if (!text) return text
  // 去掉 scheme（http:// / https://，大小写不敏感）
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  // 去掉路径 / query / hash（第一个 / ? # 起都不要）
  text = text.replace(/[/?#].*$/, '')
  // 去掉用户信息（user@host 形式不会出现，防御而已）
  const at = text.lastIndexOf('@')
  if (at >= 0) text = text.slice(at + 1)
  // 去掉端口（host:port → host；IPv6 [addr]:port → addr）
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end > 0) text = text.slice(1, end)
  } else {
    const first = text.indexOf(':')
    if (first >= 0 && text.indexOf(':', first + 1) < 0) text = text.slice(0, first)
  }
  return text.trim()
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

  // 拆分部署时控制面域名 ≠ 数据面域名，必须用 subDomain（或 DATA_HOST）指定节点地址
  const domain = normalizeNodeDomain(config.subDomain || env.DATA_HOST || url.hostname)
  const ctx: RenderContext = {
    nodes: collected.nodes,
    groups: collected.groups,
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
