/**
 * 数据面路由：WebSocket / XHTTP 代理入站 + 真连接探针。
 *
 * 与控制面分开部署时，这个 worker **只做转发**，不含面板与订阅。
 * 真机实测：控制面与数据面拆开后，两边都能在 Pages 上原地更新；
 * 合并成一个 bundle 会被 Cloudflare 判定为完整代理服务并在二次部署时封禁（8000119）。
 *
 * ## 只有一套数据面实现
 *
 * 历史第三方实现（`wsHandler`）已于 **完全移除**：
 * 它占产物体积 77%（250KB 里 193KB），让数据面长期超出 80KB 预算，
 * 且自带 `cloudflare:sockets` 静态 import。自研实现（`websocket-self.ts`）
 * 覆盖 VLESS-WS / Trojan-WS / XHTTP + 代理池 + 分级诊断，早已是生产默认。
 */
import type { Env, UserConfig } from '../types'
import { handleEdgeProbe } from '../probe'
import { handleWebSocket } from '../protocols/websocket-self'
import { handleXhttp } from '../protocols/xhttp'
import { parseProxyPool, type ProxyEndpoint } from '../outbound/proxy-pool'
import { VERSION_PATH, versionResponse, BUILD_VERSION } from '../version'
import { timingSafeEqual } from '../util'
import { loadDataPlaneConfig } from './control'

/** 汇总出站代理池 */
export function collectProxies(config: UserConfig): ProxyEndpoint[] {
  const proxies: ProxyEndpoint[] = []
  // PROXYIP 是「指定落地地址」，不是 SOCKS5 代理；裸 host:port 必须按直连语义解析。
  // 历史上这里固定传 'socks5'，导致 direct 风格的 ProxyIP 配置被当成 SOCKS5 握手而全部失败。
  proxies.push(...parseProxyPool(config.proxyIp, 'direct'))
  proxies.push(...parseProxyPool(config.socks5, 'socks5'))
  // HTTP_PROXY 里的 `https://` 前缀会被 parseProxyEntry 识别为 'https' 类型
  // （代理服务器本身走 TLS，需 connect({secureTransport:'on'})）。
  proxies.push(...parseProxyPool(config.httpProxy, 'http'))
  return proxies
}

/**
 * 诊断令牌的失败计数器（isolate 级，防在线枚举）。
 *
 * ## 为什么只认完整 UUID
 *
 * 早期还接受「UUID 前 8 位」当短令牌 —— 那是 **32 bit 搜空间**，
 * 每秒几十次请求就能在可接受时间内枚举出来，而 `/__diag` 会吐出
 * 用户最近访问的目标域名与失败原因（隐私数据）。
 * 现在只认完整 UUID（128 bit），并用 `timingSafeEqual` 比较。
 *
 * ## 为什么要限速
 *
 * 完整 UUID 不可枚举，但限速能挡住「拿着泄露的前缀/近似值狂刷」
 * 与日志噪音。同样只用 isolate 内存（写 KV 会被攻击者当成耗尽配额的手段）。
 */
const DIAG_WINDOW_MS = 60_000
const DIAG_MAX_FAILURES = 10
let diagFailures = 0
let diagWindowResetAt = 0

/** 当前是否处于限速窗口 */
function diagThrottled(now: number): boolean {
  if (now >= diagWindowResetAt) {
    diagFailures = 0
    diagWindowResetAt = now + DIAG_WINDOW_MS
    return false
  }
  return diagFailures >= DIAG_MAX_FAILURES
}

/**
 * 校验 `/__diag` 的访问令牌。
 *
 * 接受 `x-cfpilot-token` 请求头（推荐，不会留在 URL / 日志里），
 * 也兼容 `?token=` 查询参数（旧命令与浏览器直接打开）。
 *
 * ⚠️ 未配置 UUID 时一律拒绝（fail-closed）：一个还没配好的部署
 * 绝不能因为「uuid 为空」而把诊断内容公开给所有人。
 */
function diagAuthorized(request: Request, url: URL, uuid: string): boolean {
  if (!uuid) return false
  const token = (
    request.headers.get('x-cfpilot-token') ??
    url.searchParams.get('token') ??
    ''
  ).trim()
  if (!token) return false
  const now = Date.now()
  if (timingSafeEqual(token, uuid)) {
    diagFailures = 0
    return true
  }
  if (now >= diagWindowResetAt) {
    diagWindowResetAt = now + DIAG_WINDOW_MS
    diagFailures = 0
  }
  diagFailures += 1
  return false
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

  // 版本端点：让外部能问「这个数据面跑的是哪一版内核」。
  //
  // ## 为什么需要
  //
  // 早前 GUI 的「检查状态」只能读 KV 清单里的 `build` 字段 —— 那是
  // **部署时自己写进去的**，不是从线上读回来的。因此存在盲区：
  // 手动改过项目、或用命令行部署过，清单与实际就可能对不上。
  //
  // 有了这个端点，GUI 可以直接问线上数据面「你是什么版本」，
  // 结论比清单可靠。
  //
  // ⚠️ 只返回版本号与时间戳，不泄露任何配置（无 uuid / 路径 / 代理信息）。
  // 任何知道数据面域名的人都能读 —— 这本身不是秘密（`/` 也能访问）。
  if (url.pathname === VERSION_PATH || url.pathname === '/__version') {
    return versionResponse()
  }

  // 出口地区端点（社区约定的 `GET /region` 形式）。
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

  // 出站诊断端点：自研数据面专有。
  //
  // 完整诊断装不进 WebSocket close frame（最多 123 字节），
  // 超长还会被 Cloudflare 边缘**静默丢弃整个 close frame**（真机实测）。
  // 所以另辟这个端点，让「为什么连不上」能被完整看到。
  //
  // ## 为什么必须鉴权、且必须放在 loadDataPlaneConfig 之后
  //
  // 诊断内容包含**用户最近访问的目标域名与失败原因**（隐私数据），
  // 以及 `impl` / `build`（内部实现与版本特征）。任何知道域名的人都能读
  // 是不可接受的 —— 该校验需要 `config.uuid`，因此只能放在配置加载之后
  // （`/region` 那种不碰 KV 的纯机房诊断才允许放在配置加载之前）。
  if (url.pathname === '/__diag') {
    if (diagThrottled(Date.now())) {
      // 超出失败预算：明确回 429，而不是伪装成静态页 ——
      // 否则脚本调用方会把「被限速」误读成「端点不存在」。
      return new Response(JSON.stringify({ ok: false, error: 'token attempts throttled' }, null, 2), {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': String(Math.ceil(DIAG_WINDOW_MS / 1000)),
        },
      })
    }
    if (!diagAuthorized(request, url, config.uuid)) return null
    const { recentDiagnostics } = await import('../protocols/websocket-self')
    const { recentXhttpDiagnostics } = await import('../protocols/xhttp')
    return new Response(
      JSON.stringify(
        {
          ok: true,
          // 只有一套实现了（vendor 已于 移除），固定返回 self
          impl: 'self',
          // 版本号：排查「线上跑的到底是哪一版」时最直接的依据
          build: BUILD_VERSION,
          recent: recentDiagnostics(),
          xhttp: recentXhttpDiagnostics(),
        },
        null,
        2
      ),
      {
        status: 200,
        // 诊断内容包含用户访问过的目标域名 —— 绝不进任何缓存
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  // 出口体检端点（默认关闭）。
  //
  // ## 为什么要单独一个端点、而不是塞进 /__diag
  //
  // `/__diag` 是**被动**的：只回放最近失败记录，不产生任何出站请求。
  // 体检是**主动**的：每次要打 5 个外部站点。混在一起会让「看一眼诊断」
  // 变成「顺手发起 5 个外部请求」，既慢又容易被当成免费探测服务。
  //
  // ## 鉴权
  //
  // 与 `/__diag` 完全一致（完整 UUID + 失败限速），复用同一套计数器。
  // 未配置 UUID 时 fail-closed（`diagAuthorized` 内部处理）。
  //
  // ## 结果按机房缓存
  //
  // 同一机房 10 分钟内只打一次外部请求（见 `unlock.ts` 的 CACHE_TTL_MS）——
  // 扫描器会对结果里出现的每个机房各调一次，缓存把重复调用压成一次。
  if (url.pathname === '/__unlock_probe') {
    if (!config.unlockProbe) return null
    if (diagThrottled(Date.now())) {
      return new Response(JSON.stringify({ ok: false, error: 'token attempts throttled' }, null, 2), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    if (!diagAuthorized(request, url, config.uuid)) return null
    const { coloToCountry } = await import('../outbound/relay')
    const { runUnlockProbe } = await import('../unlock')
    const colo = (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? ''
    const region = colo ? coloToCountry(colo) : ''
    const report = await runUnlockProbe(colo, region)
    return new Response(JSON.stringify({ ok: true, ...report }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  const upgrade = request.headers.get('Upgrade')?.toLowerCase()

  if (url.pathname === config.wsPath) {
    if (upgrade !== 'websocket') {
      // 绝不向外暴露协议报错：明文 JSON（「该路径需要 WebSocket 升级」）
      // 是运行期最直接的代理指纹，爬虫一探就知道这里是代理入口。
      // 返回 null → 外层用 neutralPage(200) 伪装成普通静态站。
      return null
    }
    return await handleWebSocket(request, 'vless', config, collectProxies(config), ctx)
  }

  if (config.enableTrojan && url.pathname === config.trojanPath) {
    if (upgrade !== 'websocket') {
      // 同上：入站路径的非 WS 访问一律静默，不暴露任何协议信息。
      return null
    }
    return await handleWebSocket(request, 'trojan', config, collectProxies(config), ctx)
  }

  if (config.enableXhttp && url.pathname === config.xhttpPath) {
    if (request.method !== 'POST') {
      // 同上：非 POST 访问静默化为普通静态站，别让 405 成为指纹。
      return null
    }
    return await handleXhttp(request, config, collectProxies(config))
  }

  return null
}
