/**
 * 部署后的真实访问校验
 *
 * 背景（本账号实测）：`PUT /accounts/{aid}/workers/domains` 返回 200 且
 * `enabled: true`，但实际访问仍然是 522。也就是说「绑定成功」不等于「能访问」。
 *
 * 因此部署向导必须在绑定后主动 GET 一次真实地址：
 *   - 2xx          → 域名真的通了；
 *   - 522/523/530  → Cloudflare 边缘连不到 Worker，通常是自定义域名未生效；
 *   - 超时/网络错误 → 可能被本地网络阻断，也可能域名未生效。
 * 失败时由调用方自动降级到 Route + CNAME，再失败则降级 workers.dev。
 */

export interface AccessCheckOptions {
  /** 单次请求超时（毫秒），默认 10000 */
  timeoutMs?: number
  /** 最多尝试次数，默认 3（新绑定的域名需要一点生效时间） */
  attempts?: number
  /** 重试间隔（毫秒），默认 4000 */
  intervalMs?: number
  /** 便于测试注入的 fetch 实现 */
  fetchImpl?: typeof fetch
}

export interface AccessCheckResult {
  ok: boolean
  /** 最后一次响应的 HTTP 状态码；网络错误/超时为 0 */
  status: number
  /** 可读的中文结论 */
  detail: string
  /** 实际发起的请求次数 */
  attempts: number
  url: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 把常见 HTTP 状态码翻译成人话（尤其是 Cloudflare 的 5xx 系列） */
export function describeHttpStatus(status: number): string {
  switch (status) {
    case 1016:
      return 'HTTP 1016（源站 DNS 解析失败，常见于 Route / CNAME 未生效）'
    case 403:
      return 'HTTP 403（请求被拒绝，可能是 Cloudflare 安全策略或路由未匹配）'
    case 404:
      return 'HTTP 404（路径不存在，可能是 Worker 未部署或面板路径不一致）'
    case 522:
      return 'HTTP 522（Cloudflare 连不到源站：自定义域名「绑定成功但未生效」的典型症状）'
    case 523:
      return 'HTTP 523（Cloudflare 无法解析源站地址）'
    case 524:
      return 'HTTP 524（源站响应超时）'
    case 530:
      return 'HTTP 530（源站 DNS 解析失败，通常需要检查 CNAME / Route 配置）'
    default:
      return `HTTP ${status}`
  }
}

/** 把 fetch 抛出的异常翻译成人话 */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return '请求超时（域名未生效，或本地网络到该域名的链路不通）'
    }
    return `请求失败：${err.message}`
  }
  return `请求失败：${String(err)}`
}

/**
 * 校验一个 URL 是否可以正常访问（2xx 视为成功）。
 *
 * 默认会重试 3 次、每次间隔 4 秒：Cloudflare 新绑定的域名通常需要几秒到几十秒生效，
 * 立刻判死刑会误伤；但也不能无限等，所以总耗时控制在 10 秒左右。
 */
export async function checkUrlAccess(
  url: string,
  options: AccessCheckOptions = {}
): Promise<AccessCheckResult> {
  const timeoutMs = options.timeoutMs ?? 10000
  const attempts = Math.max(1, options.attempts ?? 3)
  const intervalMs = Math.max(0, options.intervalMs ?? 4000)
  const fetcher = options.fetchImpl ?? fetch

  let lastStatus = 0
  let lastDetail = '未发起请求'

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'Cache-Control': 'no-cache',
          'User-Agent': 'cfpilot-deploy',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      lastStatus = response.status
      // 只需要状态码，主动丢弃响应体，避免大响应占用连接
      await response.body?.cancel().catch(() => undefined)
      if (response.status >= 200 && response.status < 300) {
        return {
          ok: true,
          status: response.status,
          detail: `HTTP ${response.status}`,
          attempts: attempt,
          url,
        }
      }
      lastDetail = describeHttpStatus(response.status)
    } catch (err) {
      lastStatus = 0
      lastDetail = describeFetchError(err)
    }
    if (attempt < attempts) await sleep(intervalMs)
  }

  return { ok: false, status: lastStatus, detail: lastDetail, attempts, url }
}

/** 自定义域名下用户真正要打开的面板地址 */
export function panelAccessUrl(hostname: string, panelPath: string): string {
  const path = panelPath.startsWith('/') ? panelPath : `/${panelPath}`
  return `https://${hostname}${path}`
}

/** 校验自定义域名的面板地址（GET https://{hostname}{panelPath}） */
export async function checkPanelAccess(
  hostname: string,
  panelPath: string,
  options: AccessCheckOptions = {}
): Promise<AccessCheckResult> {
  return await checkUrlAccess(panelAccessUrl(hostname, panelPath), options)
}

/** 校验 workers.dev 地址（同样用面板路径，用户之后会直接打开它） */
export async function checkWorkersDevAccess(
  workersDevHost: string,
  panelPath: string,
  options: AccessCheckOptions = {}
): Promise<AccessCheckResult> {
  return await checkPanelAccess(workersDevHost, panelPath, { attempts: 2, intervalMs: 3000, ...options })
}
