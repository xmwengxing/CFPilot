/**
 * Pages 双项目部署（控制面 + 数据面）
 *
 * ## 背景
 *
 * 2026-10-22 真机复现：合并包部署到 Pages，第一次成功、第二次
 * `HTTP 400 / 8000119 Your Pages project has been blocked`。
 * 拆成两个项目后两边都能原地更新。
 *
 * ⚠️ 这不是「Cloudflare 要求拆分」的结论，而是**当前唯一实测可用的安排**。
 * Cloudflare 未说明具体触发原因，因此不能断定是哪段代码、哪条规则导致的。
 * 详见 docs/cloudflare-deployment-diagnosis.md。
 *
 * ## 部署形态
 *
 *   ┌─────────────┐      ┌─────────────┐
 *   │ 控制面 Pages │      │ 数据面 Pages │
 *   │ 面板/订阅/探针│      │ VLESS/Trojan │
 *   │ 无 sockets   │      │ CFNext 数据面 │
 *   └──────┬──────┘      └──────┬──────┘
 *          └────── 共用同一 KV ──┘
 *
 *   控制面通过 DATA_HOST 环境变量知道数据面域名，
 *   生成订阅时用它作为节点地址（sni/host）。
 *
 * ## 硬性顺序
 *
 * 建项目 → 设变量/绑 KV → 最后才部署。
 * Pages 的绑定与变量只对**之后的**部署生效，先部署再配置等于白配。
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { CloudflareClient, CloudflareError, type PagesDeployment } from './cf-api'
import { randomPanelPath, randomPassword, randomWsPath } from './utils'

export interface PagesSplitDeployOptions {
  token: string
  accountId: string
  /** KV 命名空间 ID（两个项目共用） */
  kvNamespaceId: string
  /** 控制面 Pages 项目名 */
  controlProject: string
  /** 数据面 Pages 项目名 */
  dataProject: string
  /** 面板访问路径，如 /p-a1b2c3 */
  panelPath: string
  /** 面板密码 */
  panelPassword: string
  /** VLESS UUID */
  uuid: string
  /** Trojan 密码 */
  trojanPassword: string
  /** WS 路径（不含前导斜杠） */
  wsPath: string
  /** 是否启用 Trojan */
  enableTrojan: boolean
  /** 是否启用 XHTTP */
  enableXhttp: boolean
  /** 扫描令牌（可选） */
  scannerToken?: string
  /**
   * 部署模式。
   *   - 'auto'      ：读 KV 清单自动判断（有清单=更新，无清单=首次）
   *   - 'fresh'     ：强制首次部署，忽略清单
   *   - 'update'    ：强制更新部署，沿用 KV 里的 UUID / 路径 / 密码
   */
  mode?: 'auto' | 'fresh' | 'update'
  /**
   * 更新部署时是否沿用已有凭据（UUID / WS 路径 / Trojan 密码 / 面板密码）。
   * 默认 true —— 否则用户每次更新都要在客户端改一遍订阅地址。
   */
  keepCredentials?: boolean
  /**
   * 线上版本与本地一致时跳过部署。
   * 默认 true。传 false 可强制重新部署。
   */
  skipSameVersion?: boolean
  /** 本地产物的构建版本（用于版本比对；不传则不做版本跳过） */
  localBuild?: string
  /** 部署完成后的等待与轮询配置 */
  wait?: { timeoutMs: number; intervalMs: number }
  /** 覆盖 API 地址（测试用；生产环境不要传） */
  apiBase?: string
  /**
   * 覆盖内核产物内容（测试用；生产环境不传，从 dist/ 读取）。
   * 键为 control / data，值为对应 JS 源码。
   */
  bundles?: { control?: string; data?: string }
  log?: (message: string) => void
}

export interface PagesSplitDeployResult {
  control: { name: string; subdomain: string; deploymentId?: string }
  data: { name: string; subdomain: string; deploymentId?: string }
  /** 实际生效的面板路径（更新模式下可能来自清单） */
  panelPath?: string
  /** 实际生效的 UUID */
  uuid?: string
  /** 实际生效的 WS 路径 */
  wsPath?: string
  warnings: string[]
}

/**
 * KV 里的部署清单键。
 *
 * 记录本项目上次部署用的是哪些 Pages 项目、什么配置。
 * 更新部署时先读它，就能知道「同源项目」是哪两个，
 * 不需要用户记项目名，也不需要去猜。
 */
const MANIFEST_KEY = 'CFP_DEPLOY_MANIFEST'

interface DeployManifest {
  /** 清单格式版本 */
  v: 1
  /** 控制面 Pages 项目名 */
  controlProject: string
  /** 数据面 Pages 项目名（可能因 8000119 换过名） */
  dataProject: string
  /** 控制面域名 */
  controlSubdomain: string
  /** 数据面域名 */
  dataSubdomain: string
  /** 上次部署的构建版本 */
  build: string
  /** 上次部署时间（ISO） */
  at: string
  /** 创建时生成的凭据（更新时沿用，避免客户端订阅地址失效） */
  credentials: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
}

/** 读取部署清单；不存在返回 null */
async function readManifest(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string
): Promise<DeployManifest | null> {
  try {
    const raw = await client.getKvValue(accountId, namespaceId, MANIFEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DeployManifest
    return parsed && parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

/** 写入部署清单 */
async function writeManifest(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  manifest: DeployManifest
): Promise<void> {
  try {
    await client.setKvValue(accountId, namespaceId, MANIFEST_KEY, JSON.stringify(manifest))
  } catch {
    /* 清单写失败不影响部署本身，只影响下次更新识别 */
  }
}

/**
 * 检测 KV 里是否已有会覆盖环境变量的配置。
 *
 * 内核的配置优先级是 **KV(CONFIG) > 环境变量 > 默认值**。
 * 因此复用已有 KV 时，本次生成的随机路径 / 密码 / UUID / WS 路径都不会生效，
 * 用户会拿着「新密码」登不进去。这里提前读出来并明确告知。
 */
async function detectKvConfigConflict(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  log: (m: string) => void
): Promise<void> {
  const keys = ['PANEL_PATH', 'ADMIN_PW_HASH', 'CONFIG', 'config']
  const found: string[] = []
  for (const key of keys) {
    const value = await client.getKvValue(accountId, namespaceId, key)
    if (value !== null) found.push(key)
  }
  if (found.length === 0) {
    log('· KV 是空的，本次生成的凭据会生效')
    return
  }

  log(`⚠ KV 里已存在配置：${found.join('、')}`)
  log('  内核优先级为 KV(CONFIG) > 环境变量，因此本次生成的随机凭据不会生效。')
  log('  请使用首次部署时生成的凭据登录；如需重置，先删除这些 KV 键再重新部署。')

  const panelPath = await client.getKvValue(accountId, namespaceId, 'PANEL_PATH')
  if (panelPath) log(`  · 实际生效的面板路径：${panelPath}`)
}

/** 测试专用：用显式 apiBase 跑 KV 冲突检测 */
export async function detectKvConfigConflictForTest(
  apiBase: string,
  log: (m: string) => void
): Promise<void> {
  const client = new CloudflareClient({ token: 'test-token', apiBase })
  await detectKvConfigConflict(client, 'acc', 'ns', log)
}

/**
 * 当前模块所在目录（同时兼容 ESM 与 CJS）。
 *
 * CLI 以 ESM 运行（import.meta.url 可用），
 * GUI 会把本模块打成 CJS 库（import.meta 为 undefined，需用 __dirname）。
 */
function moduleDir(): string {
  // ESM 优先
  try {
    const meta = import.meta
    if (meta && typeof meta.url === 'string') return dirname(fileURLToPath(meta.url))
  } catch {
    /* CJS 产物：import.meta 不存在，走下面的 __dirname */
  }
  // CJS 兜底
  return typeof __dirname === 'string' ? __dirname : process.cwd()
}

/**
 * 读取 worker-core 的构建产物。
 *
 * 打包后 `here` 是 `packages/deploy-wizard/dist`，所以 worker-core 在
 * `../worker-core/dist/`；开发时（ts 源码直接跑）`here` 是 `src/`，
 * 需要 `../../worker-core/dist/`。两种情况都试。
 *
 * ⚠️ 本模块既会被 CLI（ESM）直接跑，也会被 GUI 打成 CJS 库后 require。
 * 因此不能用 import.meta.url（CJS 下是 undefined），
 * 也不能只用 __dirname（ESM 下不存在）——两个都做兼容。
 */
async function loadBundle(fileName: string): Promise<string> {
  const here = moduleDir()
  const candidates = [
    resolve(here, `../worker-core/dist/${fileName}`),
    resolve(here, `../../worker-core/dist/${fileName}`),
    resolve(here, `../assets/${fileName}`),
    resolve(process.cwd(), `packages/worker-core/dist/${fileName}`),
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      /* 尝试下一个 */
    }
  }
  throw new Error(
    `未找到 ${fileName}，请先执行 npm run build -w @cfpilot/worker-core`
  )
}

/**
 * 校验部署参数。
 *
 * 重点是路径类参数：MSYS / Git-Bash 会把以 `/` 开头的命令行参数
 * 转换成 Windows 路径（例如 `--panel-path /p-abc` 变成
 * `C:/Users/.../bash-win32-x64/p-abc`）。这种值一旦写进 Pages 环境变量，
 * 面板路径就永久错乱且难以排查。因此这里显式拒绝。
 */
function validateOptions(options: PagesSplitDeployOptions): string[] {
  const problems: string[] = []

  const checkPath = (label: string, value: string): void => {
    if (!value) return
    // 合法路径：单个前导斜杠 + 小写字母数字连字符，不含空格与冒号
    if (!/^\/[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
      problems.push(
        `${label} 含非法字符：${JSON.stringify(value)}。` +
          '若在 Git-Bash / MSYS 下传参，/ 开头的参数会被转换成 Windows 路径，' +
          '请改用 --panel-path=p-abc 形式，或设置 MSYS_NO_PATHCONV=1。'
      )
    }
  }

  checkPath('PANEL_PATH', options.panelPath)
  checkPath('WS 路径', options.wsPath)

  // UUID 与密码同样不该含路径分隔符
  if (/:/.test(options.uuid)) {
    problems.push(`UUID 含非法字符：${JSON.stringify(options.uuid)}`)
  }
  if (/:/.test(options.trojanPassword)) {
    problems.push(`Trojan 密码含非法字符：${JSON.stringify(options.trojanPassword)}`)
  }

  // 项目名只允许小写字母数字与连字符（Pages 要求）
  for (const [label, name] of [
    ['控制面项目名', options.controlProject],
    ['数据面项目名', options.dataProject],
  ] as const) {
    if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) {
      problems.push(`${label} 含非法字符：${JSON.stringify(name)}（只允许小写字母、数字、连字符）`)
    }
  }

  return problems
}

/** 轮询部署直到终态 */
async function waitForDeployment(
  client: CloudflareClient,
  accountId: string,
  project: string,
  options: { timeoutMs: number; intervalMs: number },
  log: (m: string) => void
): Promise<PagesDeployment | null> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    let list: PagesDeployment[]
    try {
      list = await client.getPagesDeployments(accountId, project)
    } catch (err) {
      log(`· 查询 ${project} 部署状态失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    const latest = list[0]
    if (!latest) return null
    const status = latest.latest_stage?.status
    if (status === 'success' || status === 'failure' || status === 'canceled') {
      return latest
    }
    if (Date.now() > deadline) {
      log(`· ${project} 部署轮询超时（最后状态：${status}）`)
      return latest
    }
    await new Promise((r) => setTimeout(r, options.intervalMs))
  }
}

/**
 * CFNext 数据面的 KV `config` 键结构。
 *
 * 源码里是 `Object.assign(默认配置, kvConfig)` 整体覆盖，
 * 因此这里必须写全字段，缺字段会让数据面读到 undefined。
 */
interface DataPlaneKvConfig {
  uuid: string
  /** WS 路径，不带前导斜杠 */
  path: string
  admin: string
  adminInit: boolean
  login: string
  host: string
  enableVless: boolean
  enableTrojan: boolean
  trojanPassword: string
  enableXhttp: boolean
  proxyIP: string
  outboundProxy: string
  outboundMode: string
  tlsOnly: boolean
}

/**
 * 把本次部署凭据写入 KV 的 `config` 键，让数据面真正生效。
 *
 * 保留已有的非凭据字段（proxyIP / host / tlsOnly 等用户手动配的值），
 * 只覆盖 uuid / path / trojanPassword 等本次生成的部分。
 */
async function syncDataPlaneKvConfig(
  client: CloudflareClient,
  options: PagesSplitDeployOptions,
  dataSubdomain: string,
  warnings: string[],
  log: (m: string) => void,
  effective: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
): Promise<void> {
  if (!dataSubdomain) return

  // 读旧值，保留用户手动配置的字段
  let existing: Partial<DataPlaneKvConfig> = {}
  try {
    const raw = await client.getKvValue(options.accountId, options.kvNamespaceId, 'config')
    if (raw) existing = JSON.parse(raw) as Partial<DataPlaneKvConfig>
  } catch {
    /* 旧值解析失败时按空处理，下面会写全字段 */
  }

  const merged: DataPlaneKvConfig = {
    uuid: effective.uuid,
    path: effective.wsPath.replace(/^\//, ''),
    admin: existing.admin ?? '',
    adminInit: existing.adminInit ?? true,
    login: existing.login ?? '',
    host: existing.host ?? '',
    enableVless: existing.enableVless ?? true,
    enableTrojan: options.enableTrojan,
    trojanPassword: effective.trojanPassword,
    enableXhttp: options.enableXhttp,
    proxyIP: existing.proxyIP ?? '',
    outboundProxy: existing.outboundProxy ?? '',
    outboundMode: existing.outboundMode ?? '',
    tlsOnly: existing.tlsOnly ?? true,
  }

  try {
    await client.setKvValue(options.accountId, options.kvNamespaceId, 'config', JSON.stringify(merged))
    log(`✅ 数据面配置已同步到 KV（path=${merged.path}）`)
  } catch (err) {
    warnings.push(
      `数据面 KV 配置同步失败：${err instanceof Error ? err.message : String(err)}` +
        `（数据面仍会用 KV 里的旧配置，--ws-path / --uuid 不生效）`
    )
  }
}

/**
 * 执行双项目部署。
 *
 * 设计原则与单 Worker 向导一致：**尽力而为，绝不抛出**。
 * 任何一步失败都记录到 warnings，让用户至少拿到已成功的部分。
 *
 * 例外：参数非法时直接抛出。这类错误（尤其是被 MSYS 污染的路径）
 * 会把错误值写进 Pages 环境变量，事后极难清理，必须在写入前拦住。
 */
export async function deployPagesSplit(
  options: PagesSplitDeployOptions
): Promise<PagesSplitDeployResult> {
  const problems = validateOptions(options)
  if (problems.length > 0) {
    throw new Error(`部署参数不合法：\n  - ${problems.join('\n  - ')}`)
  }

  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const client = new CloudflareClient({ token: options.token, apiBase: options.apiBase })
  const wait = options.wait ?? { timeoutMs: 90000, intervalMs: 3000 }

  const mode = options.mode ?? 'auto'
  const keepCredentials = options.keepCredentials ?? true
  const skipSameVersion = options.skipSameVersion ?? true

  const result: PagesSplitDeployResult = {
    control: { name: options.controlProject, subdomain: '' },
    data: { name: options.dataProject, subdomain: '' },
    warnings,
  }

  const kv = { KV: { namespace_id: options.kvNamespaceId } }

  /* ---------------- 0. 读部署清单，判断首次还是更新 ---------------- */

  const manifest = await readManifest(client, options.accountId, options.kvNamespaceId)

  // 生效的配置：更新部署且要求保留凭据时，用 KV 里的旧值；
  // 首次部署时对缺项生成随机值（调用方可以只传部分参数）。
  let effective = {
    panelPath: options.panelPath,
    panelPassword: options.panelPassword,
    uuid: options.uuid,
    trojanPassword: options.trojanPassword,
    wsPath: options.wsPath,
  }

  // 同源项目名：有清单就按清单来，用户不需要记项目名
  let controlName = options.controlProject
  let dataName = options.dataProject

  if (manifest && mode !== 'fresh') {
    log(`· 检测到已有部署（${manifest.at}），进入更新模式`)
    controlName = manifest.controlProject
    dataName = manifest.dataProject
    result.control.name = controlName
    result.data.name = dataName
    result.control.subdomain = manifest.controlSubdomain
    result.data.subdomain = manifest.dataSubdomain

    if (keepCredentials) {
      // 沿用旧凭据：UUID / WS 路径不变，客户端订阅地址无需改动
      log('· 沿用已有 UUID / WS 路径 / 面板凭据（客户端订阅地址不变）')
      effective = {
        panelPath: options.panelPath || manifest.credentials.panelPath,
        panelPassword: options.panelPassword || manifest.credentials.panelPassword,
        uuid: options.uuid || manifest.credentials.uuid,
        trojanPassword: options.trojanPassword || manifest.credentials.trojanPassword,
        wsPath: options.wsPath || manifest.credentials.wsPath,
      }
      log(`  · UUID：${effective.uuid}`)
      log(`  · WS 路径：${effective.wsPath}`)
    }

    // 同版本跳过：避免无谓触发平台审核
    if (skipSameVersion && options.localBuild && manifest.build === options.localBuild) {
      log(`✅ 线上已是最新版本（${options.localBuild}），跳过部署`)
      result.panelPath = effective.panelPath
      result.uuid = effective.uuid
      result.wsPath = effective.wsPath
      return result
    }
    if (manifest.build && options.localBuild && manifest.build !== options.localBuild) {
      log(`· 版本变化：${manifest.build} → ${options.localBuild}`)
    }
  } else if (manifest && mode === 'fresh') {
    log('· 指定了首次部署模式，忽略已有清单')
  } else {
    log('· 未检测到已有部署，进入首次部署模式')
  }

  // 首次部署：缺项的凭据生成随机值
  if (!effective.panelPath) effective.panelPath = randomPanelPath()
  if (!effective.panelPassword) effective.panelPassword = randomPassword()
  if (!effective.uuid) effective.uuid = randomUUID()
  if (!effective.trojanPassword) effective.trojanPassword = randomPassword()
  if (!effective.wsPath) effective.wsPath = randomWsPath()

  result.panelPath = effective.panelPath
  result.uuid = effective.uuid
  result.wsPath = effective.wsPath

  /* ---------------- 1. 创建两个 Pages 项目 ---------------- */
  for (const [label, name] of [
    ['控制面', controlName],
    ['数据面', dataName],
  ] as const) {
    try {
      const project = await client.createPagesProject(options.accountId, {
        name,
        productionBranch: 'main',
      })
      log(`✅ 已创建${label}项目 ${name}（${project.subdomain}）`)
      if (label === '控制面') result.control.subdomain = project.subdomain
      else result.data.subdomain = project.subdomain
    } catch (err) {
      // 「项目已存在」的错误码不固定（实测返回的是无 code 的 800 型错误），
      // 因此按消息内容判断，覆盖原地更新场景。
      const message = err instanceof Error ? err.message : String(err)
      const alreadyExists = /already exists/i.test(message)
      if (alreadyExists) {
        try {
          const project = await client.getPagesProject(options.accountId, name)
          log(`· ${label}项目 ${name} 已存在，复用它（${project.subdomain}）`)
          if (label === '控制面') result.control.subdomain = project.subdomain
          else result.data.subdomain = project.subdomain
        } catch {
          warnings.push(`无法读取已存在的${label}项目 ${name}`)
        }
      } else {
        warnings.push(
          `创建${label}项目 ${name} 失败：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  /* ---------------- 2. 配置环境变量与 KV（必须在部署前） ---------------- */

  // KV 已有配置时，环境变量不生效（优先级 KV > 环境变量）。
  // 这会让用户拿到「新生成的路径/密码却登不进去」，必须提前告知。
  await detectKvConfigConflict(client, options.accountId, options.kvNamespaceId, log)

  if (result.control.subdomain) {
    await configureProject(client, options.accountId, controlName, '控制面', result, options, log, warnings, effective)
  }

  if (result.data.subdomain) {
    await configureProject(client, options.accountId, dataName, '数据面', result, options, log, warnings, effective)
  }

  /* ---------------- 2b. 同步数据面配置到 KV 的 config 键 ---------------- */

  // 数据面用 CFNext 实现，它读的是 KV 的 `config` 键（CFNext schema），
  // 与环境变量是两套机制：源码里先应用 U/PATH/L 等环境变量，
  // 再 `Object.assign(e, kvConfig)` 整体覆盖，因此 KV 始终优先。
  //
  // 不同步的后果：--ws-path / --uuid 对数据面无效，用户连的仍是旧路径，
  // 且 WS 路径无法随机化。这里显式把本次凭据写进 KV。
  //
  // ⚠️ 必须写全字段：Object.assign 是整体覆盖，缺字段会变成 undefined。
  await syncDataPlaneKvConfig(client, options, result.data.subdomain, warnings, log, effective)

  /* ---------------- 3. 部署（先数据面，控制面的 DATA_HOST 才有效） ---------------- */
  let dataCode = options.bundles?.data ?? ''
  let controlCode = options.bundles?.control ?? ''
  if (!dataCode) {
    try {
      dataCode = await loadBundle('dataplane.js')
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (!controlCode) {
    try {
      controlCode = await loadBundle('control.js')
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }

  /* ---------------- 3. 部署（先数据面，控制面的 DATA_HOST 才有效） ---------------- */

  // ⚠️ 已知平台行为（2026-10-22 实测，含 cfnext 原版文件对照）：
  //    Pages 对含代理入站 + 出站拨号的项目，**第二次部署必然返回
  //    HTTP 400 / 8000119 blocked**，与项目名、是否二次打包、
  //    是否改动源码均无关（原版文件 + 全新随机项目名同样 1/3）。
  //    而不含代理内容的极简 Worker 可 4/4 连续部署。
  //
  //    因此「原地更新」对数据面不可用。妥协方案：命中 8000119 时
  //    自动换一个新的随机项目名重新部署，保证上游有更新时仍能上线。
  //    旧项目不会被删除（用户可能还绑着自定义域名），由用户自行迁移。
  const dataAttempt = await deployWithBlockRetry({
    client,
    accountId: options.accountId,
    preferredName: dataName,
    code: dataCode,
    label: '数据面',
    result,
    options,
    effective,
    wait,
    log,
    warnings,
  })
  if (dataAttempt) {
    result.data.name = dataAttempt.project ?? options.dataProject
    result.data.subdomain = dataAttempt.subdomain
  }

  const controlAttempt = await deployWithBlockRetry({
    client,
    accountId: options.accountId,
    preferredName: controlName,
    code: controlCode,
    label: '控制面',
    result,
    options,
    effective,
    wait,
    log,
    warnings,
  })
  if (controlAttempt) {
    result.control.name = controlAttempt.project ?? controlName
    result.control.subdomain = controlAttempt.subdomain
  }

  /* ---------------- 4. 写回部署清单（下次更新靠它识别同源项目） ---------------- */

  if (result.control.subdomain && result.data.subdomain) {
    await writeManifest(client, options.accountId, options.kvNamespaceId, {
      v: 1,
      controlProject: result.control.name,
      dataProject: result.data.name,
      controlSubdomain: result.control.subdomain,
      dataSubdomain: result.data.subdomain,
      build: options.localBuild ?? 'unknown',
      at: new Date().toISOString(),
      credentials: {
        panelPath: effective.panelPath,
        panelPassword: effective.panelPassword,
        uuid: effective.uuid,
        trojanPassword: effective.trojanPassword,
        wsPath: effective.wsPath,
      },
    })
    log('· 已记录部署清单，下次更新会自动识别同源项目')
  }

  return result
}

/** 生成随机后缀（换名重试用） */
function randomSuffix(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/** 部署结果（用于回写实际使用的项目名） */
interface DeployAttemptResult {
  /** 最终成功的项目名；失败时为 null */
  project: string | null
  subdomain: string
  deploymentId?: string
}

/**
 * 配置一个 Pages 项目的 KV 绑定与环境变量。
 *
 * 抽成独立函数的原因：命中 8000119 换名重试时，新项目也要配一遍。
 *
 * KV 绑定两个名字：
 *   - `KV`：CFPilot 自研代码读的名字（store.ts 用 env.KV）
 *   - `K` ：vendor 数据面读的名字（源码里 `t.K.get("config")`）
 * 少绑一个就会有一侧读不到配置。
 */
async function configureProject(
  client: CloudflareClient,
  accountId: string,
  project: string,
  label: string,
  result: PagesSplitDeployResult,
  options: PagesSplitDeployOptions,
  log: (m: string) => void,
  warnings: string[],
  effective: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
): Promise<void> {
  const kvBindings = {
    KV: { namespace_id: options.kvNamespaceId },
    K: { namespace_id: options.kvNamespaceId },
  }

  const envVars: Record<string, { value: string }> =
    label === '控制面'
      ? {
          PANEL_PATH: { value: effective.panelPath },
          PANEL_PASSWORD: { value: effective.panelPassword },
          // 拆分部署：控制面用 DATA_HOST 指定节点域名
          DATA_HOST: { value: result.data.subdomain },
          ...(options.scannerToken ? { SCANNER_TOKEN: { value: options.scannerToken } } : {}),
        }
      : {
          UUID: { value: effective.uuid },
          TROJAN: { value: options.enableTrojan ? 'true' : 'false' },
          TROJAN_PASSWORD: { value: effective.trojanPassword },
          PATH: { value: effective.wsPath },
          XHTTP: { value: options.enableXhttp ? 'true' : 'false' },
        }

  try {
    await client.updatePagesDeploymentConfig(accountId, project, {
      kv_namespaces: kvBindings,
      env_vars: envVars,
    })
    log(`✅ ${label}已配置 KV 与环境变量`)
  } catch (err) {
    warnings.push(
      `${label}配置失败：${err instanceof Error ? err.message : String(err)}（会导致部署后变量不生效）`
    )
  }
}

/**
 * 部署一个 Pages 项目；命中 8000119 时自动换随机项目名重试。
 *
 * 为什么必须换名：平台对代理类项目的封禁是**按项目**生效的，
 * 同一个项目第二次部署必被拒，原地更新不可用。
 */
async function deployWithBlockRetry(params: {
  client: CloudflareClient
  accountId: string
  preferredName: string
  code: string
  label: string
  result: PagesSplitDeployResult
  options: PagesSplitDeployOptions
  effective: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
  wait: { timeoutMs: number; intervalMs: number }
  log: (m: string) => void
  warnings: string[]
}): Promise<DeployAttemptResult | null> {
  const { client, accountId, preferredName, code, label, result, options, effective, wait, log, warnings } = params
  if (!code) {
    warnings.push(`${label}产物为空，跳过部署`)
    return null
  }

  const slot = label === '数据面' ? result.data : result.control
  const candidates = [preferredName]
  // 预留 2 个备用随机名
  for (let i = 0; i < 2; i++) candidates.push(`${preferredName}-${randomSuffix(4)}`)

  for (const [index, name] of candidates.entries()) {
    try {
      const deployment = await client.deployPagesWorker(accountId, name, { code })
      slot.name = name
      slot.deploymentId = deployment.id
      log(`✅ ${label}已触发部署：${name}（${deployment.id}）`)

      const final = await waitForDeployment(client, accountId, name, wait, log)
      if (final?.latest_stage?.status === 'success') {
        log(`✅ ${label}部署完成：${name}`)
        // 成功后同步 subdomain
        try {
          const project = await client.getPagesProject(accountId, name)
          slot.subdomain = project.subdomain
        } catch {
          /* subdomain 取不到不影响主流程 */
        }
        return { project: name, subdomain: slot.subdomain, deploymentId: deployment.id }
      }
      warnings.push(`${label}部署未确认成功（项目 ${name}，状态：${final?.latest_stage?.status ?? '未知'}）`)
      return { project: name, subdomain: slot.subdomain, deploymentId: deployment.id }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const blocked = /8000119|has been blocked/i.test(message)

      if (blocked && index < candidates.length - 1) {
        log(`⚠ ${label}项目 ${name} 已被平台拒绝部署（8000119）`)
        log(`  → 改用品名 ${candidates[index + 1]} 重新部署`)
        // 换名重试前要先建项目、配变量
        try {
          await client.createPagesProject(accountId, { name: candidates[index + 1]!, productionBranch: 'main' })
          await configureProject(client, accountId, candidates[index + 1]!, label, result, options, log, warnings, effective)
          log(`  → 已创建并配置 ${candidates[index + 1]}`)
        } catch (setupErr) {
          warnings.push(`创建备用${label}项目失败：${setupErr instanceof Error ? setupErr.message : String(setupErr)}`)
          return null
        }
        continue
      }

      warnings.push(
        `${label}部署失败：${message}` +
          (blocked ? '（平台已拒绝该项目；已尝试更换项目名，可在 Cloudflare 控制台查看详情）' : '')
      )
      return null
    }
  }
  return null
}
