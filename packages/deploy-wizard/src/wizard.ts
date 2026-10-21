/**
 * 全中文部署向导
 *
 * 步骤：
 *   1. 校验 Cloudflare API Token
 *   2. 选择账号
 *   3. 生成纯随机 Worker 名称
 *   4. 自动创建并绑定 KV 命名空间
 *   5. 生成面板路径 / 管理密码 / 扫描令牌
 *   6. 上传内核，并开启 workers.dev 子域路由与 Workers Logs
 *   7. 绑定自定义域名，主动校验真实可访问性；失败自动降级 Route + CNAME，再失败降级 workers.dev
 *   8. 输出面板地址、订阅地址与扫描命令
 *
 * 设计原则：内核一旦上传成功，后续域名相关步骤全部「尽力而为」。
 * 任何一步失败都只降级并告警，绝不抛出 —— 否则用户连面板密码都看不到。
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  CloudflareClient,
  CloudflareError,
  type CloudflareZone,
  type DnsRecord,
  type ScriptBinding,
  type WorkerRoute,
} from './cf-api'
import { checkPanelAccess, checkWorkersDevAccess, type AccessCheckOptions } from './access-check'
import { randomPanelPath, randomPassword, randomWorkerName, randomHex } from './utils'

export interface DeployOptions {
  token?: string
  accountId?: string
  workerName?: string
  zoneName?: string
  /** 完整自定义域名，例如 cfpilot.example.com */
  hostname?: string
  kvTitle?: string
  /** 强制使用 workers.dev */
  workersDev?: boolean
  /** 非交互模式 */
  yes?: boolean
  dryRun?: boolean
  /**
   * 覆盖真实访问校验参数。
   * 生产环境不需要传（默认最多 3 次、间隔 4 秒）；测试里用它可以避免长时间等待。
   */
  accessCheckOptions?: AccessCheckOptions
}

/** 把错误拍成一行可读文本 */
function describeError(err: unknown): string {
  if (err instanceof CloudflareError) {
    return `${err.message}（HTTP ${err.status}${err.code ? ` / ${err.code}` : ''}）`
  }
  return err instanceof Error ? err.message : String(err)
}

export interface DeployResult {
  accountId: string
  workerName: string
  kvId: string
  panelPath: string
  panelPassword: string
  scannerToken: string
  url: string
  /** 本地优选器 --host 使用的主机名（自定义域名或 workers.dev 域名） */
  scannerHost: string
  subscriptionUrl: string
  mode: 'custom-domain' | 'workers.dev'
  /** workers.dev 子域路由是否已开启 */
  workersDevEnabled: boolean
  /** Workers Logs 是否已开启 */
  observabilityEnabled: boolean
  /** 部署过程中的非阻断告警，最后统一打印 */
  warnings: string[]
}

const COMPATIBILITY_DATE = '2026-01-01'

/** Workers Logs（observability）设置：全量采样，排障时才能看到日志 */
const OBSERVABILITY_SETTINGS = {
  observability: {
    enabled: true,
    head_sampling_rate: 1,
  },
}

/** 真实访问校验参数：最多 3 次、间隔 4 秒，总计约 10 秒 */
const ACCESS_CHECK_OPTIONS: AccessCheckOptions = {
  timeoutMs: 10000,
  attempts: 3,
  intervalMs: 4000,
}

function line(text = ''): void {
  stdout.write(`${text}\n`)
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const suffix = fallback ? ` [${fallback}]` : ''
    const answer = (await rl.question(`${question}${suffix}: `)).trim()
    return answer || fallback
  } finally {
    rl.close()
  }
}

async function askChoice(question: string, options: string[]): Promise<number> {
  options.forEach((option, index) => line(`  ${index + 1}) ${option}`))
  for (;;) {
    const answer = (await ask(`${question} [1-${options.length}]`, '1')).trim()
    const index = Number(answer)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return index - 1
    line('  请输入列表中的序号。')
  }
}

/** 读取内置内核资产（dist/../assets/cfpilot-worker.js） */
export async function loadWorkerAsset(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../assets/cfpilot-worker.js'),
    resolve(here, '../../assets/cfpilot-worker.js'),
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      /* 尝试下一个路径 */
    }
  }
  throw new Error(
    '未找到内核资产 assets/cfpilot-worker.js，请在 monorepo 中执行 npm run build -w @cfpilot/worker-core'
  )
}

/**
 * 检查目标主机名上是否已存在 DNS 记录。
 *
 * 已有 A/AAAA/CNAME 记录会与 Worker 自定义域名 / Route 冲突，导致 522 / 1016；
 * 这里只做提示，不自动删除（用户的记录可能还给别的服务用）。
 * Token 缺少 DNS 读权限时静默跳过，不影响部署。
 */
async function reportDnsConflicts(
  client: CloudflareClient,
  zone: CloudflareZone,
  hostname: string
): Promise<void> {
  let records: DnsRecord[]
  try {
    records = await client.getDnsRecords(zone.id, hostname)
  } catch (err) {
    if (err instanceof CloudflareError && (err.status === 403 || err.code === 10000)) {
      line('· 无法读取 DNS 记录（Token 缺 Zone → DNS → Read），已跳过冲突检测')
    } else {
      line(`· DNS 冲突检测失败（不影响部署）：${describeError(err)}`)
    }
    return
  }

  if (records.length === 0) {
    line(`· ${hostname} 当前没有冲突 DNS 记录`)
    return
  }

  line(`⚠ 检测到 ${hostname} 已存在 ${records.length} 条 DNS 记录：`)
  for (const record of records) {
    const proxied =
      typeof record.proxied === 'boolean' ? (record.proxied ? '，已代理' : '，仅 DNS') : ''
    line(
      `   · ${record.type} ${record.name} → ${record.content}（id: ${record.id}${proxied}）`
    )
  }
  line('  这些记录可能与 Worker 自定义域名冲突并导致 522 / 1016，建议先删除再部署：')
  line('   · 控制台：进入你的域名 → DNS → 删除上述记录')
  line(
    `   · API：DELETE https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records/<记录ID>（需 Zone → DNS → Edit）`
  )
  line('   · 如果该主机名还要给其他服务使用，请改用 --domain <其他子域名>。')
}

interface RouteFallbackParams {
  client: CloudflareClient
  zone: CloudflareZone
  hostname: string
  workerName: string
  workersSubdomain: string
}

/**
 * Route + CNAME 降级方案。
 *
 * 自定义域名接口返回成功但实际 522 时使用：
 *   1. 在 zone 里为 hostname 建一条代理 CNAME 指向 <worker>.<sub>.workers.dev
 *   2. 建一条 `<hostname>/*` 的 Worker Route
 * 任何一步失败都返回 false，由调用方继续降级到 workers.dev。
 */
async function tryRouteFallback(params: RouteFallbackParams): Promise<boolean> {
  const { client, zone, hostname, workerName, workersSubdomain } = params
  const pattern = `${hostname}/*`
  let ok = true

  // 1) CNAME
  if (!workersSubdomain) {
    ok = false
    line('⚠ 未读取到 workers.dev 子域，无法创建 CNAME')
    line('  → 请确认账号已开通 workers.dev（控制台 → Workers → 你的子域）')
  } else {
    const target = `${workerName}.${workersSubdomain}.workers.dev`
    try {
      const records = await client.getDnsRecords(zone.id, hostname)
      const existing = records.find((record) => record.name === hostname)
      if (!existing) {
        await client.createDnsRecord(zone.id, {
          type: 'CNAME',
          name: hostname,
          content: target,
          proxied: true,
        })
        line(`✓ 已创建 CNAME：${hostname} → ${target}（已代理）`)
      } else if (existing.type === 'CNAME' && existing.content === target && existing.proxied !== false) {
        line(`· 已存在匹配的 CNAME：${hostname} → ${target}`)
      } else if (existing.proxied === true) {
        // 已有代理记录（A/AAAA 或指向别处的 CNAME）时，Worker Route 会优先接管该主机名，
        // 不需要再创建 CNAME；只要记录是「已代理」状态即可。
        line(
          `· ${hostname} 已有代理记录（${existing.type} → ${existing.content}），Route 可以直接接管，无需 CNAME`
        )
      } else {
        ok = false
        line(
          `⚠ ${hostname} 已存在冲突 DNS 记录：${existing.type} ${existing.name} → ${existing.content}（id: ${existing.id}，未代理）`
        )
        line('  → 请先在 Cloudflare 控制台删除该记录，或改用 --domain <其他子域> 重新部署')
      }
    } catch (err) {
      ok = false
      line(`⚠ 创建 CNAME 失败：${describeError(err)}`)
      line('  → 需要 Zone → DNS → Edit 权限')
    }
  }

  // 2) Worker Route
  let routes: WorkerRoute[] = []
  try {
    routes = await client.listRoutes(zone.id)
  } catch {
    // 读不到路由列表时仍然尝试创建，真正的权限问题会在 createRoute 上报出
    routes = []
  }
  const matched = routes.find((route) => route.pattern === pattern)
  if (matched && matched.script === workerName) {
    line(`· 已存在匹配的 Route：${pattern}`)
  } else {
    try {
      await client.createRoute(zone.id, { pattern, script: workerName })
      line(`✓ 已创建 Route：${pattern} → ${workerName}`)
    } catch (err) {
      ok = false
      line(`⚠ 创建 Route 失败：${describeError(err)}`)
      if (err instanceof CloudflareError && err.status === 403) {
        line(
          '  → Token 缺 Zone → Workers Routes → Edit；请到 Token 编辑页勾选「Zone → Workers Routes → Edit」后重试。'
        )
      } else {
        line('  → 需要 Zone → Workers Routes → Edit 权限')
      }
    }
  }

  return ok
}

interface BindDomainParams {
  client: CloudflareClient
  accountId: string
  zone: CloudflareZone
  hostname: string
  workerName: string
  workersSubdomain: string
  panelPath: string
  accessOptions?: AccessCheckOptions
}

interface BindDomainOutcome {
  ok: boolean
  /** 过程中产生的非阻断告警，交给调用方汇总打印 */
  notes: string[]
}

/**
 * 绑定自定义域名并校验真实可访问性。
 *
 * 关键点：PUT /workers/domains 返回 200 + enabled:true 不代表访问正常，
 * 必须主动 GET https://{hostname}{panelPath} 校验，失败再降级 Route + CNAME。
 */
async function bindCustomDomain(params: BindDomainParams): Promise<BindDomainOutcome> {
  const {
    client,
    accountId,
    zone,
    hostname,
    workerName,
    workersSubdomain,
    panelPath,
    accessOptions,
  } = params
  const notes: string[] = []
  const checkOptions: AccessCheckOptions = { ...ACCESS_CHECK_OPTIONS, ...accessOptions }

  await reportDnsConflicts(client, zone, hostname)

  let attachFailed = false
  let domainId = ''
  try {
    const domain = await client.attachCustomDomain(accountId, {
      hostname,
      service: workerName,
      zoneId: zone.id,
    })
    domainId = domain?.id ?? ''
    line(`✓ 已绑定自定义域名：${hostname}`)
  } catch (err) {
    attachFailed = true
    const message = `自定义域名绑定失败：${describeError(err)}`
    notes.push(message)
    line(`⚠ ${message}`)
  }

  if (!attachFailed) {
    line('正在校验自定义域名真实可访问性（最多 3 次，约 10 秒）…')
    const access = await checkPanelAccess(hostname, panelPath, checkOptions)
    if (access.ok) {
      line(`✓ 自定义域名访问正常（${access.detail}）`)
      return { ok: true, notes }
    }
    attachFailed = true
    const message = `自定义域名绑定成功但访问失败：${access.detail}`
    notes.push(message)
    line(`⚠ ${message}`)
    line('  这正是「接口返回成功、实际仍是 522」的典型情况，正在自动降级为 Route + CNAME 方案…')
  }

  // 清理失效的自定义域名绑定，避免它与后面的 Route 争抢同一个 hostname
  if (domainId) {
    try {
      await client.deleteWorkerDomain(accountId, domainId)
      line('· 已解除失效的自定义域名绑定')
    } catch (err) {
      line(`· 解除自定义域名绑定失败（继续尝试 Route）：${describeError(err)}`)
    }
  }

  const fallbackOk = await tryRouteFallback({
    client,
    zone,
    hostname,
    workerName,
    workersSubdomain,
  })
  if (!fallbackOk) {
    const message = 'Route + CNAME 降级也未完成'
    notes.push(message)
    line(`⚠ ${message}`)
    return { ok: false, notes }
  }

  line('正在复检 Route + CNAME 生效情况…')
  const recheck = await checkPanelAccess(hostname, panelPath, checkOptions)
  if (recheck.ok) {
    line(`✓ Route + CNAME 生效，自定义域名访问正常（${recheck.detail}）`)
    return { ok: true, notes }
  }

  const message = `Route + CNAME 已创建但访问仍失败：${recheck.detail}`
  notes.push(message)
  line(`⚠ ${message}`)
  return { ok: false, notes }
}

/** 执行部署 */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const interactive = !options.yes
  const token =
    options.token ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CF_API_TOKEN ||
    (interactive ? await ask('请输入 Cloudflare API Token') : '')

  if (!token) throw new Error('缺少 API Token')

  const client = new CloudflareClient({ token })
  const warnings: string[] = []
  line('正在校验 API Token…')

  // 1) 账号
  //
  // 读取账号列表本身就是 Token 是否可用的最可靠验证（而且后续部署必须用它），
  // 所以放在最前面。注意不能用 /user/tokens/verify 作为唯一门槛：
  // account-owned Token（cfat_ 前缀）在那个端点上必然返回 401。
  let accounts
  try {
    accounts = await client.listAccounts()
  } catch (err) {
    const reason = err instanceof CloudflareError ? err.message : String(err)
    throw new Error(
      `无法读取账号列表，请检查 Token 是否有效、是否具备账号权限：${reason}\n` +
        '  可通过 npx cfpilot-deploy token --check --token <TOKEN> 单独排查。'
    )
  }
  if (accounts.length === 0) throw new Error('该 Token 没有可访问的账号')

  let accountId = options.accountId
  if (!accountId) {
    if (interactive) {
      const index = await askChoice(
        '请选择要部署到的账号',
        accounts.map((a) => `${a.name}（${a.id}）`)
      )
      accountId = accounts[index]!.id
    } else {
      accountId = accounts[0]!.id
    }
  }
  const account = accounts.find((a) => a.id === accountId)
  line(`✓ 目标账号：${account?.name ?? accountId}`)

  // 2) Token 状态（仅作信息展示，失败不阻断）
  try {
    const verify = await client.verifyToken(accountId)
    const expiry = verify.expiresOn ? `，到期 ${verify.expiresOn}` : ''
    line(`✓ Token 有效（${verify.status}${expiry}）`)
  } catch {
    line('· 未读取到 Token 元信息（account-owned Token 常见），已通过账号列表确认可用')
  }

  // 3) Worker 名称（纯随机，不带项目特征）
  const workerName = options.workerName || randomWorkerName()
  line(`✓ Worker 名称：${workerName}`)

  // 4) KV 命名空间
  const kvTitle = options.kvTitle || `${workerName}-kv`
  let kvId = ''
  if (!options.dryRun) {
    line('正在创建 KV 命名空间…')
    const namespace = await client.createKvNamespace(accountId, kvTitle)
    kvId = namespace.id
    line(`✓ KV 命名空间：${kvTitle}（${kvId}）`)
  } else {
    kvId = 'dry-run-namespace-id'
    line('（dry-run：跳过 KV 创建）')
  }

  // 5) 面板凭证
  const panelPath = randomPanelPath()
  const panelPassword = randomPassword()
  const scannerToken = randomHex(24)
  line(`✓ 面板路径：${panelPath}`)
  line(`✓ 管理密码：${panelPassword}`)

  // 6) 域名准备
  let workersSubdomain = await client.getWorkersSubdomain(accountId).catch(() => '')
  let zones: CloudflareZone[] = []
  if (!options.workersDev) {
    try {
      zones = await client.listZones(options.zoneName)
    } catch (err) {
      line(`⚠ 无法读取域名列表：${describeError(err)}`)
      line('  → 将只使用 workers.dev 地址；如需自定义域名，请补 Zone → Zone → Read 权限')
    }
  }

  let hostname = options.hostname ?? ''
  let mode: 'custom-domain' | 'workers.dev' = 'workers.dev'
  let zone: CloudflareZone | undefined

  if (!options.workersDev && zones.length > 0) {
    if (!hostname) {
      if (interactive) {
        const index = await askChoice(
          '请选择要绑定的域名',
          zones.map((z) => `${z.name}（${z.id}）`)
        )
        const selected = zones[index]!
        const sub = await ask('请输入二级域名（不含主域名）', 'cfpilot')
        hostname = `${sub}.${selected.name}`
      } else {
        const first = zones[0]!
        hostname = `cfpilot.${first.name}`
      }
    }
    zone = zones.find((item) => hostname === item.name || hostname.endsWith(`.${item.name}`))
    if (zone) {
      mode = 'custom-domain'
    } else {
      line(`⚠ 域名 ${hostname} 不属于当前账号可管理的域名，将使用 workers.dev 地址`)
      line('  → 请确认 --zone 填写的是 Cloudflare 中已接入的主域名')
      hostname = ''
    }
  } else if (!options.workersDev && hostname) {
    line(`⚠ 账号下没有可用域名（或 Token 缺少 Zone 读取权限），无法绑定 ${hostname}`)
    hostname = ''
  }

  if (mode === 'workers.dev') {
    line('· 本次使用 workers.dev 地址，不绑定自定义域名')
  }

  // 7) 上传内核
  let workersDevEnabled = false
  let observabilityEnabled = false

  if (!options.dryRun) {
    const code = await loadWorkerAsset()
    const bindings: ScriptBinding[] = [
      { type: 'kv_namespace', name: 'KV', namespace_id: kvId },
      { type: 'plain_text', name: 'PANEL_PASSWORD', text: panelPassword },
      { type: 'plain_text', name: 'PANEL_PATH', text: panelPath },
      { type: 'plain_text', name: 'SCANNER_TOKEN', text: scannerToken },
    ]
    line('正在上传 Worker 内核…')
    await client.uploadScript(accountId, workerName, {
      mainModule: 'worker.js',
      code,
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
    })
    line('✓ 内核已上传')

    // 7.1) 开启 workers.dev 子域路由
    //
    // 这一步是「部署成功但访问显示 There is nothing here yet」的根因：
    // Worker 上传后 workers.dev 路由默认是关闭的，必须显式开启。
    try {
      await client.putScriptSubdomain(accountId, workerName, true)
      const state = await client.getScriptSubdomain(accountId, workerName).catch(() => null)
      workersDevEnabled = state ? state.enabled : true
      if (workersDevEnabled) {
        line('✓ 已开启 workers.dev 子域路由')
      } else {
        const message = 'workers.dev 子域开关仍为关闭状态，请在控制台手动开启'
        warnings.push(message)
        line(`⚠ ${message}`)
      }
    } catch (err) {
      const message = `开启 workers.dev 子域失败：${describeError(err)}`
      warnings.push(message)
      line(`⚠ ${message}`)
      line('  → Token 需要 Account → Workers Scripts → Edit；不影响自定义域名形式的部署')
    }

    // 7.2) 开启 Workers Logs（observability）
    //
    // 该接口只接受 multipart/form-data，JSON body 会返回 415。
    // 失败只告警，绝不阻断：日志是排障增强项，不是部署前提。
    try {
      await client.patchScriptSettings(accountId, workerName, OBSERVABILITY_SETTINGS)
      observabilityEnabled = true
      line('✓ 已开启 Workers Logs（observability，采样率 100%）')
    } catch (err) {
      const message = `开启 Workers Logs 失败：${describeError(err)}`
      warnings.push(message)
      line(`⚠ ${message}`)
      line('  → 不影响部署；可稍后在控制台 → Workers → 你的 Worker → Settings → Logs 手动开启')
    }

    // 7.3) 若一开始没读到 workers.dev 子域，开启路由后再补读一次
    if (!workersSubdomain) {
      workersSubdomain = await client.getWorkersSubdomain(accountId).catch(() => '')
      if (workersSubdomain) line(`· 已读取 workers.dev 子域：${workersSubdomain}`)
    }

    // 8) 绑定自定义域名（含真实访问校验与自动降级）
    if (mode === 'custom-domain' && hostname && zone) {
      const outcome = await bindCustomDomain({
        client,
        accountId,
        zone,
        hostname,
        workerName,
        workersSubdomain,
        panelPath,
        accessOptions: options.accessCheckOptions,
      })
      warnings.push(...outcome.notes)
      if (!outcome.ok) {
        mode = 'workers.dev'
        hostname = ''
        const message = '自定义域名未生效，已降级为 workers.dev 临时地址；可修复权限后重新执行 init'
        warnings.push(message)
        line(`⚠ ${message}`)
      }
    }

    // 9) 最终使用 workers.dev 时，再做一次真实访问校验
    if (mode === 'workers.dev') {
      const devHost = workersSubdomain ? `${workerName}.${workersSubdomain}.workers.dev` : ''
      if (!devHost) {
        const message = '未能读取账号的 workers.dev 子域，面板地址需要手动补全'
        warnings.push(message)
        line(`⚠ ${message}`)
        line('  → 请到控制台 → Workers 查看实际子域，或补 Workers Scripts → Read 权限后重跑')
      } else {
        line('正在校验 workers.dev 地址…')
        const access = await checkWorkersDevAccess(
          devHost,
          panelPath,
          options.accessCheckOptions
        )
        if (access.ok) {
          line(`✓ workers.dev 地址访问正常（${access.detail}）`)
        } else {
          const message = `workers.dev 地址暂不可访问：${access.detail}`
          warnings.push(message)
          line(`⚠ ${message}`)
          line('  → 新开启的 workers.dev 路由通常 10~60 秒生效；若持续失败，请到控制台确认该脚本的 routes 已开启')
        }
      }
    }
  } else {
    line('（dry-run：跳过上传、workers.dev 路由、Workers Logs 与域名绑定）')
  }

  const devHost = workersSubdomain
    ? `${workerName}.${workersSubdomain}.workers.dev`
    : `${workerName}.workers.dev`
  const scannerHost = mode === 'custom-domain' && hostname ? hostname : devHost

  return {
    accountId,
    workerName,
    kvId,
    panelPath,
    panelPassword,
    scannerToken,
    url: `https://${scannerHost}${panelPath}`,
    scannerHost,
    subscriptionUrl: `https://${scannerHost}/sub/<UUID>`,
    mode,
    workersDevEnabled,
    observabilityEnabled,
    warnings,
  }
}

/** 打印部署结果 */
export function printResult(result: DeployResult): void {
  line('')
  line('══════════════════════════════════════════════════')
  line('  CFPilot 部署完成 🎉')
  line('══════════════════════════════════════════════════')
  line(`  面板地址   ：${result.url}`)
  line(`  管理密码   ：${result.panelPassword}`)
  line(`  Worker 名  ：${result.workerName}`)
  line(`  KV 命名空间：${result.kvId}`)
  line(
    `  部署方式   ：${
      result.mode === 'custom-domain' ? `自定义域名（${result.scannerHost}）` : 'workers.dev 临时地址'
    }`
  )
  line(
    `  Workers Logs：${result.observabilityEnabled ? '已开启（采样 100%）' : '未开启（可在控制台手动开启）'}`
  )
  line(`  订阅地址   ：${result.subscriptionUrl}（把 <UUID> 换成面板里的 UUID）`)
  line('')
  line('  本地优选命令：')
  line(
    `  npx -y cfpilot-scanner@latest --host "${result.scannerHost}" --token "${result.scannerToken}"`
  )
  line('')
  if (result.warnings.length > 0) {
    line('  部署告警（不影响面板凭证，请按需处理）：')
    for (const warning of result.warnings) line(`   · ${warning}`)
    line('')
  }
  line('  提示：')
  line('   1. 请妥善保存管理密码；面板路径可随时更换。')
  line('   2. workers.dev 子域路由已在部署时自动开启；若浏览器仍显示 nothing here yet，等 10~60 秒再刷新。')
  line('   3. 自定义域名若出现 522，说明绑定未真正生效；重新执行 cfpilot-deploy init 会自动走 Route + CNAME 降级。')
  line('   4. 想升级内核？重新执行 cfpilot-deploy init 即可，KV 数据会保留。')
  line('')
}
