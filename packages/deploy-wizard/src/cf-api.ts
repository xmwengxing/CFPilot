/**
 * Cloudflare API 客户端
 *
 * 仅使用 API Token（Bearer）鉴权，不接触 Global API Key。
 *
 * 几个容易踩坑的接口约定（已实测确认，不要凭记忆改）：
 *   1. 脚本上传成功后，workers.dev 子域路由**默认是关闭的**，
 *      必须调用 POST .../scripts/{name}/subdomain 且 body 为 {"enabled":true}。
 *   2. PATCH .../scripts/{name}/settings **只接受 multipart/form-data**，
 *      JSON body 会返回 415；表单字段名为 settings，值是 JSON 字符串。
 *   3. PUT .../workers/domains 返回 200 不代表域名真的可访问，必须另做连通性校验。
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

/** workers.dev 子域路由的开关状态 */
export interface ScriptSubdomain {
  enabled: boolean
}

/** 脚本设置（observability / bindings / compatibility_date 等） */
export interface ScriptSettings {
  [key: string]: unknown
}

export interface DnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
  ttl?: number
}

export interface WorkerRoute {
  id: string
  pattern: string
  script?: string
}

/** Worker 自定义域名绑定 */
export interface WorkerDomain {
  id: string
  hostname: string
  service: string
  zone_id?: string
  zone_name?: string
  environment?: string
  enabled?: boolean
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** Pages 项目 */
export interface PagesProject {
  id: string
  name: string
  subdomain: string
  domains?: string[]
  production_branch: string
  latest_deployment?: PagesDeployment
}

/** Pages 部署 */
export interface PagesDeployment {
  id: string
  url: string
  latest_stage: { name: string; status: string; ended_on?: string }
  stages: Array<{ name: string; status: string }>
}

/** Pages 项目的环境变量 / KV 绑定配置 */
export interface PagesDeploymentConfig {
  kv_namespaces?: Record<string, { namespace_id: string }>
  env_vars?: Record<string, { value: string }>
  compatibility_date?: string
  compatibility_flags?: string[]
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

/** 把 Cloudflare 的错误响应体解析成带 code 的异常 */
function parseApiError(status: number, text: string): CloudflareError {
  let message = `HTTP ${status}`
  let code: number | undefined
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<ApiErrorBody>
      const errors = Array.isArray(parsed.errors) ? parsed.errors : []
      if (errors.length > 0) {
        message = errors.map((item) => item.message).join('; ')
        code = errors[0]?.code
      } else {
        message = `${message} ${text.slice(0, 300)}`
      }
    } catch {
      message = `${message} ${text.slice(0, 300)}`
    }
  }
  return new CloudflareError(message, status, code)
}

/** 同时校验 HTTP 状态与 Cloudflare 响应信封，避免误报部署成功。 */
async function readApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw parseApiError(response.status, text)
  // DELETE 等接口可能使用无响应体的成功状态。
  if (!text) return undefined as T
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CloudflareError(`响应不是合法 JSON：${text.slice(0, 200)}`, response.status)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CloudflareError('Cloudflare 响应格式无效', response.status)
  }
  if ('success' in parsed && parsed.success === false) {
    throw parseApiError(response.status, text)
  }
  return ('result' in parsed ? parsed.result : undefined) as T
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

  /** 发送 JSON / multipart 请求并解出 result 字段 */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // FormData 绝不能手动设 Content-Type：必须让 fetch 自己带 boundary，
    // 否则 Cloudflare 会解析失败（Pages 部署接口尤其敏感）。
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return await readApiResponse<T>(response)
  }

  /**
   * 发送 multipart/form-data 请求。
   *
   * 注意：这里绝不能手动设置 Content-Type，
   * 必须让 fetch 自己带 boundary，否则 Cloudflare 会解析失败。
   */
  private async requestForm(method: string, path: string, form: FormData): Promise<void> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    await readApiResponse<unknown>(response)
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

  /**
   * 读取 KV 里的一个键值（不存在时返回 null）。
   *
   * 用于部署前检测「KV 已有配置会覆盖环境变量」的情况。
   */
  async getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.apiBase}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      )
      if (response.status === 404) return null
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    }
  }

  /**
   * 写入 KV 键值。
   *
   * 用于把部署凭据同步到数据面读取的 `config` 键。
   */
  async setKvValue(
    accountId: string,
    namespaceId: string,
    key: string,
    value: string
  ): Promise<void> {
    const response = await fetch(
      `${this.apiBase}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'text/plain',
        },
        body: value,
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw parseApiError(response.status, text)
    }
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

    await readApiResponse<unknown>(response)
  }

  /**
   * 查询脚本的 workers.dev 子域开关。
   *
   * 脚本不存在时返回 404（错误码 10007），而不是 403；
   * 权限预检正是利用这一点区分「没有权限」和「资源不存在」。
   */
  async getScriptSubdomain(accountId: string, scriptName: string): Promise<ScriptSubdomain> {
    return await this.request(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`
    )
  }

  /**
   * 开启 / 关闭脚本的 workers.dev 子域路由。
   *
   * 注意：Worker 上传成功后该路由默认是关闭的，必须显式传 enabled: true，
   * 否则 https://<name>.<sub>.workers.dev/ 会一直返回「There is nothing here yet」。
   */
  async putScriptSubdomain(
    accountId: string,
    scriptName: string,
    enabled = true
  ): Promise<ScriptSubdomain> {
    return await this.request(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
      { enabled }
    )
  }

  /**
   * 更新脚本设置（开启 Workers Logs 等）。
   *
   * Cloudflare 对 PATCH .../settings 只接受 multipart/form-data，
   * JSON body 会返回 415；字段名固定为 settings，值是 JSON 字符串。
   */
  async patchScriptSettings(
    accountId: string,
    scriptName: string,
    settings: ScriptSettings
  ): Promise<void> {
    const form = new FormData()
    // 这里用字符串字段而不是 Blob：与 curl --form 'settings=...' 的编码完全一致，
    // 带 filename 的文件段会被 Cloudflare 当成文件处理，存在解析风险。
    form.set('settings', JSON.stringify(settings))
    await this.requestForm(
      'PATCH',
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
      form
    )
  }

  /** 列出 zone 下的 DNS 记录；name 为完整主机名时按名称精确过滤 */
  async getDnsRecords(zoneId: string, name?: string): Promise<DnsRecord[]> {
    const query = new URLSearchParams({ per_page: '100' })
    if (name) query.set('name', name)
    return await this.request(
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`
    )
  }

  /** 删除 DNS 记录（需要 Zone → DNS → Edit） */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`
    )
  }

  /** 列出 zone 下的 Worker 路由 */
  async listRoutes(zoneId: string): Promise<WorkerRoute[]> {
    return await this.request('GET', `/zones/${encodeURIComponent(zoneId)}/workers/routes`)
  }

  /** 创建 Worker 路由 */
  async createRoute(
    zoneId: string,
    options: { pattern: string; script: string }
  ): Promise<WorkerRoute> {
    return await this.request('POST', `/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
      pattern: options.pattern,
      script: options.script,
    })
  }

  /** 删除 Worker 路由 */
  async deleteRoute(zoneId: string, routeId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(routeId)}`
    )
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
  ): Promise<DnsRecord> {
    return await this.request('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      type: options.type,
      name: options.name,
      content: options.content,
      ttl: options.ttl ?? 1,
      proxied: options.proxied ?? true,
    })
  }

  /**
   * 绑定自定义域名。
   *
   * 返回 200 且 enabled: true 只代表「绑定已受理」，不代表真实可访问
   * （本账号实测：接口成功但访问仍是 522），调用方必须再校验一次。
   */
  async attachCustomDomain(
    accountId: string,
    options: { hostname: string; service: string; zoneId: string; environment?: string }
  ): Promise<WorkerDomain> {
    return await this.request('PUT', `/accounts/${accountId}/workers/domains`, {
      hostname: options.hostname,
      service: options.service,
      zone_id: options.zoneId,
      environment: options.environment ?? 'production',
    })
  }

  /** 按 ID 查询 Worker 自定义域名绑定 */
  async getWorkerDomainById(accountId: string, domainId: string): Promise<WorkerDomain> {
    return await this.request(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`
    )
  }

  /** 解除 Worker 自定义域名绑定（降级到 Route + CNAME 前清理用） */
  async deleteWorkerDomain(accountId: string, domainId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`
    )
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

  /* ---------------------------------------------------------------- */
  /* Pages                                                             */
  /* ---------------------------------------------------------------- */

  /** 创建 Pages 项目 */
  async createPagesProject(
    accountId: string,
    options: { name: string; productionBranch?: string }
  ): Promise<PagesProject> {
    return await this.request('POST', `/accounts/${accountId}/pages/projects`, {
      name: options.name,
      production_branch: options.productionBranch ?? 'main',
    })
  }

  /** 查询 Pages 项目详情 */
  async getPagesProject(accountId: string, name: string): Promise<PagesProject> {
    return await this.request('GET', `/accounts/${accountId}/pages/projects/${name}`)
  }

  /** 列出 Pages 项目 */
  async listPagesProjects(accountId: string): Promise<PagesProject[]> {
    return await this.request('GET', `/accounts/${accountId}/pages/projects`)
  }

  /**
   * 更新 Pages 项目的部署配置（KV 绑定 / 环境变量）。
   *
   * ⚠️ 顺序必须是「建项目 → 设变量/绑 KV → 最后才部署」：
   * Pages 的绑定与变量只对**之后的**部署生效，先部署再配置等于白配。
   */
  async updatePagesDeploymentConfig(
    accountId: string,
    name: string,
    production: PagesDeploymentConfig
  ): Promise<void> {
    await this.request('PATCH', `/accounts/${accountId}/pages/projects/${name}`, {
      deployment_configs: { production },
    })
  }

  /**
   * 上传 `_worker.js` 并触发部署。
   *
   * 直接调 Pages 部署 API（不经过 wrangler），避免 wrangler 二次打包改变产物。
   * 表单字段：branch / manifest / _worker.bundle（内含嵌套 multipart）。
   */
  async deployPagesWorker(
    accountId: string,
    name: string,
    options: { code: string; branch?: string }
  ): Promise<PagesDeployment> {
    // 内层：_worker.bundle 本身是一个 multipart，含 metadata + _worker.js
    const bundle = new FormData()
    bundle.set(
      'metadata',
      new Blob([JSON.stringify({ main_module: '_worker.js', bindings: {} })], {
        type: 'application/json',
      }),
      'metadata.json'
    )
    bundle.set(
      '_worker.js',
      new Blob([options.code], { type: 'application/javascript+module' }),
      '_worker.js'
    )
    const bundleRequest = new Request('https://placeholder.invalid', {
      method: 'POST',
      body: bundle,
    })

    // 外层：部署请求
    const form = new FormData()
    form.set('branch', options.branch ?? 'main')
    form.set('manifest', '{}')
    form.set(
      '_worker.bundle',
      new Blob([await bundleRequest.arrayBuffer()], {
        type: bundleRequest.headers.get('content-type') ?? 'multipart/form-data',
      }),
      '_worker.bundle'
    )

    return await this.request(
      'POST',
      `/accounts/${accountId}/pages/projects/${name}/deployments`,
      form
    )
  }

  /** 查询 Pages 部署状态 */
  async getPagesDeployments(accountId: string, name: string): Promise<PagesDeployment[]> {
    return await this.request('GET', `/accounts/${accountId}/pages/projects/${name}/deployments`)
  }

  /** 给 Pages 项目绑定自定义域名 */
  async addPagesDomain(accountId: string, name: string, domain: string): Promise<unknown> {
    return await this.request('POST', `/accounts/${accountId}/pages/projects/${name}/domains`, {
      name: domain,
    })
  }

  /** 删除 Pages 项目 */
  async deletePagesProject(accountId: string, name: string): Promise<void> {
    await this.request('DELETE', `/accounts/${accountId}/pages/projects/${name}`)
  }

  /**
   * 查询 Pages 项目当前部署的构建版本。
   *
   * 项目不存在、未部署、或跑的是旧版内核（无版本端点）时返回 null。
   * 用于「同版本跳过部署」。
   */
  async getPagesBuildVersion(accountId: string, name: string): Promise<string | null> {
    try {
      const project = await this.getPagesProject(accountId, name)
      const subdomain = project.subdomain
      if (!subdomain) return null
      const response = await fetch(`https://${subdomain}/__cfp_version`, {
        headers: { 'User-Agent': 'cfpilot-deploy' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null
      const body = (await response.json()) as { build?: string }
      return body.build ?? null
    } catch {
      return null
    }
  }
}
