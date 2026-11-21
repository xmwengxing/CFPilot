/**
 * 盲中继 / 云监测台「检测部署状态」（CLI 权威实现）。
 *
 * 与桌面版「部署 → 盲中继 / 云监测台 → 检测部署状态」同源，
 * Go 端对应 packages/desktop/internal/edge/detect.go（改一处必须同步另一处）。
 *
 * ## 只读约束
 *
 * 本文件**只发 GET 请求**（外加一次对域名 /health、/auth/status 的只读探测），
 * 绝不部署、不写 KV / DNS / Worker。检测永远不能改变线上状态。
 *
 * ## 识别规则
 *
 * 部署产物是「独立资源」，账号里没有可用的清单键可读，因此按**脚本绑定特征**识别：
 *   1. 脚本 settings 的 bindings 里有名为 MONITOR_TOKEN 的绑定（plain_text 或 secret_text）；
 *   2. 且至少满足其一：durable_object_namespace 且 class_name = MeshRoom、
 *      或 d1 绑定且 name = DB。
 * 名字里带 edge-relay / mobihop / relay 的脚本优先探测，其余随后（总量封顶）。
 */

import type {
  CloudflareClient,
  CloudflareZone,
  D1Database,
  PagesProject,
  ScriptBinding,
  WorkerDomain,
} from '../deploy/cf-api'

/** DO 类名（与部署侧一致，CLI/Go 同值） */
const DO_CLASS = 'MeshRoom'
/** 最多读取多少个脚本的 settings（每个一次 API 调用，避免账号大时刷爆请求） */
const MAX_SETTINGS_PROBES = 12

export interface EdgeRelayLimits {
  windowMs: string
  maxBytes: string
  maxPackets: string
  maxPeers: string
}

/** 一个已部署的盲中继实例（字段与桌面版 edge.Instance 对齐） */
export interface EdgeRelayInstance {
  workerName: string
  /** 自定义域名；未绑定为空串 */
  domain: string
  /** 对外根地址（域名优先，其次 workers.dev；都没有则为空） */
  workerUrl: string
  wssEndpoint: string
  zoneId: string
  zoneName: string
  dashboardProject: string
  dashboardUrl: string
  dashboardReady: boolean
  d1Name: string
  d1Uuid: string
  doClass: string
  /** 上报令牌（plain_text 可读；不可读时为空并附 warning） */
  monitorToken: string
  limits: EdgeRelayLimits
  /** 本机能否访问 /health */
  reachable: boolean
  /** 监测台是否已设置密码（/auth/status 的 setupRequired=false） */
  passwordSet: boolean
  warnings: string[]
}

export interface EdgeDetectProbeResult {
  reachable: boolean
  dashboardReady: boolean
  passwordSet: boolean
}

export interface EdgeDetectOptions {
  accountId: string
  /** 只关心某个域名（页面里已填的域名优先匹配） */
  domain?: string
  /** 只关心某个 Worker 名 */
  workerName?: string
  /** 是否做可达性探测（默认 true；离线排查时关掉） */
  probe?: boolean
  /** 测试注入点：默认实现探测根页面、/health 与 /auth/status */
  probeFn?: (baseUrl: string) => Promise<EdgeDetectProbeResult>
}

export interface EdgeDetectResult {
  instances: EdgeRelayInstance[]
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* 纯函数：识别与取值（单测直接覆盖这些）                               */
/* ------------------------------------------------------------------ */

/** 该脚本的 bindings 是否属于盲中继 Worker。 */
export function isEdgeRelayBindings(bindings: ScriptBinding[]): boolean {
  // 令牌既可能是 plain_text（部署默认），也可能被人改成 secret_text（值不可读）——
  // 两种都算「我们的脚本」，只是后者回填不了令牌（见 readPlainText 的调用点）。
  const hasToken = bindings.some(
    (b) => b.name === 'MONITOR_TOKEN' && (b.type === 'plain_text' || bindingType(b) === 'secret_text')
  )
  const hasRoom =
    bindings.some(
      (b) => b.type === 'durable_object_namespace' && (b.name === 'MESH_ROOM' || b.class_name === DO_CLASS)
    ) || bindings.some((b) => b.type === 'd1' && b.name === 'DB')
  return hasToken && hasRoom
}

/** 取绑定的 type 字段（ScriptBinding 的联合类型没覆盖 secret_text）。 */
function bindingType(b: ScriptBinding): string {
  return typeof (b as { type?: unknown }).type === 'string' ? String((b as { type: string }).type) : ''
}

/** 读取 plain_text 绑定值（不存在返回空串）。 */
export function readPlainText(bindings: ScriptBinding[], name: string): string {
  const hit = bindings.find((b) => b.type === 'plain_text' && b.name === name)
  return typeof hit?.text === 'string' ? hit.text : ''
}

/** 读取 D1 绑定指向的库 UUID（不存在返回空串）。 */
export function readD1BindingID(bindings: ScriptBinding[]): string {
  const hit = bindings.find((b) => b.type === 'd1' && b.name === 'DB')
  return typeof hit?.id === 'string' ? hit.id : ''
}

/** 从脚本 settings 里解出 bindings（结构不符返回空数组）。 */
export function settingsBindings(settings: unknown): ScriptBinding[] {
  if (!settings || typeof settings !== 'object') return []
  const raw = (settings as { bindings?: unknown }).bindings
  if (!Array.isArray(raw)) return []
  return raw.filter((b): b is ScriptBinding => !!b && typeof b === 'object' && typeof (b as { name?: unknown }).name === 'string')
}

/** 名字是否像盲中继脚本（用于决定探测优先级，不作为识别依据）。 */
export function looksLikeRelayScript(name: string): boolean {
  return /(edge[-_]?relay|mobihop|relay)/i.test(name)
}

/** 按最长后缀匹配域名所属 zone。 */
export function matchZone(domain: string, zones: CloudflareZone[]): CloudflareZone | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!d) return null
  let best: CloudflareZone | null = null
  for (const z of zones) {
    const name = (z.name || '').trim().toLowerCase().replace(/\.$/, '')
    if (!name) continue
    if (d === name || d.endsWith('.' + name)) {
      if (!best || name.length > best.name.length) best = z
    }
  }
  return best
}

/** 选脚本的自定义域名（启用优先，其次按名字排序保证结果稳定）。 */
export function pickWorkerDomain(domains: WorkerDomain[], workerName: string): string {
  const hits = domains
    .filter((d) => d.service === workerName && d.hostname)
    .sort((a, b) => {
      const ae = a.enabled === false ? 1 : 0
      const be = b.enabled === false ? 1 : 0
      if (ae !== be) return ae - be
      return a.hostname.localeCompare(b.hostname)
    })
  return hits[0]?.hostname || ''
}

/** 找监测面板 Pages 项目：先精确 `<worker>-dashboard`，再按 dashboard/monitor 命名兜底。 */
export function pickDashboardProject(
  projects: PagesProject[],
  workerName: string
): { project: string; guessed: boolean } {
  const exact = projects.find((p) => p.name === `${workerName}-dashboard`)
  if (exact) return { project: exact.name, guessed: false }
  const fuzzy = projects.filter((p) => /(dashboard|monitor)/i.test(p.name || ''))
  if (fuzzy.length === 1) return { project: fuzzy[0]!.name, guessed: true }
  return { project: '', guessed: false }
}

/** 探测优先级：域名匹配最优先，其次名字像盲中继，最后其它。 */
export function rankScriptNames(names: string[], workerName: string): string[] {
  const wanted = (workerName || '').trim()
  return [...names].sort((a, b) => {
    const score = (n: string): number => {
      if (wanted && n === wanted) return 0
      if (looksLikeRelayScript(n)) return 1
      return 2
    }
    const sa = score(a)
    const sb = score(b)
    if (sa !== sb) return sa - sb
    return a.localeCompare(b)
  })
}

/* ------------------------------------------------------------------ */
/* 默认可达性探测                                                       */
/* ------------------------------------------------------------------ */

async function probeRelay(baseUrl: string): Promise<EdgeDetectProbeResult> {
  const out: EdgeDetectProbeResult = { reachable: false, dashboardReady: false, passwordSet: false }
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(6000) })
    if (!health.ok) return out
    out.reachable = true
  } catch {
    return out
  }
  try {
    const root = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(6000) })
    const contentType = root.headers.get('content-type') || ''
    if (root.ok && /text\/html/i.test(contentType)) {
      const html = await root.text()
      out.dashboardReady = /<!doctype\s+html|<html\b/i.test(html)
    }
  } catch {
    /* 首页探测失败只代表监测台未确认，不影响 Worker API 可达状态 */
  }
  try {
    const status = await fetch(`${baseUrl}/auth/status`, { signal: AbortSignal.timeout(6000) })
    if (status.ok) {
      const body = (await status.json()) as { setupRequired?: boolean }
      out.passwordSet = body.setupRequired === false
    }
  } catch {
    /* /auth/status 失败不影响「可达」结论 */
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export async function detectEdgeRelay(
  client: CloudflareClient,
  opts: EdgeDetectOptions
): Promise<EdgeDetectResult> {
  const warnings: string[] = []
  const accountId = opts.accountId
  const probeFn = opts.probeFn ?? probeRelay
  const doProbe = opts.probe !== false

  // ---- 1. 脚本列表（权限不足时直接失败：这时「没检测到」是假象） ----
  let names: string[] = []
  try {
    names = await client.listScripts(accountId)
  } catch (err) {
    throw new Error(
      `读取 Worker 脚本列表失败（需要 Workers Scripts / Read 权限）：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  if (!Array.isArray(names)) names = []

  // ---- 2. 账号级资源（任一失败只记 warning，不中断检测） ----
  let domains: WorkerDomain[] = []
  try {
    domains = await client.listWorkerDomains(accountId)
  } catch (err) {
    warnings.push(`读取 Worker 域名绑定失败：${err instanceof Error ? err.message : String(err)}`)
  }
  let d1List: D1Database[] = []
  try {
    d1List = await client.listD1Databases(accountId)
  } catch (err) {
    warnings.push(`读取 D1 数据库列表失败：${err instanceof Error ? err.message : String(err)}`)
  }
  let projects: PagesProject[] = []
  try {
    projects = await client.listPagesProjects(accountId)
  } catch (err) {
    warnings.push(`读取 Pages 项目列表失败：${err instanceof Error ? err.message : String(err)}`)
  }
  let zones: CloudflareZone[] = []
  try {
    zones = await client.listZones()
  } catch (err) {
    warnings.push(`读取 Zone 列表失败：${err instanceof Error ? err.message : String(err)}`)
  }
  let workersSubdomain = ''
  try {
    workersSubdomain = await client.getWorkersSubdomain(accountId)
  } catch {
    /* workers.dev 只作兜底展示，失败无所谓 */
  }

  // ---- 3. 逐个脚本读 settings，按绑定特征识别 ----
  const ranked = rankScriptNames(names, opts.workerName || '')
  const toProbe = ranked.slice(0, MAX_SETTINGS_PROBES)
  if (ranked.length > toProbe.length) {
    warnings.push(
      `账号下有 ${ranked.length} 个 Worker 脚本，只检查了前 ${toProbe.length} 个（优先名字像盲中继的）`
    )
  }

  const instances: EdgeRelayInstance[] = []
  for (const name of toProbe) {
    let bindings: ScriptBinding[]
    try {
      const settings = await client.getScriptSettings(accountId, name)
      bindings = settingsBindings(settings)
    } catch {
      // 单个脚本读不到 settings（权限 / 已删除竞态）不影响其它实例
      continue
    }
    if (!isEdgeRelayBindings(bindings)) continue

    const w: string[] = []
    const domain = pickWorkerDomain(domains, name)
    if (!domain) {
      w.push('未绑定自定义域名：workers.dev 生产链路被阻断，节点连不上')
    }
    const zone = matchZone(domain, zones)
    const dash = pickDashboardProject(projects, name)
    const d1ID = readD1BindingID(bindings)
    const d1 = d1List.find((db) => db.uuid === d1ID) ?? d1List.find((db) => db.name === `${name}-monitor`)
    if (!d1) w.push('没找到监测数据库（D1），监测台可能不可用')

    const monitorToken = readPlainText(bindings, 'MONITOR_TOKEN')
    if (!monitorToken) {
      w.push('上报令牌以 secret 存储或已被移除，无法回填 —— 请到 Worker 端核对 MONITOR_TOKEN')
    }

    let workerUrl = domain ? `https://${domain}` : ''
    if (!workerUrl && workersSubdomain) {
      workerUrl = `https://${name}.${workersSubdomain}.workers.dev`
    }

    let reachable = false
    let dashboardReady = false
    let passwordSet = false
    if (doProbe && domain) {
      try {
        const probe = await probeFn(workerUrl)
        reachable = probe.reachable
        dashboardReady = probe.dashboardReady
        passwordSet = probe.passwordSet
        if (!reachable) {
          w.push('本机访问不到该域名（可能需要代理），配置仍可回填')
        }
        if (reachable && !dashboardReady) {
          w.push('监测台未部署：盲中继根路径尚未返回监测页面')
        }
      } catch (err) {
        w.push(`可达性探测失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    instances.push({
      workerName: name,
      domain,
      workerUrl,
      wssEndpoint: domain ? `wss://${domain}/mesh/<network_hash>?peer_id=<16hex>` : '',
      zoneId: zone?.id || '',
      zoneName: zone?.name || '',
      dashboardProject: dash.project,
      dashboardUrl: dashboardReady ? workerUrl : '',
      dashboardReady,
      d1Name: d1?.name || '',
      d1Uuid: d1?.uuid || '',
      doClass: DO_CLASS,
      monitorToken,
      limits: {
        windowMs: readPlainText(bindings, 'WINDOW_MS'),
        maxBytes: readPlainText(bindings, 'MAX_BYTES_PER_WINDOW'),
        maxPackets: readPlainText(bindings, 'MAX_PACKETS_PER_WINDOW'),
        maxPeers: readPlainText(bindings, 'MAX_PEERS_PER_ROOM'),
      },
      reachable,
      passwordSet,
      warnings: w,
    })
  }

  // 用户指定了筛选条件时按它收窄（找不到就原样返回全部，由调用方提示）
  const wantedDomain = (opts.domain || '').trim().toLowerCase()
  const wantedWorker = (opts.workerName || '').trim()
  let filtered = instances
  if (wantedDomain || wantedWorker) {
    const hit = instances.filter(
      (i) =>
        (wantedDomain && i.domain.toLowerCase() === wantedDomain) ||
        (wantedWorker && i.workerName === wantedWorker)
    )
    if (hit.length > 0) filtered = hit
  }

  filtered.sort((a, b) => a.workerName.localeCompare(b.workerName))
  return { instances: filtered, warnings }
}

/** 把检测结果渲染成用户可读汇总（CLI 用；密码永不出现）。 */
export function formatEdgeDetectSummary(result: EdgeDetectResult): string {
  const lines: string[] = ['']
  if (result.instances.length === 0) {
    lines.push('没有检测到盲中继实例（该账号下暂无匹配的 Worker）。')
    lines.push('如果是刚部署但这里查不到：确认 Token 具备 Workers Scripts / Read 权限。')
  } else {
    lines.push(`检测到 ${result.instances.length} 个盲中继实例：`)
    result.instances.forEach((ins, i) => {
      const token = ins.monitorToken
        ? `${ins.monitorToken.slice(0, 8)}…（${ins.monitorToken.length} 位）`
        : '（不可读取）'
      lines.push('')
      lines.push(`[${i + 1}] ${ins.workerName}`)
      lines.push(`  域名:        ${ins.domain || '（未绑定自定义域名）'}`)
      lines.push(`  监测 API:    ${ins.workerUrl || '（未知）'}`)
      lines.push(`  WSS 端点:    ${ins.wssEndpoint || '（需先绑定域名）'}`)
      lines.push(`  Zone:        ${ins.zoneName ? `${ins.zoneName} (${ins.zoneId})` : '（未匹配）'}`)
      lines.push(`  监测台:      ${ins.dashboardReady ? ins.dashboardUrl : '未部署 / 根路径不可用'}`)
      lines.push(`  D1:          ${ins.d1Name || '（未找到）'}`)
      lines.push(`  上报令牌:    ${token}`)
      lines.push(
        `  可达性:      ${ins.reachable ? '可达' : '本机不可达'}` +
          ` · 监测台密码: ${ins.passwordSet ? '已设置' : '未设置 / 未知'}`
      )
      for (const w of ins.warnings) lines.push(`  提示:        ${w}`)
    })
  }
  if (result.warnings.length > 0) {
    lines.push('')
    lines.push('其它提示：')
    for (const w of result.warnings) lines.push(`  - ${w}`)
  }
  lines.push('')
  lines.push('说明：监测台密码只保存哈希，无法读取；需要重置请重新部署或在监测台里改密。')
  return lines.join('\n') + '\n'
}
