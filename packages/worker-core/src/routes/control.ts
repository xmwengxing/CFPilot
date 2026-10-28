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
import { LOCAL_IPS_KEY, ROUTE_PROFILE_KEY, loadDomainLibrary } from '../config'
import { CpuBudget } from '../budget'
import type { RenderContext, SubFormat } from '../sub-engine'
import {
  collectNodes,
  renderSubscription,
  resolveSubPorts,
  subContentDisposition,
  subProfileTitle,
} from '../sub-engine'
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
  // 面板自定义域名库必须对订阅生效：此前只有面板预览（`/api/v1/nodes`）传了
  // `domainPool`，订阅退回内置域名库 —— 用户在面板里配的自定义优选域名
  // 在实际订阅里**完全不生效**，且没有任何提示。
  const domainPool = await loadDomainLibrary(store)
  // 预算建在 KV 读之后：墙钟近似会把 I/O 等待算成 CPU，建早了会在远程池
  // 拉取期间假阳性报「CPU 预算不足」，订阅直接缺节点。
  const budget = new CpuBudget(8)
  const collected = await collectNodes(config, localIps, {
    budget,
    domainPool: domainPool.length > 0 ? domainPool : undefined,
    bypassRemoteCache: false,
  })

  // 分流规则：默认用**内核内置的 GEOSITE/GEOIP 规则**（零外部依赖、零下载）。
  //
  // KV 的 `ROUTE_PROFILE` 可写入自定义 ini 覆盖它（高级用法，留空即用内置）。
  //
  // ## 为什么不内嵌一份规则配置文件
  //
  // 早前把一份 ini 格式的分流配置用 gzip+base64 嵌进部署代码，问题有三：
  //   1. 那份 ini 的 `ruleset=` 指向远端规则集，需要配套 `rule-providers:`，
  //      我们没生成 → Clash 报 `rule set [CFnat] not found`，**订阅整个加载失败**；
  //   2. 部署代码里出现大段 gzip+base64 是明显的风控扫描特征；
  //   3. 规则清单本身与「怎么连节点」无关，内嵌它没有任何收益。
  //
  // 现在改用 Clash 内核自带的 GEOSITE/GEOIP，兼容所有 Clash / mihomo 版本。
  const routeProfile = (await store.get(ROUTE_PROFILE_KEY)) ?? ''

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
      // 订阅名下发（2026-10-28 用户报「卡片名带引号和斜杠」后重做）：
      //   filename=      纯 ASCII token 时**不加引号** —— 有的客户端会把引号原样当成名字
      //   filename*=     额外给一份 RFC 5987 编码，中文名也能正确落名
      //   Profile-Title  Clash / mihomo 读它做卡片标题，非 ASCII 时按 RFC 2047 编码
      'Content-Disposition': subContentDisposition(config.subName),
      'Profile-Title': subProfileTitle(config.subName),
      // 客户端靠它算剩余流量/到期；空值会让部分客户端弹出解析警告，明确给 0 更干净
      'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0',
    },
  })
}

/** 常见静态资源扩展名 —— 面板路径永远不带扩展名 */
const STATIC_ASSET = /\.(?:ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|map|txt|xml|json|webmanifest|woff2?|ttf|eot)$/i

/**
 * 本地粗判「这条路径有没有可能是面板页」。
 *
 * 只做**黑名单**：`/`、带文件扩展名的静态资源（`/favicon.ico`、`/robots.txt`、
 * `/xxx.js` 等）一定不是面板页。绝不能反过来写成「必须以 PANEL_PATH 开头」的
 * 白名单 —— `PANEL_PATH` 可由用户自定义，白名单一旦与实际配置不一致
 * 就会把面板本身打成 404。
 */
function mayBePanelPage(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return false
  return !STATIC_ASSET.test(pathname)
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

  // 明显不像面板页的路径直接放弃，**不调用 getAuth**：
  // `getAuth` 会读 KV（首次引导还会写），而 `/`、`/favicon.ico`、`/robots.txt`
  // 以及各种爬虫探测路径都会打到这里，无谓消耗 KV 读配额与 CPU。
  if (!mayBePanelPage(url.pathname)) return null

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
