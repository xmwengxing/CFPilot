/**
 * Cloudflare API 客户端
 *
 * 仅使用 API Token（Bearer）鉴权，不接触 Global API Key。
 */

export const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareAccount {
  id: string
  name: string
}

export interface CloudflareZone {
  id: string
  name: string
  status: string
}

export interface KvNamespace {
  id: string
  title: string
}

export interface ScriptBinding {
  type: 'kv_namespace' | 'plain_text'
  name: string
  namespace_id?: string
  text?: string
}

export interface ApiErrorBody {
  success: false
  errors: Array<{ code: number; message: string }>
  messages?: unknown[]
}

export interface TokenVerifyResult {
  id: string
  status: string
  /** 旧字段名（user-owned Token） */
  notBefore?: string
  /** 到期时间（account-owned Token 会返回） */
  expiresOn?: string
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message)
    this.name = 'CloudflareError'
  }
}

export interface ClientOptions {
  token: string
  apiBase?: string
  timeoutMs?: number
}

export class CloudflareClient {
  private readonly token: string
  private readonly apiBase: string
  private readonly timeoutMs: number

  constructor(options: ClientOptions) {
    this.token = options.token.trim()
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE
    this.timeoutMs = options.timeoutMs ?? 30000
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    if (!response.ok) {
      const errorBody = parsed as ApiErrorBody | null
      const message =
        errorBody?.errors?.map((e) => e.message).join('; ') ||
        (text ? text.slice(0, 300) : `HTTP ${response.status}`)
      const code = errorBody?.errors?.[0]?.code
      throw new CloudflareError(message, response.status, code)
    }
    return (parsed as { result: T }).result
  }

  /**
   * 校验 Token 是否有效。
   *
   * Cloudflare 有两种 Token：
   *   - user-owned（传统 40 位字符串）→ 走 /user/tokens/verify
   *   - account-owned（cfat_ 前缀）→ 只能走 /accounts/{id}/tokens/verify，
   *     对 /user/tokens/verify 一律返回 401 Invalid API Token。
   *
   * 因此这里先试用户维度，失败且在已知账号时回退到账号维度。
   * 拿不到 token 元信息并不代表 Token 不可用，调用方不应据此阻断部署。
   */
  async verifyToken(accountId?: string): Promise<TokenVerifyResult> {
    try {
      const result = await this.request<TokenVerifyResult & { not_before?: string }>(
        'GET',
        '/user/tokens/verify'
      )
      return { ...result, notBefore: result.notBefore ?? result.not_before }
    } catch (err) {
      if (!accountId) throw err
      const result = await this.request<TokenVerifyResult & { expires_on?: string }>(
        'GET',
        `/accounts/${accountId}/tokens/verify`
      )
      return { ...result, expiresOn: result.expiresOn ?? result.expires_on }
    }
  }

  /** 列出账号 */
  async listAccounts(): Promise<CloudflareAccount[]> {
    return await this.request('GET', '/accounts?per_page=50')
  }

  /** 列出域名（zone） */
  async listZones(name?: string): Promise<CloudflareZone[]> {
    const query = name ? `?name=${encodeURIComponent(name)}&per_page=50` : '?per_page=50'
    return await this.request('GET', `/zones${query}`)
  }

  /** 列出 KV 命名空间 */
  async listKvNamespaces(accountId: string): Promise<KvNamespace[]> {
    return await this.request('GET', `/accounts/${accountId}/storage/kv/namespaces`)
  }

  /** 创建 KV 命名空间 */
  async createKvNamespace(accountId: string, title: string): Promise<KvNamespace> {
    return await this.request('POST', `/accounts/${accountId}/storage/kv/namespaces`, { title })
  }

  /** 列出已部署的 Worker 脚本 */
  async listScripts(accountId: string): Promise<string[]> {
    return await this.request('GET', `/accounts/${accountId}/workers/scripts`)
  }

  /** 上传 Worker 脚本（ES module，多段上传） */
  async uploadScript(
    accountId: string,
    scriptName: string,
    options: {
      mainModule: string
      code: string
      compatibilityDate: string
      bindings: ScriptBinding[]
    }
  ): Promise<void> {
    const metadata = {
      main_module: options.mainModule,
      compatibility_date: options.compatibilityDate,
      bindings: options.bindings,
    }

    const form = new FormData()
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
    form.set(
      options.mainModule,
      new Blob([options.code], { type: 'application/javascript+module' }),
      options.mainModule
    )

    const response = await fetch(
      `${this.apiBase}/accounts/${accountId}/workers/scripts/${scriptName}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = `上传失败 HTTP ${response.status}`
      try {
        const parsed = JSON.parse(text) as ApiErrorBody
        if (parsed?.errors?.length) message = parsed.errors.map((e) => e.message).join('; ')
      } catch {
        if (text) message = `${message} ${text.slice(0, 200)}`
      }
      throw new CloudflareError(message, response.status)
    }
  }

  /** 绑定自定义域名 */
  async attachCustomDomain(
    accountId: string,
    options: { hostname: string; service: string; zoneId: string; environment?: string }
  ): Promise<void> {
    await this.request('PUT', `/accounts/${accountId}/workers/domains`, {
      hostname: options.hostname,
      service: options.service,
      zone_id: options.zoneId,
      environment: options.environment ?? 'production',
    })
  }

  /** 创建 Worker 路由 */
  async createRoute(
    zoneId: string,
    options: { pattern: string; script: string }
  ): Promise<void> {
    await this.request('POST', `/zones/${zoneId}/workers/routes`, {
      pattern: options.pattern,
      script: options.script,
    })
  }

  /** 创建 DNS 记录 */
  async createDnsRecord(
    zoneId: string,
    options: {
      type: 'A' | 'AAAA' | 'CNAME'
      name: string
      content: string
      proxied?: boolean
      ttl?: number
    }
  ): Promise<void> {
    await this.request('POST', `/zones/${zoneId}/dns_records`, {
      type: options.type,
      name: options.name,
      content: options.content,
      ttl: options.ttl ?? 1,
      proxied: options.proxied ?? true,
    })
  }

  /** 查询脚本的绑定与设置 */
  async getScriptSettings(accountId: string, scriptName: string): Promise<Record<string, unknown>> {
    return await this.request('GET', `/accounts/${accountId}/workers/scripts/${scriptName}/settings`)
  }

  /** 查询账号的 workers.dev 子域名 */
  async getWorkersSubdomain(accountId: string): Promise<string> {
    const result = await this.request<{ subdomain?: string }>(
      'GET',
      `/accounts/${accountId}/workers/subdomain`
    )
    return result?.subdomain ?? ''
  }
}
