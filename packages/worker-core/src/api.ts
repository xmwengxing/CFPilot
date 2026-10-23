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
    await store.put(LOCAL_IPS_KEY, cleaned)
    return json({ ok: true, count: list.length })
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
    return json({
      ok: true,
      panelPath: auth.panelPath,
      domain: url.hostname,
      nodeDomain,
      dataHost: env.DATA_HOST ?? '',
      colo: (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? 'UNK',
      localIps: parsed.length,
      generatedPassword: auth.generatedPassword,
      version: '0.1.0',
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

  if (path === '/nodes' && method === 'GET') {
    // 预算建在 KV 读**之后**：墙钟近似含 I/O 等待，建早了会把等待算成 CPU，
    // 预览永远显示"CPU 预算不足"（远程 fetch 期间另有 pause/resume 保护）。
    const localIps = await loadLocalIps(store)
    const domainPool = await loadDomainLibrary(store)
    const budget = new CpuBudget(8)
    const result = await collectNodes(config, localIps, {
      budget,
      domainPool: domainPool.length > 0 ? domainPool : undefined,
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
          timer = setTimeout(() => void tick(), 3000)
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
