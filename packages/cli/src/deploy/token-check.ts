/**
 * Cloudflare API Token 权限预检
 *
 * 目的：把 Cloudflare 那一长串「Account / Zone / Developer Platform」权限名，
 * 翻译成「部署向导到底需要什么、缺了会怎样」的人话。
 *
 * 探测策略（全部只读，不会改动账号）：
 *   - 账号：GET /accounts
 *   - 域名：GET /zones
 *   - KV：GET /accounts/{id}/storage/kv/namespaces
 *   - Workers 脚本：GET /accounts/{id}/workers/scripts
 *   - workers.dev 子域：GET /accounts/{id}/workers/subdomain
 *   - workers.dev 路由开关：GET /accounts/{id}/workers/scripts/{随机探测名}/subdomain
 *       · 403 → 缺 Workers 脚本权限
 *       · 404 → 权限正常（脚本不存在而已）
 *   - DNS：GET /zones/{zone}/dns_records
 *   - Routes：GET /zones/{zone}/workers/routes
 *   - Pages：GET /accounts/{id}/pages/projects
 *
 * 注意：列表类接口可读只代表具备 Read；真正部署还需要 Write 权限，
 * 因此表格里给出的是「缺失后果」，并在末尾提示写入类权限要求。
 *
 * ## ⚠️ 哪些权限是**部署真正必需**的
 *
 * 部署形态有两种，**权限集不同**：
 *
 * ### Pages 数据面（默认）
 *
 *   GET  /accounts                                   → Account Settings Read
 *   GET/POST/PUT  .../storage/kv/namespaces…         → Workers KV Storage Write
 *   GET/PUT/DELETE  .../pages/projects…              → Pages Write
 *
 * ### Workers 数据面（`--data-plane workers`）
 *
 * 在上面三项之外，还要：
 *
 *   GET/PUT  /accounts/{id}/workers/scripts…         → Workers Scripts Edit
 *   PUT      /accounts/{id}/workers/domains          → Workers Routes Edit（账号级）
 *   GET      /zones/{zone}/workers/routes            → Workers Routes Edit（域级）
 *   GET/POST /zones/{zone}/dns_records               → DNS Edit（自定义域名自动建记录）
 *
 * ⚠️ 后三项**只在 Workers 模式 + 自定义域名时**才必需。
 * 混在「可选」里会让 Workers 用户以为勾三项就够，结果是部署到一半撞 403。
 */
import {
  CloudflareClient,
  CloudflareError,
  type CloudflareAccount,
  type CloudflareZone,
} from './cf-api'
import { randomProbeScriptName } from './utils'

export type PermissionStatus = 'ok' | 'missing' | 'unknown'

export interface PermissionRow {
  /** 权限项（中文） */
  name: string
  /** 是否为部署必需 */
  required: boolean
  status: PermissionStatus
  /** 缺失后的实际后果 */
  consequence: string
  /** 探测细节（错误摘要等） */
  detail: string
  /** 修复建议（权限路径） */
  hint: string
}

export interface TokenCheckOptions {
  token: string
  accountId?: string
  zoneName?: string
  apiBase?: string
  timeoutMs?: number
  /**
   * 调用方是否明确要求绑定自定义域名。
   * 为 true 时 Zone / DNS / Routes 权限计入「必需」。
   */
  expectCustomDomain?: boolean
  /**
   * 是否要用 **Workers 数据面**（`--data-plane workers`）。
   *
   * 为 true 时额外要求 `Account / Workers Scripts / Edit` 与
   * `Account / Workers Routes / Edit` —— 这两项 Pages 部署完全用不到，
   * 混在「可选」里会让 Workers 用户以为勾三项就够了。
   */
  expectWorkers?: boolean
}

export interface TokenCheckResult {
  ok: boolean
  accounts: CloudflareAccount[]
  accountId: string
  accountName: string
  /** 实际用于探测的域名（未选择时为空） */
  zoneName: string
  /** 必需项中未通过的数量 */
  missing: number
  rows: PermissionRow[]
}

const STATUS_ICON: Record<PermissionStatus, string> = {
  ok: '✅',
  missing: '❌',
  unknown: '❓',
}

const STATUS_TEXT: Record<PermissionStatus, string> = {
  ok: '通过',
  missing: '缺失',
  unknown: '未知',
}

/** 把异常归类成「缺权限 / 未知」 */
function classifyError(err: unknown): { status: PermissionStatus; detail: string } {
  if (err instanceof CloudflareError) {
    if (err.status === 401 || err.status === 403) {
      return { status: 'missing', detail: `HTTP ${err.status}：${err.message}` }
    }
    return { status: 'unknown', detail: `HTTP ${err.status}：${err.message}` }
  }
  return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) }
}

/** 执行一次只读探测；成功时返回细节文案，失败时归类成权限状态 */
async function probePermission(
  run: () => Promise<string>
): Promise<{ status: PermissionStatus; detail: string }> {
  try {
    return { status: 'ok', detail: await run() }
  } catch (err) {
    return classifyError(err)
  }
}

function makeRow(
  name: string,
  required: boolean,
  consequence: string,
  hint: string,
  probe: { status: PermissionStatus; detail: string }
): PermissionRow {
  return { name, required, consequence, hint, status: probe.status, detail: probe.detail }
}

/** 计算终端显示宽度（中文 / 全角 / emoji 占 2 列） */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  return wide ? 2 : 1
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

function padDisplay(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`
}

/** 渲染三列表格：权限项 / 状态 / 缺失后果 */
export function renderPermissionTable(rows: PermissionRow[]): string {
  const header = ['权限项', '状态', '缺失后果']
  const body = rows.map((row) => {
    const name = `${row.name}${row.required ? '（必需）' : '（可选）'}`
    const status = `${STATUS_ICON[row.status]} ${STATUS_TEXT[row.status]}`
    return [name, status, row.consequence]
  })

  const widths = header.map((title, index) =>
    Math.max(
      displayWidth(title),
      ...body.map((cells) => displayWidth(cells[index] ?? ''))
    )
  )

  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, index) => padDisplay(cell, widths[index] ?? 0))
      .join('  ')
      .trimEnd()

  const lines = [formatRow(header), '─'.repeat(widths.reduce((sum, width) => sum + width, 0) + 4)]
  for (const cells of body) lines.push(formatRow(cells))
  return lines.join('\n')
}

/** 渲染完整的权限预检报告（表格 + 修复建议） */
export function renderTokenCheck(result: TokenCheckResult): string {
  const lines: string[] = []
  lines.push('Cloudflare API Token 权限预检')
  lines.push('='.repeat(72))
  lines.push(
    `账号：${result.accountName || '(未读取到)'}${
      result.accountId ? `（${result.accountId}）` : ''
    }`
  )
  if (result.zoneName) lines.push(`探测域名：${result.zoneName}`)
  lines.push('')
  lines.push(renderPermissionTable(result.rows))
  lines.push('')

  const failedRequired = result.rows.filter((row) => row.required && row.status !== 'ok')
  const failedOptional = result.rows.filter((row) => !row.required && row.status === 'missing')

  if (failedRequired.length > 0) {
    lines.push(`❌ ${failedRequired.length} 项必需权限未通过，部署大概率会失败：`)
    for (const row of failedRequired) {
      lines.push(`   · ${row.name}：${row.detail}`)
      lines.push(`     → 修复：${row.hint}`)
    }
  } else {
    lines.push('✅ 必需权限全部通过，可以开始部署。')
  }

  if (failedOptional.length > 0) {
    lines.push('')
    lines.push('⚠ 以下可选权限缺失（不影响部署，但会限制对应的降级能力）：')
    for (const row of failedOptional) {
      lines.push(`   · ${row.name}：${row.detail}`)
      lines.push(`     → 修复：${row.hint}`)
    }
  }

  lines.push('')
  lines.push('说明：列表类接口通过只代表具备读取权限；创建 / 修改类操作仍然需要 Edit 权限。')
  lines.push('提示：Zone / DNS / Routes 权限只影响**跨账号**自定义域名；同账号域名由 Cloudflare 自动建 DNS 记录。')
  return `${lines.join('\n')}\n`
}

/** 逐项探测 Token 权限 */
export async function checkTokenPermissions(
  options: TokenCheckOptions
): Promise<TokenCheckResult> {
  const client = new CloudflareClient({
    token: options.token,
    apiBase: options.apiBase,
    timeoutMs: options.timeoutMs,
  })
  const expectCustomDomain = options.expectCustomDomain ?? Boolean(options.zoneName)
  const rows: PermissionRow[] = []

  // 1) 账号读取：这是所有后续探测的前提
  let accounts: CloudflareAccount[] = []
  const accountProbe = await probePermission(async () => {
    accounts = await client.listAccounts()
    return `共 ${accounts.length} 个账号`
  })
  if (accountProbe.status !== 'ok') {
    rows.push(
      makeRow(
        '账号读取',
        true,
        '无法读取账号列表，部署流程无法开始',
        'Token 中添加 Account / Account Settings / Read',
        accountProbe
      )
    )
    return {
      ok: false,
      accounts: [],
      accountId: '',
      accountName: '',
      zoneName: '',
      missing: 1,
      rows,
    }
  }
  if (accounts.length === 0) {
    rows.push(
      makeRow(
        '账号读取',
        true,
        '该 Token 没有可访问的账号，部署无法开始',
        '确认 Token 属于正确的 Cloudflare 账号',
        { status: 'missing', detail: '账号列表为空' }
      )
    )
    return {
      ok: false,
      accounts: [],
      accountId: '',
      accountName: '',
      zoneName: '',
      missing: 1,
      rows,
    }
  }

  // 选定账号
  let account = accounts[0]!
  if (options.accountId) {
    const matched = accounts.find((item) => item.id === options.accountId)
    if (!matched) {
      throw new Error(`指定的账号 ${options.accountId} 不在该 Token 可见的账号列表中`)
    }
    account = matched
  }
  rows.push(
    makeRow(
      '账号读取',
      true,
      '无法读取账号列表，部署流程无法开始',
      'Token 中添加 Account / Account Settings / Read',
      { status: 'ok', detail: `账号：${account.name}（${account.id}）` }
    )
  )

  // 2) Token 元信息（仅展示，不影响部署）
  const tokenProbe = await probePermission(async () => {
    const verify = await client.verifyToken(account.id)
    const expiry = verify.expiresOn ? `，到期 ${verify.expiresOn}` : ''
    return `状态 ${verify.status}${expiry}`
  })
  rows.push(
    makeRow(
      'Token 元信息',
      false,
      '仅影响有效期展示，不影响部署',
      'account-owned Token（cfat_ 前缀）读不到元信息属正常现象，可忽略',
      tokenProbe
    )
  )

  // 3) 域名列表
  let zones: CloudflareZone[] = []
  const zoneProbe = await probePermission(async () => {
    zones = await client.listZones(options.zoneName)
    return zones.length === 0 ? '未匹配到域名' : `共 ${zones.length} 个域名`
  })
  let zoneRow = makeRow(
    '域名列表（Zone）',
    expectCustomDomain,
    expectCustomDomain
      ? '无法选择域名、无法绑定自定义域名，只能使用 workers.dev 地址'
      : '无法托管自定义域名（Pages 默认的 *.pages.dev 域名不受影响）',
    'Token 中添加 Zone / Zone / Read',
    zoneProbe
  )
  if (zoneProbe.status === 'ok' && zones.length === 0 && expectCustomDomain) {
    zoneRow = {
      ...zoneRow,
      status: 'missing',
      detail: options.zoneName ? `未找到域名 ${options.zoneName}` : '账号下没有已接入的域名',
    }
  }
  rows.push(zoneRow)

  // 4) KV 命名空间
  const kvProbe = await probePermission(async () => {
    const namespaces = await client.listKvNamespaces(account.id)
    return `共 ${namespaces.length} 个命名空间`
  })
  rows.push(
    makeRow(
      'Workers KV Storage',
      true,
      '无法创建 / 绑定 KV 命名空间，部署会中断',
      'Token 中添加 Account / Workers KV Storage / Write',
      kvProbe
    )
  )

  // 5) Workers 脚本
  const expectWorkers = options.expectWorkers ?? false
  const scriptsProbe = await probePermission(async () => {
    const scripts = await client.listScripts(account.id)
    return `共 ${scripts.length} 个脚本`
  })
  rows.push(
    makeRow(
      'Workers 脚本',
      expectWorkers,
      expectWorkers
        ? 'Workers 数据面无法上传脚本，部署会在第一步中断'
        : '不影响 Pages 部署（内核走 Pages 部署接口上传，不经过 Workers 脚本 API）',
      'Token 中添加 Account / Workers Scripts / Edit（仅 Workers 数据面需要）',
      scriptsProbe
    )
  )

  // 5.5) Workers 自定义域名（账号级 Workers Routes）
  //
  // 这一项与下面的「Worker Routes」不是同一件事：
  //   - 这里：PUT /accounts/{id}/workers/domains —— 绑 Worker 自定义域名
  //   - 下面：GET /zones/{zone}/workers/routes —— 老的 Route + CNAME 降级方案
  const workerDomainsProbe = await probePermission(async () => {
    const domains = await client.listWorkerDomains(account.id)
    return `共 ${domains.length} 个自定义域名绑定`
  })
  rows.push(
    makeRow(
      'Workers 自定义域名',
      expectWorkers && expectCustomDomain,
      expectWorkers && expectCustomDomain
        ? 'Workers 数据面绑不上域名 → 只能退到 *.workers.dev（直连不可访问，节点全部连不上）'
        : '不影响 Pages 部署（Pages 用 Pages 自己的域名绑定接口）',
      'Token 中添加 Account / Workers Routes / Edit（仅 Workers 数据面 + 自定义域名需要）',
      workerDomainsProbe
    )
  )

  // 6) workers.dev 子域读取
  const subdomainProbe = await probePermission(async () => {
    const subdomain = await client.getWorkersSubdomain(account.id)
    return subdomain ? `子域：${subdomain}` : '账号尚未注册 workers.dev 子域'
  })
  rows.push(
    makeRow(
      'workers.dev 子域读取',
      false,
      '不影响 Pages 部署（Pages 项目用自己的 *.pages.dev 域名）',
      'Workers 模式没配自定义域名（回落到 *.workers.dev）时才需要',
      subdomainProbe
    )
  )

  // 7) workers.dev 路由开关
  //
  // 用一个随机脚本名探测 GET .../subdomain：
  //   403 → 缺 Workers 脚本权限；
  //   404 → 权限正常（脚本不存在而已），这是 Cloudflare 的固定行为。
  const probeScript = randomProbeScriptName()
  let subdomainRouteProbe: { status: PermissionStatus; detail: string }
  try {
    const state = await client.getScriptSubdomain(account.id, probeScript)
    subdomainRouteProbe = {
      status: 'ok',
      detail: `探测脚本存在（enabled=${String(state.enabled)}）`,
    }
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) {
      subdomainRouteProbe = {
        status: 'ok',
        detail: '探测脚本不存在（HTTP 404）→ 说明具备 Workers 脚本权限',
      }
    } else {
      subdomainRouteProbe = classifyError(err)
    }
  }
  rows.push(
    makeRow(
      'workers.dev 路由开关',
      false,
      '不影响 Pages 部署（Pages 项目用自己的 *.pages.dev 域名）',
      'Workers 模式没配自定义域名（回落到 *.workers.dev）时才需要',
      subdomainRouteProbe
    )
  )

  // 7.5) Pages 权限（pages-split 必需）
  const pagesProbe = await probePermission(async () => {
    const projects = await client.listPagesProjects(account.id)
    return `共 ${projects.length} 个项目`
  })
  rows.push(
    makeRow(
      'Pages 项目',
      true,
      'pages-split 无法创建项目、配置变量与触发部署',
      'Token 中添加 Account / Pages / Write',
      pagesProbe
    )
  )

  // 8) / 9) DNS 与 Routes 需要先有域名
  const zone = zones[0]
  if (!zone) {
    const detail =
      zones.length === 0 && zoneProbe.status === 'ok'
        ? '账号下没有可用域名，未执行探测'
        : '未读取到域名，未执行探测'
    rows.push(
      makeRow(
        'DNS 记录',
        expectCustomDomain,
        '无法自行创建 CNAME 记录（跨账号自定义域名需手动加；同账号由 Cloudflare 自动建）',
        'Token 中添加 Zone / DNS / Edit',
        { status: 'unknown', detail }
      )
    )
    rows.push(
      makeRow(
        'Worker Routes',
        expectCustomDomain,
        'Pages 自定义域名无法降级到 Route + CNAME 方案',
        'Token 中添加 Zone / Workers Routes / Edit',
        { status: 'unknown', detail }
      )
    )
  } else {
    const dnsProbe = await probePermission(async () => {
      const records = await client.getDnsRecords(zone.id)
      return `域名 ${zone.name} 下共 ${records.length} 条记录`
    })
    rows.push(
      makeRow(
        'DNS 记录',
        expectCustomDomain,
        '无法自行创建 CNAME 记录（跨账号自定义域名需手动加；同账号由 Cloudflare 自动建）',
        'Token 中添加 Zone / DNS / Edit',
        dnsProbe
      )
    )

    const routesProbe = await probePermission(async () => {
      const routes = await client.listRoutes(zone.id)
      return `域名 ${zone.name} 下共 ${routes.length} 条路由`
    })
    rows.push(
      makeRow(
        'Worker Routes',
        expectCustomDomain,
        'Pages 自定义域名无法降级到 Route + CNAME 方案',
        'Token 中添加 Zone / Workers Routes / Edit',
        routesProbe
      )
    )
  }

  const missing = rows.filter((row) => row.required && row.status !== 'ok').length
  return {
    ok: missing === 0,
    accounts,
    accountId: account.id,
    accountName: account.name,
    zoneName: zone?.name ?? '',
    missing,
    rows,
  }
}
