/**
 * 优选结果回传：把 Top N 结果 POST 回面板写入 KV
 */

export interface CallbackResult {
  ok: boolean
  status?: number
  error?: string
}

export async function postResults(
  callbackUrl: string,
  token: string,
  entries: string[],
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
      body: JSON.stringify({ ips: entries }),
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
 * 用面板密码登录控制面，换取一次性扫描令牌。
 *
 * ## 为什么需要
 *
 * 回填需要 Bearer 令牌，令牌来自面板 `POST /api/v1/scanner-token`，
 * 而它要求面板会话。CLI 用密码换会话再取令牌，用户不必手动去
 * 面板点「生成令牌」再复制。
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
  let base = panelHost.trim()
  if (!base) return { ok: false, error: '缺少控制面域名（--panel）' }
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base
  base = base.replace(/\/$/, '')

  try {
    // ---- 1. 登录 ----
    const loginRes = await fetch(base + '/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (loginRes.status === 401) {
      return { ok: false, error: '面板密码不正确' }
    }
    if (!loginRes.ok) {
      const text = await loginRes.text().catch(() => '')
      return { ok: false, error: `登录失败 HTTP ${loginRes.status} ${text.slice(0, 120)}` }
    }

    // ---- 2. 取会话 Cookie ----
    //
    // ⚠️ 手动提取，不依赖运行时自动管理 Cookie。
    // 面板的 Set-Cookie 带 Secure; HttpOnly; SameSite=Strict，
    // 某些运行时的 fetch 不会自动回传。
    const headersWithCookies = loginRes.headers as Headers & { getSetCookie?: () => string[] }
    const raw = headersWithCookies.getSetCookie?.() ?? []
    const cookie = raw
      .map((c) => (c.split(';')[0] ?? '').trim())
      .filter(Boolean)
      .join('; ')

    if (!cookie) {
      // 兼容：有的运行时只能取合并后的单值
      const single = loginRes.headers.get('set-cookie')
      if (!single) {
        return { ok: false, error: '登录成功但服务端没有下发会话 Cookie' }
      }
      return await takeToken(base, (single.split(';')[0] ?? '').trim(), timeoutMs)
    }

    return await takeToken(base, cookie, timeoutMs)
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
