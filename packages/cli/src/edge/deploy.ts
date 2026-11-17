/**
 * 盲中继 / 云监测台部署编排（CLI 权威实现）。
 *
 * 产物全部是独立资源，不碰 CFPilot 代理内核：
 *   1. D1 数据库（动态创建 + 执行内置 schema）
 *   2. Worker 脚本（盲中继 + 监测 API；DO migration + D1 绑定 + vars + MONITOR_TOKEN secret）
 *   3. 可选自定义域名绑定
 *   4. /auth/setup 设置监测台初始密码
 *   5. Pages 监测面板（dashboard.html 替换 API 地址）
 *
 * 对应 Go 桌面版 packages/desktop/internal/edge/deploy.go（Phase 2 同源实现）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CloudflareClient,
  type ScriptBinding,
  type DoMigration,
} from '../deploy/cf-api'
import { EDGE_RELAY_SCHEMAS, splitSchemaSql } from '../deploy/edge-relay-schema'

const EDGE_RELAY_COMPAT_DATE = '2026-01-01'
const DEFAULT_DO_CLASS = 'MeshRoom'

export interface EdgeDeployOptions {
  accountId: string
  /** 盲中继 Worker 名 */
  workerName?: string
  /** 盲中继自定义域名（必填：*.workers.dev 国内被污染） */
  domain: string
  /** 监测台初始密码（≥8 位） */
  monitorPassword: string
  /** 监测上报令牌（MONITOR_TOKEN secret）；留空则自动生成 */
  monitorToken?: string
  /** 监测面板 Pages 项目名 */
  dashboardProject?: string
  /** 是否部署监测面板 */
  withDashboard?: boolean
  /** 限速/容量 vars（字符串值） */
  limits?: {
    windowMs?: string
    maxBytesPerWindow?: string
    maxPacketsPerWindow?: string
    maxPeersPerRoom?: string
  }
  /** zone ID（绑自定义域名时用；不传则按域名主域查） */
  zoneId?: string
  /** 进度回调 */
  onProgress?: (message: string) => void
}

export interface EdgeDeployResult {
  workerName: string
  workerUrl: string
  wssEndpoint: string
  d1Name: string
  d1Uuid: string
  doClass: string
  dashboardUrl: string | null
  monitorToken: string
  monitorPassword: string
}

function loadAsset(name: string): string {
  // dist/cli.js 运行时 __dirname 不可用（ESM），用 cwd 兜底：
  // CLI 从包根或仓库根启动，assets 相对包根。
  const candidates = [
    resolve(process.cwd(), 'assets', 'edge-relay', name),
    resolve(process.cwd(), 'packages', 'cli', 'assets', 'edge-relay', name),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8') } catch { /* 试下一个 */ }
  }
  throw new Error(`缺少内置资产 assets/edge-relay/${name}，请先运行 node scripts/build-edge-relay.mjs`)
}

function randomToken(bytes = 24): string {
  // 零依赖：用 WebCrypto（Node 18+ 全局可用）
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 监测台是否已完成初始化（setupRequired=false 表示已有密码） */
export async function isMonitorSetupDone(workerUrl: string): Promise<boolean> {
  const r = await fetch(`${workerUrl}/auth/status`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) return false
  const body = (await r.json()) as { setupRequired?: boolean }
  return body.setupRequired === false
}

/**
 * 从完整域名推断 zone（主域）：a.b.example.com → example.com。
 * 只作提示；真正的 zoneId 由调用方用 client.listZones 确认。
 */
export function zoneNameFromDomain(domain: string): string {
  const parts = domain.trim().toLowerCase().split('.').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('.') : domain
}

export async function deployEdgeRelay(
  client: CloudflareClient,
  opts: EdgeDeployOptions
): Promise<EdgeDeployResult> {
  const report = opts.onProgress ?? (() => {})
  const accountId = opts.accountId
  const workerName = (opts.workerName || 'mobihop-edge-relay').trim()
  const domain = opts.domain.trim()
  if (!domain) throw new Error('盲中继必须提供自定义域名（*.workers.dev 国内被污染）')
  if (opts.monitorPassword.length < 8) throw new Error('监测台密码至少 8 位')

  const workerCode = loadAsset('worker.js')
  const monitorToken = opts.monitorToken || randomToken()
  const d1Name = `${workerName}-monitor`

  // ---- 1. 动态创建 D1 + 执行 schema ----
  report('步骤 1/5：创建监测数据库（D1）')
  const db = await client.createD1Database(accountId, d1Name)
  report(`D1 已创建：${db.name} (${db.uuid.slice(0, 8)}…)，初始化 schema`)
  for (const schema of EDGE_RELAY_SCHEMAS) {
    for (const sql of splitSchemaSql(schema)) {
      try {
        await client.queryD1(accountId, db.uuid, sql)
      } catch (err) {
        throw new Error(`D1 schema 初始化失败（${sql.slice(0, 40)}…）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  report('D1 schema 初始化完成（5 条语句）')

  // ---- 2. 上传 Worker（DO migration + D1 绑定 + vars + secret） ----
  report('步骤 2/5：部署盲中继 Worker（含 Durable Objects 房间）')
  const bindings: ScriptBinding[] = [
    { name: 'DB', type: 'd1', id: db.uuid },
    { name: 'MESH_ROOM', type: 'durable_object_namespace', class_name: DEFAULT_DO_CLASS },
    { name: 'MONITOR_TOKEN', type: 'plain_text', text: monitorToken },
    { name: 'WINDOW_MS', type: 'plain_text', text: opts.limits?.windowMs ?? '1000' },
    { name: 'MAX_BYTES_PER_WINDOW', type: 'plain_text', text: opts.limits?.maxBytesPerWindow ?? '1048576' },
    { name: 'MAX_PACKETS_PER_WINDOW', type: 'plain_text', text: opts.limits?.maxPacketsPerWindow ?? '2000' },
    { name: 'MAX_PEERS_PER_ROOM', type: 'plain_text', text: opts.limits?.maxPeersPerRoom ?? '512' },
  ]
  // 声明式 DO exports（wrangler 4 默认路径，真机 2026-11-17 验证通过）：
  // 服务端新版解析器期望 exports 对象；旧 migrations 数组会报
  // "cannot unmarshal array into Metadata.migrations of type reader.ActorMigrations"。
  const doExports = {
    [DEFAULT_DO_CLASS]: { type: 'durable-object' as const, state: 'created' as const, storage: 'sqlite' as const },
  }
  try {
    await client.uploadScript(accountId, workerName, {
      mainModule: 'worker.js',
      code: workerCode,
      compatibilityDate: EDGE_RELAY_COMPAT_DATE,
      bindings,
      doExports,
    })
  } catch (err) {
    throw new Error(
      `盲中继 Worker 上传失败：${err instanceof Error ? err.message : String(err)}`
    )
  }
  report('Worker 已上传（Durable Objects 房间已就绪）')

  const workerUrl = `https://${domain}`
  const wssEndpoint = `wss://${domain}/mesh/<network_hash>?peer_id=<16hex>`

  // ---- 3. 绑自定义域名（可选） ----
  if (opts.zoneId) {
    report(`步骤 3/5：绑定自定义域名 ${domain}`)
    await client.attachCustomDomain(accountId, {
      hostname: domain,
      service: workerName,
      zoneId: opts.zoneId,
    })
    report('域名绑定已受理（需再校验真实可达）')
  } else {
    report('步骤 3/5：跳过域名绑定（请在 Cloudflare 控制台手动绑定，或提供 --zone-id）')
  }

  // ---- 4. 设置监测台初始密码 ----
  report('步骤 4/5：设置监测台初始密码')
  const setupResp = await fetch(`${workerUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: opts.monitorPassword }),
    signal: AbortSignal.timeout(15000),
  })
  if (!setupResp.ok) {
    const text = await setupResp.text().catch(() => '')
    // 已设置过密码（409 conflict）视为幂等成功
    if (setupResp.status !== 409) {
      throw new Error(`设置监测台密码失败（HTTP ${setupResp.status}）：${text.slice(0, 300)}`)
    }
    report('监测台已有密码，跳过初始化（幂等）')
  } else {
    report('监测台密码已设置')
  }

  // ---- 5. 部署 Pages 监测面板（可选） ----
  let dashboardUrl: string | null = null
  if (opts.withDashboard !== false) {
    const project = (opts.dashboardProject || `${workerName}-dashboard`).trim()
    report(`步骤 5/5：部署监测面板 Pages（${project}）`)
    // 面板以 ES module Worker 形式部署（Pages Direct Upload 的 manifest/hash 机制复杂，
    // 而面板本质是单页 HTML —— 包成 Worker 复用已验证的 deployPagesWorker，真机可用）。
    let dashWorkerCode = loadAsset('dashboard-worker.js')
    dashWorkerCode = dashWorkerCode.replace(/const DEFAULT_API = '[^']*'/, `const DEFAULT_API = '${workerUrl}'`)
    await deployDashboard(client, accountId, project, dashWorkerCode, report)
    dashboardUrl = `https://${project}.pages.dev`
    report(`监测面板已部署：${dashboardUrl}`)
  } else {
    report('步骤 5/5：跳过监测面板部署')
  }

  return {
    workerName,
    workerUrl,
    wssEndpoint,
    d1Name: db.name,
    d1Uuid: db.uuid,
    doClass: DEFAULT_DO_CLASS,
    dashboardUrl,
    monitorToken,
    monitorPassword: opts.monitorPassword,
  }
}

/** 部署 Pages 监测面板（面板 = 返回 HTML 的 ES module Worker，复用 deployPagesWorker） */
async function deployDashboard(
  client: CloudflareClient,
  accountId: string,
  project: string,
  workerCode: string,
  report: (m: string) => void
): Promise<void> {
  try {
    await client.getPagesProject(accountId, project)
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined
    if (status === 404) {
      await client.createPagesProject(accountId, { name: project })
    } else {
      throw err
    }
  }
  await client.deployPagesWorker(accountId, project, { code: workerCode })
  report('面板 Worker 已上传')
}

/** 把部署结果渲染成用户可读汇总 */
export function formatEdgeDeploySummary(r: EdgeDeployResult): string {
  return [
    '',
    '================ 盲中继 / 云监测台部署完成 ================',
    `Worker 名称:      ${r.workerName}`,
    `监测 API:         ${r.workerUrl}`,
    `WSS 端点:         ${r.wssEndpoint}`,
    `D1 数据库:        ${r.d1Name} (${r.d1Uuid.slice(0, 8)}…)`,
    `Durable Object:   ${r.doClass}`,
    r.dashboardUrl ? `监测面板:         ${r.dashboardUrl}` : '监测面板:         （未部署）',
    `上报令牌:         ${r.monitorToken}`,
    `监测台密码:       ${r.monitorPassword}`,
    '',
    '请妥善保存上报令牌与密码：令牌/密码不会再次明文显示。',
    'WSS 域名需在 Cloudflare 控制台绑定自定义域后使用（*.workers.dev 国内不可达）。',
    '========================================================',
  ].join('\n')
}
