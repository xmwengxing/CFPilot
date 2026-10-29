/**
 * 面板 REST API
 */
import type { Env, UserConfig } from './types'
import type { Store } from './store'
import {
  createSession,
  destroySession,
  clearSessionCookie,
  issueOneTimeToken,
  sessionCookie,
  verifyPassword,
  verifyScanToken,
  verifySession,
  type AuthContext,
} from './auth'
import {
  LOCAL_IPS_KEY,
  SCANNER_TOKEN_KEY,
  loadDomainLibrary,
  loadLocalIps,
  mergeConfig,
  saveConfig,
  saveDomainLibrary,
} from './config'
import { collectNodes, parseLocalList } from './sub-engine'
import { CF_IPV4_CIDRS, COUNTRY_NAMES, PREFERRED_DOMAINS, SUPPORTED_COUNTRIES } from './data/pools'
import { randomHex } from './util'
import { CpuBudget } from './budget'
import { BUILD_VERSION, PKG_VERSION } from './version'
import { normalizeNodeDomain } from './routes/shared'

export const API_PREFIX = '/api/v1'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function error(message: string, status: number): Response {
  return json({ ok: false, error: message }, status)
}

/** 读取扫描回调令牌：KV 优先，其次环境变量 */
export async function getScannerToken(store: Store, env: Env): Promise<string> {
  const fromKv = await store.get(SCANNER_TOKEN_KEY)
  if (fromKv) return fromKv
  if (typeof env.SCANNER_TOKEN === 'string' && env.SCANNER_TOKEN) return env.SCANNER_TOKEN
  const generated = randomHex(24)
  await store.put(SCANNER_TOKEN_KEY, generated)
  return generated
}

export interface ApiContext {
  store: Store
  env: Env
  config: UserConfig
  auth: AuthContext
  /** 配置写入后调用以刷新缓存 */
  onConfigChanged: () => void
}

/**
 * 处理面板 API 请求。
 * 非 API 路由返回 null。
 */
export async function handleApi(
  request: Request,
  url: URL,
  ctx: ApiContext
): Promise<Response | null> {
  if (!url.pathname.startsWith(API_PREFIX)) return null

  const { store, env, config, auth } = ctx
  const path = url.pathname.slice(API_PREFIX.length) || '/'
  const method = request.method.toUpperCase()

  // ---- 公开接口 ----
  if (path === '/session' && method === 'GET') {
    const authenticated = await verifySession(store, request)
    return json({ ok: true, authenticated, panelPath: auth.panelPath })
  }

  if (path === '/login' && method === 'POST') {
    let password = ''
    try {
      const body = (await request.json()) as { password?: string }
      password = String(body.password ?? '')
    } catch {
      return error('请求体解析失败', 400)
    }
    if (!password) return error('请输入密码', 400)
    const ok = await verifyPassword(auth, password)
    if (!ok) return error('密码错误', 401)
    const token = await createSession(store)
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) })
  }

  if (path === '/logout' && method === 'POST') {
    await destroySession(store, request)
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
  }

  // ---- 扫描回调（Bearer 令牌鉴权，不依赖面板会话） ----
  //
  // ## ⚠️ 回填必须**覆盖**面板原有的「手动优选 IP」
  //
  // 优选池有四层，订阅节点来自 L1 + L2：
  //
  //   L1  LOCAL_PREFERRED_IPS  ← 本地真连接优选的结果（这里写入）
  //   L2  config.add           ← 面板「手动优选 IP」输入框
  //   L3  config.addApi        ← 远程 TXT 池
  //   L4  config.addCsv        ← 远程 CSV 池
  //
  // 旧实现只写 L1、不动 L2 → 订阅里 **L1 + L2 都在** →
  // 用户看到「回填了但订阅仍是旧 IP 的节点」。
  //
  // 修法：回填时同时清空 L2（config.add）。
  // 理由：两者是同一用途（优选 IP 池），而回填的是**实测过真连接**的结果，
  // 质量高于手填；用户手动加的那批保留反而会拉低整体可用率。
  //
  // 只清 config.add，**不动** addApi / addCsv —— 那是用户自己配的远程池。
  if (path === '/preferred-ips' && method === 'POST') {
    const header = request.headers.get('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim()
    const authorized = await verifyScanToken(store, token)
    if (!authorized) return error('Token 校验失败', 401)
    let body: { ips?: unknown }
    try {
      body = (await request.json()) as { ips?: unknown }
    } catch {
      return error('请求体解析失败', 400)
    }
    const list = Array.isArray(body.ips) ? body.ips.map((v) => String(v)) : []
    const cleaned = list
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n')
    // ⚠️ 先读再比，内容没变就不写。
    //
    // KV 免费版配额是 **1000 次写/天**，而「一键优选」可能一天跑好几次
    // （托盘菜单、手册扫描、多实例）。同一批结果重复 put 纯属浪费配额，
    // 写配额耗尽后「保存配置 / 回填」会直接 500。
    const previous = await store.get(LOCAL_IPS_KEY)
    const changed = previous !== cleaned
    if (changed) await store.put(LOCAL_IPS_KEY, cleaned)

    // 覆盖：清空面板手填的「手动优选 IP」，让订阅里只有本次回填的结果
    let clearedManual = false
    if ((config.add ?? '').trim() !== '') {
      await saveConfig(store, mergeConfig(config, { add: '' }))
      ctx.onConfigChanged()
      clearedManual = true
    }

    return json({ ok: true, count: list.length, clearedManual })
  }

  // ---- 以下接口需要面板会话 ----
  const authenticated = await verifySession(store, request)
  if (!authenticated) return error('未登录或会话已过期', 401)

  if (path === '/status' && method === 'GET') {
    const localIps = await loadLocalIps(store)
    const parsed = parseLocalList(localIps)
    // 节点域名 = 订阅里实际下发的 SNI / Host：subDomain > DATA_HOST > 面板域名。
    // 拆分部署时它与面板域名不同，面板概览与本地优选命令都必须用它。
    const nodeDomain = normalizeNodeDomain(config.subDomain || env.DATA_HOST || url.hostname)
    // ⚠️ 这里的版本号**必须是真实的构建版本**。
    //
    // 2026-10-28 用户报障：「系统内核版本」这张卡从来没变过，像是硬编码。
    // 查下来确实写死成 `version: '0.1.0'` —— 面板永远显示 0.1.0。
    // 现在给两个值：
    //   version     = BUILD_VERSION（<git短hash>-<源码哈希>，精确到内容）
    //   pkgVersion  = PKG_VERSION（0.9.4 这类人读版本，构建期从 package.json 注入）
    // 另带 readAt（读取时刻），面板据此显示「数据是刚读的」。
    return json({
      ok: true,
      panelPath: auth.panelPath,
      domain: url.hostname,
      nodeDomain,
      dataHost: env.DATA_HOST ?? '',
      colo: (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? 'UNK',
      localIps: parsed.length,
      generatedPassword: auth.generatedPassword,
      version: BUILD_VERSION,
      pkgVersion: PKG_VERSION,
      readAt: Date.now(),
    })
  }

  if (path === '/config' && method === 'GET') {
    return json({ ok: true, config })
  }

  if (path === '/config' && method === 'PUT') {
    let body: { config?: Partial<UserConfig> }
    try {
      body = (await request.json()) as { config?: Partial<UserConfig> }
    } catch {
      return error('请求体解析失败', 400)
    }
    if (!body.config || typeof body.config !== 'object') return error('缺少配置对象', 400)
    const merged = mergeConfig(config, body.config)
    await saveConfig(store, merged)
    ctx.onConfigChanged()
    return json({ ok: true, config: merged })
  }

  if (path === '/ips' && method === 'GET') {
    const text = await loadLocalIps(store)
    const parsed = parseLocalList(text)
    return json({ ok: true, raw: text, count: parsed.length, entries: parsed })
  }

  if (path === '/ips' && method === 'DELETE') {
    await store.delete(LOCAL_IPS_KEY)
    return json({ ok: true })
  }

  // 手动保存本地池
  //
  // ## 与「手动填写 ADD」的区别
  //
  //   LOCAL_PREFERRED_IPS（本地池）← 本地优选回填，可在面板里查看/编辑
  //   config.add（手动填写）        ← 用户自己加的条目
  //
  // 两者在 collectNodes 里都会进入订阅（当 poolManual 勾选时）。
  // 之前面板只能「清空」本地池，看不到也不能改 ——
  // 用户跑完回填后在面板里找不到 IP，以为失败了。
  //
  // ⚠️ 语义：这里**无条件保存**，与 poolManual 勾选无关。
  // poolManual 只决定这些 IP 是否成为订阅节点。
  if (path === '/ips' && method === 'PUT') {
    let body: { raw?: unknown }
    try {
      body = (await request.json()) as { raw?: unknown }
    } catch {
      return error('请求体解析失败', 400)
    }
    if (typeof body.raw !== 'string') return error('缺少 raw 字段', 400)

    const cleaned = body.raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n')

    if (cleaned) {
      await store.put(LOCAL_IPS_KEY, cleaned)
    } else {
      // delete 同样占一次写配额：本来就没有才跳过
      if ((await store.get(LOCAL_IPS_KEY)) !== null) await store.delete(LOCAL_IPS_KEY)
    }
    return json({ ok: true, count: cleaned ? cleaned.split('\n').length : 0 })
  }

  if (path === '/nodes' && method === 'GET') {
    // 预算建在 KV 读**之后**：墙钟近似含 I/O 等待，建早了会把等待算成 CPU，
    // 预览永远显示"CPU 预算不足"（远程 fetch 期间另有 pause/resume 保护）。
    const localIps = await loadLocalIps(store)
    const domainPool = await loadDomainLibrary(store)
    const budget = new CpuBudget(8)
    const result = await collectNodes(config, localIps, {
      budget,
      domainPool: domainPool.length > 0 ? domainPool : undefined,
      // 面板预览是「点一下就要看到最新结果」的场景，必须绕过远程池缓存。
      // 订阅走 120 秒缓存（客户端会周期性重拉，缓存挡住突发）；
      // 预览若也吃缓存，用户改完远端 CSV/TXT 池会以为没生效。
      bypassRemoteCache: true,
    })
    return json({
      ok: true,
      count: result.nodes.length,
      nodes: result.nodes.slice(0, 200),
      groups: result.groups.map((g) => ({ key: g.key, name: g.name, count: g.entries.length })),
      stats: result.stats,
    })
  }

  // ---- 优选库元信息 / 自定义域名库 ----
  if (path === '/pool/meta' && method === 'GET') {
    const custom = await loadDomainLibrary(store)
    return json({
      ok: true,
      countries: SUPPORTED_COUNTRIES.map((code) => ({ code, name: COUNTRY_NAMES[code] ?? code })),
      limits: { officialCount: 200, domainCount: 100 },
      builtin: {
        cidrs: CF_IPV4_CIDRS.length,
        domains: PREFERRED_DOMAINS.length,
      },
      customDomains: custom,
    })
  }

  if (path === '/pool/library' && method === 'PUT') {
    let body: { domains?: unknown }
    try {
      body = (await request.json()) as { domains?: unknown }
    } catch {
      return error('请求体解析失败', 400)
    }
    const list = Array.isArray(body.domains) ? body.domains.map((v) => String(v)) : []
    await saveDomainLibrary(store, list)
    return json({ ok: true, count: list.filter((d) => d.trim()).length })
  }

  if (path === '/scanner-token' && method === 'POST') {
    const token = await issueOneTimeToken(store)
    return json({ ok: true, token, expiresIn: 600 })
  }

  if (path === '/events' && method === 'GET') {
    return await sseEvents(request, store)
  }

  return error('接口不存在', 404)
}

/**
 * SSE：本地优选池变化时推送更新事件（面板一键扫描用）
 */
async function sseEvents(request: Request, store: Store): Promise<Response> {
  const encoder = new TextEncoder()
  let lastValue = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = (): void => {
        if (timer) clearTimeout(timer)
        try {
          controller.close()
        } catch {
          /* 已关闭 */
        }
      }
      request.signal.addEventListener('abort', close)

      const tick = async (): Promise<void> => {
        try {
          const value = await loadLocalIps(store)
          if (value !== lastValue) {
            lastValue = value
            const count = parseLocalList(value).length
            controller.enqueue(encoder.encode(`event: ips\ndata: ${JSON.stringify({ count })}\n\n`))
          } else {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }
        } catch {
          /* 连接已断开 */
        }
        if (!request.signal.aborted) {
          // 每个 tick 都会 loadLocalIps(store) 读一次 KV：3 秒一次等于
          // 面板开着就 1200 次/小时，远超「回填完刷新页面能看到变化」的需要。
          // 15 秒一次（240 次/小时）同样覆盖该体验，还能省掉大量 KV 读。
          timer = setTimeout(() => void tick(), 15000)
        }
      }
      await tick()
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
