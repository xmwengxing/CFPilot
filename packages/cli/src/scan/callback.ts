/**
 * 优选结果回传：把 Top N 结果 POST 回面板写入 KV
 */

export interface CallbackResult {
  ok: boolean
  status?: number
  error?: string
}

/**
 * 回填模式。
 *
 *   `replace`（默认）—— 清空面板优选池后写入（历史行为）
 *   `append`         —— 保留池里已有的 IP，只补真正新的（「增量回填」）
 *
 * 对应面板 `POST /api/v1/preferred-ips` 的 `mode` 字段。
 */
export type PushMode = 'replace' | 'append'

export async function postResults(
  callbackUrl: string,
  token: string,
  entries: string[],
  mode: PushMode = 'replace',
  timeoutMs = 15000
): Promise<CallbackResult> {
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'CFPilot-Scanner/1.0',
      },
      body: JSON.stringify({ ips: entries, mode }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: `回传失败 HTTP ${response.status} ${text}`.trim() }
    }
    return { ok: true, status: response.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 登录控制面，返回可直接复用的会话 Cookie。
 *
 * 从 `fetchScannerToken` 里抽出来：配置读写（`patchPanelConfig`）与
 * 取扫描令牌都要走同一次登录，两处各写一遍必然在「单 Cookie 回退」
 * 这类分支上漂移。
 *
 * ⚠️ 手动提取 Cookie，不依赖运行时自动管理 —— 面板的 Set-Cookie 带
 * `Secure; HttpOnly; SameSite=Strict`，某些运行时的 fetch 不会自动回传。
 */
export async function loginPanel(
  panelHost: string,
  password: string,
  timeoutMs = 25000
): Promise<{ ok: boolean; base: string; cookie: string; error?: string }> {
  let base = panelHost.trim()
  if (!base) return { ok: false, base: '', cookie: '', error: '缺少控制面域名（--panel）' }
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base
  base = base.replace(/\/$/, '')

  try {
    const loginRes = await fetch(base + '/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (loginRes.status === 401) {
      return { ok: false, base, cookie: '', error: '面板密码不正确' }
    }
    if (!loginRes.ok) {
      const text = await loginRes.text().catch(() => '')
      return { ok: false, base, cookie: '', error: `登录失败 HTTP ${loginRes.status} ${text.slice(0, 120)}` }
    }

    const headersWithCookies = loginRes.headers as Headers & { getSetCookie?: () => string[] }
    const raw = headersWithCookies.getSetCookie?.() ?? []
    const cookie = raw
      .map((c) => (c.split(';')[0] ?? '').trim())
      .filter(Boolean)
      .join('; ')

    if (cookie) return { ok: true, base, cookie }

    // 兼容：有的运行时只能取合并后的单值
    const single = loginRes.headers.get('set-cookie')
    if (!single) {
      return { ok: false, base, cookie: '', error: '登录成功但服务端没有下发会话 Cookie' }
    }
    return { ok: true, base, cookie: (single.split(';')[0] ?? '').trim() }
  } catch (err) {
    return { ok: false, base, cookie: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 读取面板当前配置（只读；「增量写入」要先拿现值）。
 *
 * `PUT /api/v1/config` 收的是 partial patch，本身不需要先读；但**增量**语义
 * 要求把新条目并进现值，所以这一步省不掉。
 */
export async function getPanelConfig(
  panelHost: string,
  password: string,
  timeoutMs = 25000
): Promise<{ ok: boolean; error?: string; config?: Record<string, unknown> }> {
  const session = await loginPanel(panelHost, password, timeoutMs)
  if (!session.ok) return { ok: false, error: session.error }
  try {
    const res = await fetch(session.base + '/api/v1/config', {
      headers: { Cookie: session.cookie },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, error: `读取配置失败 HTTP ${res.status} ${text.slice(0, 160)}` }
    try {
      const parsed = JSON.parse(text) as { config?: Record<string, unknown> }
      return { ok: true, config: parsed.config }
    } catch {
      return { ok: false, error: '配置接口返回的不是 JSON' }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 打补丁式更新面板配置（`PUT /api/v1/config`，后端做合并）。
 *
 * 只发要改的字段 —— 接口收的是 **partial patch**，不需要先 GET 全量。
 */
export async function patchPanelConfig(
  panelHost: string,
  password: string,
  patch: Record<string, unknown>,
  timeoutMs = 25000
): Promise<{ ok: boolean; error?: string; config?: Record<string, unknown> }> {
  const session = await loginPanel(panelHost, password, timeoutMs)
  if (!session.ok) return { ok: false, error: session.error }
  try {
    const res = await fetch(session.base + '/api/v1/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
      body: JSON.stringify({ config: patch }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, error: `更新配置失败 HTTP ${res.status} ${text.slice(0, 160)}` }
    // 接口回的是**合并后**的完整配置 —— 调用方常要顺手取 uuid，
    // 再为此单独 GET 一次纯属浪费（而且要多登一次录）。
    try {
      const parsed = JSON.parse(text) as { config?: Record<string, unknown> }
      return { ok: true, config: parsed.config }
    } catch {
      return { ok: true }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 用面板密码登录控制面，换取一次性扫描令牌。
 *
 * ## 为什么需要
 *
 * 回填需要 Bearer 令牌，令牌来自面板 `POST /api/v1/scanner-token`，
 * 而它要求面板会话。CLI 用密码换会话再取令牌，用户不必手动签发再复制。
 *
 * 令牌 10 分钟有效，本函数在**扫描结束后**调用，
 * 所以不存在「扫描太久令牌过期」的问题。
 *
 * ## 必须指向控制面
 *
 * 数据面没有面板接口（真机实测返回 Pages 的 Welcome HTML）。
 * 拆分部署时面板只在控制面。
 */
export async function fetchScannerToken(
  panelHost: string,
  password: string,
  timeoutMs = 25000
): Promise<{ ok: boolean; token?: string; error?: string }> {
  // 登录部分与 patchPanelConfig 共用 loginPanel —— 两处各写一遍
  // 会在「单 Cookie 回退」这类分支上漂移（历史上就是这么长出来的）。
  const session = await loginPanel(panelHost, password, timeoutMs)
  if (!session.ok) return { ok: false, error: session.error }
  try {
    return await takeToken(session.base, session.cookie, timeoutMs)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 带着会话 Cookie 去要令牌。 */
async function takeToken(
  base: string,
  cookie: string,
  timeoutMs: number
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const res = await fetch(base + '/api/v1/scanner-token', {
    method: 'POST',
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `获取令牌失败 HTTP ${res.status} ${text.slice(0, 120)}` }
  }

  const text = await res.text()
  // HTML 说明会话没生效（打到了非面板路由）
  if (text.trimStart().startsWith('<')) {
    return {
      ok: false,
      error: '面板返回了网页而不是接口数据，请确认 --panel 填的是控制面域名',
    }
  }

  try {
    const data = JSON.parse(text) as { ok?: boolean; token?: string }
    if (!data.token) return { ok: false, error: '面板没有返回令牌' }
    return { ok: true, token: data.token }
  } catch {
    return { ok: false, error: '令牌响应解析失败：' + text.slice(0, 120) }
  }
}
