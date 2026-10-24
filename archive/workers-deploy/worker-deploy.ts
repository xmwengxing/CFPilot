/**
 * Workers 双脚本部署（控制面 + 数据面，各一个 Worker）
 *
 * ## 与 Pages 双项目的关系
 *
 * Pages 双项目（`pages-deploy.ts`）是**默认且已验证稳定**的部署形态。
 * 本文件提供的是**实验性**的 Workers 通道，二者共用同一套内核产物与同一个 KV。
 *
 * ## 为什么值得做
 *
 * 真机对照（2026-10-23/24，两个账号）确认了一件关键事实：
 *
 * | 通道 | 原地重复更新 |
 * |------|--------------|
 * | Pages 项目 | 数据面承载流量后**持久性拒绝**（8000119） |
 * | Workers 脚本 | **连续 5 次原地更新全部成功**，从未出现 8000119 |
 *
 * 也就是说：**Workers 的更新链路明显比 Pages 稳定**，
 * 不需要「新建项目 + 切 DATA_HOST + 重发控制面」那套迁移流程。
 *
 * ## ⚠️ 已知限制（必须告知用户，不要隐藏）
 *
 * 真机对照：**同一份字节内容**（含自研数据面 `websocket-self` + `dial` 出站代码）
 *
 * | 通道 | 结果 |
 * |------|------|
 * | Pages `_worker.js` | 5/5 全部 200 ✅ |
 * | Workers 脚本 + 自定义域名 | 5/5 全部 522 ❌（isolate 启动即失败） |
 *
 * 已排除的因素：体积（260KB 纯合法脚本正常）、静态/动态 `cloudflare:sockets`
 * 导入、`compatibility_date`、minify、账号差异（备用干净账号同样失败）、
 * KV 绑定、模块级 API（`new Map` / `TextEncoder` / `WebSocketPair` 单独验证均正常）。
 * 精确触发点是 `websocket-self` 里的 `dial()` 出站调用块 —— 去掉它立即恢复 200。
 *
 * 因此本通道被标记为**实验性**：控制面（面板/订阅/探针）完全可用，
 * 数据面在部分环境下可能无法启动。部署时会明确告警。
 *
 * ## 部署顺序（与 Pages 一致，不可调换）
 *
 * 1. 上传数据面脚本（含 KV 绑定与 UUID/WS 路径变量）
 * 2. 上传控制面脚本（`DATA_HOST` 必须指向**已确定**的数据面域名）
 * 3. 绑定自定义域名（有 zone 时）或开启 workers.dev
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { CloudflareClient, type ScriptBinding, type WorkerDomain } from './cf-api'
import { inspectKvOwnership, readManifest, type DeployManifest } from './pages-deploy'
import { randomPanelPath, randomPassword, randomWsPath } from './utils'

/** Workers 部署清单（与 Pages 清单分开存，避免两种形态互相覆盖） */
export const WORKER_MANIFEST_KEY = 'CFP_DEPLOY_MANIFEST_WORKERS'

export interface WorkerSplitDeployOptions {
  token: string
  accountId: string
  /** KV 命名空间 ID（两个 Worker 共用） */
  kvNamespaceId: string
  /** 控制面 Worker 脚本名 */
  controlScript: string
  /** 数据面 Worker 脚本名 */
  dataScript: string
  /** 面板访问路径，如 /p-a1b2c3 */
  panelPath: string
  /** 面板密码 */
  panelPassword: string
  /** VLESS UUID */
  uuid: string
  /** Trojan 密码 */
  trojanPassword: string
  /** WS 路径（含前导斜杠） */
  wsPath: string
  enableTrojan: boolean
  enableXhttp: boolean
  scannerToken?: string
  /**
   * 部署模式：
   *   - 'auto'   ：读清单自动判断（有清单=更新，无清单=首次）
   *   - 'fresh'  ：强制首次部署，忽略清单
   *   - 'update' ：强制更新，沿用 KV 里的凭据
   */
  mode?: 'auto' | 'fresh' | 'update'
  /** 更新时是否沿用已有凭据（默认 true） */
  keepCredentials?: boolean
  /** 数据面实现：self（默认）/ vendor */
  dataPlane?: 'vendor' | 'self'
  /** 出站前是否自动 DoH 解析优选 IP（注入 RESOLVE_PREFERRED） */
  resolvePreferred?: boolean
  /** 线上版本与本地一致时跳过部署（默认 true） */
  skipSameVersion?: boolean
  /** 明知 KV 属于别的实例仍然继续 */
  force?: boolean
  /** 本地产物构建版本 */
  localBuild?: string
  /**
   * 自定义域名（可选）。
   *
   * 不传则只用 `<script>.<subdomain>.workers.dev`。
   * 传了就必须同时给 `zoneId`，否则绑定会失败。
   */
  controlHostname?: string
  dataHostname?: string
  /** 绑自定义域名所需的 zone ID */
  zoneId?: string
  /** 覆盖 API 地址（测试用） */
  apiBase?: string
  /**
   * 跳过部署后的数据面健康探测（测试用）。
   *
   * 生产环境不要传 —— 这个探测正是用来把「数据面 522」这个已知限制
   * 直接告诉用户，而不是让用户自己发现订阅里的节点全都不通。
   */
  skipDataProbe?: boolean
  /** 覆盖内核产物内容（测试用） */
  bundles?: { control?: string; data?: string }
  log?: (message: string) => void
}

export interface WorkerSplitDeployResult {
  control: { name: string; host: string; devHost: string }
  data: { name: string; host: string; devHost: string }
  panelPath?: string
  uuid?: string
  wsPath?: string
  /** 数据面是否通过了一次真实探测（false 表示可能是 522 场景） */
  dataProbeOk?: boolean
  warnings: string[]
}

/** Workers 部署清单 */
export interface WorkerDeployManifest {
  v: 1
  /** 部署形态标识，便于和 Pages 清单区分 */
  kind: 'workers'
  kvNamespaceId?: string
  controlScript: string
  dataScript: string
  /** 控制面访问域名（自定义域名优先，否则 workers.dev） */
  controlHost: string
  /** 数据面访问域名 */
  dataHost: string
  /** workers.dev 子域（用于展示与回退） */
  workersDevSubdomain?: string
  build: string
  at: string
  credentials: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
}

/** 读取 Workers 部署清单；不存在返回 null */
export async function readWorkerManifest(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string
): Promise<WorkerDeployManifest | null> {
  try {
    const raw = await client.getKvValue(accountId, namespaceId, WORKER_MANIFEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WorkerDeployManifest
    return parsed && parsed.v === 1 && parsed.kind === 'workers' ? parsed : null
  } catch {
    return null
  }
}

async function writeWorkerManifest(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  manifest: WorkerDeployManifest
): Promise<void> {
  try {
    await client.setKvValue(accountId, namespaceId, WORKER_MANIFEST_KEY, JSON.stringify(manifest))
  } catch {
    /* 清单写失败不影响部署本身 */
  }
}

/**
 * 列出账号下所有「由 CFPilot 的 Workers 通道部署」的 KV 命名空间。
 *
 * 与 Pages 版本（`listCfPilotNamespaces`）并列，两者读的是不同的清单键。
 */
export async function listCfPilotWorkerNamespaces(
  client: CloudflareClient,
  accountId: string
): Promise<Array<{ id: string; title: string; manifest: WorkerDeployManifest }>> {
  const namespaces = await client.listKvNamespaces(accountId)
  const out: Array<{ id: string; title: string; manifest: WorkerDeployManifest }> = []
  for (const ns of namespaces) {
    const manifest = await readWorkerManifest(client, accountId, ns.id)
    if (manifest) out.push({ id: ns.id, title: ns.title, manifest })
  }
  return out
}

/**
 * 探测一个 Workers 部署形态的 KV 归属。
 *
 * 判定顺序与 Pages 版一致，但优先认 Workers 清单：
 *   1. 有 Workers 清单且控制面脚本名匹配 → owned
 *   2. 有 Pages 清单 → 说明这个 KV 已被 Pages 实例占用 → occupied
 *   3. 都没有 → 复用 Pages 版判定（空 / CFNext / 残留）
 */
export async function inspectWorkerKvOwnership(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  controlScript: string
): Promise<{ verdict: 'owned' | 'occupied' | 'foreign' | 'stale' | 'empty'; detail: string; blocking: boolean }> {
  const workerManifest = await readWorkerManifest(client, accountId, namespaceId)
  if (workerManifest) {
    if (workerManifest.controlScript === controlScript) {
      return {
        verdict: 'owned',
        detail: `已由 CFPilot（Workers 通道）部署：控制面 ${workerManifest.controlScript} / 数据面 ${workerManifest.dataScript}`,
        blocking: false,
      }
    }
    return {
      verdict: 'occupied',
      detail: `已被另一个 CFPilot Workers 实例占用（控制面 ${workerManifest.controlScript}，部署于 ${workerManifest.at}）`,
      blocking: true,
    }
  }

  // 该 KV 可能被 Pages 实例占用 —— 两种形态共用一套 KV 键，不能并存
  const pagesManifest: DeployManifest | null = await readManifest(client, accountId, namespaceId)
  if (pagesManifest) {
    return {
      verdict: 'occupied',
      detail:
        `该 KV 已承载 Pages 实例（控制面 ${pagesManifest.controlProject} / 数据面 ${pagesManifest.dataProject}）。` +
        '一个 KV 命名空间只能承载一个 CFPilot 实例，Pages 与 Workers 两种形态也不能共用',
      blocking: true,
    }
  }

  const base = await inspectKvOwnership(client, accountId, namespaceId, controlScript)
  return { verdict: base.verdict, detail: base.detail, blocking: base.blocking }
}

/** 模块目录（兼容 ESM 与 CJS） */
function moduleDir(): string {
  try {
    const meta = import.meta
    if (meta && typeof meta.url === 'string') return dirname(fileURLToPath(meta.url))
  } catch {
    /* CJS 产物：import.meta 不存在 */
  }
  return typeof __dirname === 'string' ? __dirname : process.cwd()
}

/** 读取 worker-core 的构建产物 */
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
  throw new Error(`未找到 ${fileName}，请先执行 npm run build -w @cfpilot/worker-core`)
}

/** 校验部署参数（与 Pages 版一致，重点是 MSYS 污染路径） */
function validateOptions(options: WorkerSplitDeployOptions): string[] {
  const problems: string[] = []

  const checkPath = (label: string, value: string): void => {
    if (!value) return
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

  if (/:/.test(options.uuid)) problems.push(`UUID 含非法字符：${JSON.stringify(options.uuid)}`)
  if (/:/.test(options.trojanPassword)) {
    problems.push(`Trojan 密码含非法字符：${JSON.stringify(options.trojanPassword)}`)
  }

  // Worker 脚本名只允许小写字母数字与连字符（Cloudflare 要求）
  for (const [label, name] of [
    ['控制面脚本名', options.controlScript],
    ['数据面脚本名', options.dataScript],
  ] as const) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      problems.push(`${label} 含非法字符：${JSON.stringify(name)}（只允许小写字母、数字、连字符）`)
    }
  }

  // 自定义域名与 zone 必须成对出现
  if ((options.controlHostname || options.dataHostname) && !options.zoneId) {
    problems.push('指定了自定义域名但没有 zoneId，无法绑定')
  }

  return problems
}

/** 探测一个 URL 是否返回 2xx（用于数据面健康检查） */
async function probeUrl(url: string, timeoutMs = 15000): Promise<{ ok: boolean; status: number | string }> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'cfpilot-deploy' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: response.status >= 200 && response.status < 300, status: response.status }
  } catch (err) {
    return { ok: false, status: err instanceof Error ? err.message : String(err) }
  }
}

/** 生成随机后缀（换名重试用） */
function randomSuffix(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

/**
 * 执行 Workers 双脚本部署。
 *
 * 设计原则与 Pages 版一致：**尽力而为，绝不抛出**（参数非法与 KV 越界除外）。
 */
export async function deployWorkerSplit(
  options: WorkerSplitDeployOptions
): Promise<WorkerSplitDeployResult> {
  const problems = validateOptions(options)
  if (problems.length > 0) {
    throw new Error(`部署参数不合法：\n  - ${problems.join('\n  - ')}`)
  }

  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const client = new CloudflareClient({ token: options.token, apiBase: options.apiBase })

  const mode = options.mode ?? 'auto'
  const keepCredentials = options.keepCredentials ?? true
  const skipSameVersion = options.skipSameVersion ?? true

  const result: WorkerSplitDeployResult = {
    control: { name: options.controlScript, host: '', devHost: '' },
    data: { name: options.dataScript, host: '', devHost: '' },
    warnings,
  }

  /* ---------------- 0. 读清单，判断首次还是更新 ---------------- */

  const manifest = await readWorkerManifest(client, options.accountId, options.kvNamespaceId)

  let effective = {
    panelPath: options.panelPath,
    panelPassword: options.panelPassword,
    uuid: options.uuid,
    trojanPassword: options.trojanPassword,
    wsPath: options.wsPath,
  }

  let controlName = options.controlScript
  let dataName = options.dataScript

  if (manifest && mode !== 'fresh') {
    log(`· 检测到已有 Workers 部署（${manifest.at}），进入更新模式`)
    controlName = manifest.controlScript
    dataName = manifest.dataScript
    result.control.name = controlName
    result.data.name = dataName
    result.control.host = manifest.controlHost
    result.data.host = manifest.dataHost

    if (keepCredentials) {
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
    log('· 未检测到 Workers 部署，进入首次部署模式')
  }

  /* ---------------- 0b. KV 归属校验（写入任何键之前） ---------------- */

  const ownership = await inspectWorkerKvOwnership(
    client,
    options.accountId,
    options.kvNamespaceId,
    controlName
  )
  if (ownership.blocking && !options.force) {
    throw new Error(
      `该 KV 命名空间不可用于本次 Workers 部署：${ownership.detail}。\n` +
        '  一个 KV 命名空间只能承载一个 CFPilot 部署实例（内核的 KV 键全局平铺，无实例前缀）。\n' +
        '  → 请改用其他 KV，或新建一个（GUI：凭据页「新建 KV」；CLI：--new-kv）。'
    )
  }
  if (ownership.blocking && options.force) {
    log(`⚠ ${ownership.detail}\n  ⚠ 已指定强制覆盖，继续执行——原实例的配置将被本次部署改写。`)
  } else {
    log(`· KV 归属校验通过：${ownership.detail}`)
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

  /* ---------------- 1. 解析 workers.dev 子域（作为回退域名） ---------------- */

  const workersSubdomain = await client.getWorkersSubdomain(options.accountId).catch(() => '')
  if (!workersSubdomain) {
    warnings.push(
      '未能读取账号的 workers.dev 子域。未绑定自定义域名时将无法给出可访问地址；' +
        '请到控制台 → Workers 查看实际子域，或补 Workers Scripts → Read 权限后重跑。'
    )
  }

  const controlDevHost = workersSubdomain ? `${controlName}.${workersSubdomain}.workers.dev` : ''
  const dataDevHost = workersSubdomain ? `${dataName}.${workersSubdomain}.workers.dev` : ''
  result.control.devHost = controlDevHost
  result.data.devHost = dataDevHost

  // 数据面域名：自定义域名优先，否则 workers.dev（控制面的 DATA_HOST 要用它）
  const dataHost = options.dataHostname || dataDevHost || result.data.host
  const controlHost = options.controlHostname || controlDevHost || result.control.host
  result.data.host = dataHost
  result.control.host = controlHost

  if (!dataHost) {
    throw new Error(
      '无法确定数据面域名：账号未开启 workers.dev 且未指定自定义域名。\n' +
        '  → 请到 Cloudflare 控制台开启 workers.dev，或用 --data-host 指定自定义域名'
    )
  }

  /* ---------------- 2. 载入内核产物 ---------------- */

  let dataCode = options.bundles?.data ?? ''
  let controlCode = options.bundles?.control ?? ''
  if (!dataCode) {
    // ⚠️ Workers 通道必须用**纯自研**产物 `dataplane-self.js`：
    // 含 vendor（CFNext）的数据面产物在 Workers 上会 isolate 启动失败（HTTP 522），
    // 而同一份产物在 Pages 上完全正常（真机对照，见 worker-deploy.ts 文件头）。
    // `dataplane-self.js` 零 vendor 依赖，出站能力由入口持有一层注入。
    //
    // 这里做两级兜底：优先 Workers 专用产物，缺失时回落到通用产物
    //（旧版构建可能还没产出它），并记一条告警便于排查。
    try {
      dataCode = await loadBundle('dataplane-self.js')
    } catch {
      try {
        dataCode = await loadBundle('dataplane.js')
        warnings.push(
          '未找到 Workers 专用产物 dataplane-self.js，已回落到通用数据面产物。' +
            '\n  含 vendor 的数据面在 Workers 上会返回 522；' +
            '请执行 npm run build -w @cfpilot/worker-core 重新构建。'
        )
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err))
      }
    }
  }
  if (!controlCode) {
    try {
      controlCode = await loadBundle('control.js')
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }

  /* ---------------- 3. 上传数据面（先数据面，控制面的 DATA_HOST 才有效） ---------------- */

  const kvBindings: ScriptBinding[] = [
    { type: 'kv_namespace', name: 'KV', namespace_id: options.kvNamespaceId },
    // CFNext 风格的名字（vendor 源码里读 t.K），少绑一个会有一侧读不到配置
    { type: 'kv_namespace', name: 'K', namespace_id: options.kvNamespaceId },
  ]

  const dataBindings: ScriptBinding[] = [
    ...kvBindings,
    { type: 'plain_text', name: 'UUID', text: effective.uuid },
    { type: 'plain_text', name: 'TROJAN_PASSWORD', text: effective.trojanPassword },
    // 内核读 WS_PATH 或 PATH，两个都注入
    { type: 'plain_text', name: 'WS_PATH', text: effective.wsPath },
    { type: 'plain_text', name: 'PATH', text: effective.wsPath },
    { type: 'plain_text', name: 'ENABLE_TROJAN', text: options.enableTrojan ? 'true' : 'false' },
    { type: 'plain_text', name: 'ENABLE_XHTTP', text: options.enableXhttp ? 'true' : 'false' },
    ...(options.dataPlane ? [{ type: 'plain_text' as const, name: 'DATAPLANE', text: options.dataPlane }] : []),
    ...(options.resolvePreferred === undefined
      ? []
      : [
          {
            type: 'plain_text' as const,
            name: 'RESOLVE_PREFERRED',
            text: options.resolvePreferred ? 'true' : 'false',
          },
        ]),
  ]

  const controlBindings: ScriptBinding[] = [
    ...kvBindings,
    { type: 'plain_text', name: 'PANEL_PATH', text: effective.panelPath },
    { type: 'plain_text', name: 'PANEL_PASSWORD', text: effective.panelPassword },
    { type: 'plain_text', name: 'DATA_HOST', text: dataHost },
    ...(options.scannerToken ? [{ type: 'plain_text' as const, name: 'SCANNER_TOKEN', text: options.scannerToken }] : []),
  ]

  const dataDeploy = await uploadWithBlockRetry({
    client,
    accountId: options.accountId,
    preferredName: dataName,
    code: dataCode,
    bindings: dataBindings,
    label: '数据面',
    log,
    warnings,
  })
  if (dataDeploy) {
    result.data.name = dataDeploy.name
    // 换名重建后 workers.dev 域名也要跟着变
    if (dataDeploy.name !== dataName && workersSubdomain) {
      result.data.devHost = `${dataDeploy.name}.${workersSubdomain}.workers.dev`
      if (!options.dataHostname) result.data.host = result.data.devHost
    }
  }

  /* ---------------- 4. 上传控制面 ---------------- */

  const controlDeploy = await uploadWithBlockRetry({
    client,
    accountId: options.accountId,
    preferredName: controlName,
    code: controlCode,
    bindings: controlBindings,
    label: '控制面',
    log,
    warnings,
  })
  if (controlDeploy) {
    result.control.name = controlDeploy.name
    if (controlDeploy.name !== controlName && workersSubdomain) {
      result.control.devHost = `${controlDeploy.name}.${workersSubdomain}.workers.dev`
      if (!options.controlHostname) result.control.host = result.control.devHost
    }
  }

  /* ---------------- 5. 开启 workers.dev 路由 ---------------- */

  for (const [label, name] of [
    ['控制面', result.control.name],
    ['数据面', result.data.name],
  ] as const) {
    try {
      await client.putScriptSubdomain(options.accountId, name, true)
      log(`✅ ${label}已开启 workers.dev 子域路由`)
    } catch (err) {
      warnings.push(
        `${label}开启 workers.dev 子域失败：${err instanceof Error ? err.message : String(err)}（不影响自定义域名）`
      )
    }
  }

  /* ---------------- 6. 绑定自定义域名 ---------------- */

  if (options.zoneId && (options.controlHostname || options.dataHostname)) {
    for (const [label, hostname, scriptName] of [
      ['控制面', options.controlHostname, result.control.name],
      ['数据面', options.dataHostname, result.data.name],
    ] as const) {
      if (!hostname) continue
      try {
        const existing: WorkerDomain | null = await client.findWorkerDomain(options.accountId, hostname)
        if (existing && existing.service === scriptName) {
          log(`· ${label}自定义域名已绑定：${hostname}`)
        } else if (existing) {
          // 域名被别的脚本占着：先解绑再绑，否则 PUT 会失败
          log(`· ${label}域名 ${hostname} 原指向 ${existing.service}，正在改绑`)
          await client.deleteWorkerDomain(options.accountId, existing.id)
          await client.attachCustomDomain(options.accountId, {
            hostname,
            service: scriptName,
            zoneId: options.zoneId,
          })
          log(`✅ ${label}自定义域名已改绑：${hostname}`)
        } else {
          await client.attachCustomDomain(options.accountId, {
            hostname,
            service: scriptName,
            zoneId: options.zoneId,
          })
          log(`✅ ${label}自定义域名已绑定：${hostname}`)
        }
      } catch (err) {
        warnings.push(
          `${label}绑定自定义域名 ${hostname} 失败：${err instanceof Error ? err.message : String(err)}` +
            '（可继续用 workers.dev 地址）'
        )
      }
    }
  }

  /* ---------------- 7. 写入 KV CONFIG（凭据） ---------------- */

  await writeEffectiveConfig(
    client,
    options.accountId,
    options.kvNamespaceId,
    effective,
    { enableTrojan: options.enableTrojan, enableXhttp: options.enableXhttp },
    warnings,
    log
  )

  /* ---------------- 8. 数据面健康探测（区分 522 场景） ---------------- */

  if (result.data.host && !options.skipDataProbe) {
    log('正在探测数据面可访问性（约 15 秒）…')
    const probe = await probeUrl(`https://${result.data.host}/__diag`, 15000)
    result.dataProbeOk = probe.ok
    if (probe.ok) {
      log(`✅ 数据面响应正常（HTTP ${probe.status}）`)
    } else {
      // 这是本通道最主要的已知风险，必须明确说出来
      warnings.push(
        `数据面探测未通过（${probe.status}）。` +
          '\n  Workers 通道对自研数据面存在已知限制：真机实测同一份产物在 Pages 上 100% 正常，' +
          '而在 Workers 上会返回 522（isolate 启动即失败），触发点是 websocket-self 的 dial 出站调用块。' +
          '\n  → 控制面（面板 / 订阅 / 探针）不受影响，可以正常使用。' +
          '\n  → 若你需要稳定的数据面，请改用默认的 Pages 双项目部署（cfpilot-deploy pages-split）。'
      )
      log('⚠ 数据面探测未通过 —— 见告警说明（Workers 通道已知限制）')
    }
  }

  /* ---------------- 9. 写回部署清单 ---------------- */

  if (result.control.host && result.data.host) {
    await writeWorkerManifest(client, options.accountId, options.kvNamespaceId, {
      v: 1,
      kind: 'workers',
      kvNamespaceId: options.kvNamespaceId,
      controlScript: result.control.name,
      dataScript: result.data.name,
      controlHost: result.control.host,
      dataHost: result.data.host,
      workersDevSubdomain: workersSubdomain || undefined,
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
    log('· 已记录 Workers 部署清单，下次更新会自动识别同源脚本')
  }

  return result
}

/**
 * 把凭据写入 KV 的**大写 `CONFIG` 键**（与 Pages 版共用同一份逻辑）。
 *
 * 绝不写 CFNext 的小写 `config` 键 —— 那会整体覆盖共栖项目的配置。
 */
async function writeEffectiveConfig(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  effective: { uuid: string; trojanPassword: string; wsPath: string },
  options: { enableTrojan: boolean; enableXhttp: boolean },
  warnings: string[],
  log: (m: string) => void
): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    const raw = await client.getKvValue(accountId, namespaceId, 'CONFIG')
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      }
    }
  } catch {
    /* 旧值解析失败时按空处理 */
  }

  const merged: Record<string, unknown> = {
    ...existing,
    uuid: effective.uuid,
    trojanPassword: effective.trojanPassword,
    wsPath: effective.wsPath,
    enableTrojan: options.enableTrojan,
    enableXhttp: options.enableXhttp,
  }

  try {
    await client.setKvValue(accountId, namespaceId, 'CONFIG', JSON.stringify(merged))
    log('✅ 部署凭据已写入 KV（uuid / WS 路径 / Trojan 密码已生效）')
  } catch (err) {
    warnings.push(
      `KV 凭据写入失败：${err instanceof Error ? err.message : String(err)}` +
        '\n  内核会回退到环境变量（UUID / WS 路径 / Trojan 密码来自部署时注入的 env），' +
        '但订阅与面板的配置保存会失效（面板保存依赖 KV）。' +
        '\n  → 通常是网络瞬时故障，重新执行一次同一条部署命令即可（凭据会沿用，不会变）。'
    )
  }
}

/** 上传结果 */
interface UploadOutcome {
  name: string
}

/**
 * 上传一个 Worker 脚本；命中 8000119 时先原样重试、再换名。
 *
 * ## 与 Pages 的关键差异
 *
 * Pages 的数据面承载流量后**原地重部署是持久性拒绝**（实测 4/4），
 * 必须新建项目。而 Workers 脚本的原地更新真机实测 **5/5 全部成功**，
 * 因此这里仍然保留重试作为兜底，但正常路径就是原地更新。
 */
async function uploadWithBlockRetry(params: {
  client: CloudflareClient
  accountId: string
  preferredName: string
  code: string
  bindings: ScriptBinding[]
  label: string
  log: (m: string) => void
  warnings: string[]
}): Promise<UploadOutcome | null> {
  const { client, accountId, preferredName, code, bindings, label, log, warnings } = params
  if (!code) {
    warnings.push(`${label}产物为空，跳过部署`)
    return null
  }

  const candidates = [preferredName, `${preferredName}-${randomSuffix(4)}`]
  const SAME_NAME_ATTEMPTS = 3

  for (const [index, name] of candidates.entries()) {
    for (let attempt = 1; attempt <= SAME_NAME_ATTEMPTS; attempt++) {
      try {
        await client.uploadScript(accountId, name, {
          mainModule: 'worker.js',
          code,
          compatibilityDate: '2026-01-01',
          bindings,
        })
        log(`✅ ${label}已上传：${name}`)
        return { name }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const blocked = /8000119|has been blocked/i.test(message)
        const isLastAttempt = attempt === SAME_NAME_ATTEMPTS

        if (isLastAttempt && index < candidates.length - 1) {
          log(`⚠ ${label}脚本 ${name} 连续 ${SAME_NAME_ATTEMPTS} 次被平台拒绝（8000119）`)
          log(`  → 改用名称 ${candidates[index + 1]} 重新上传`)
          break
        }
        if (!isLastAttempt) {
          log(`⚠ ${label}脚本 ${name} 上传被拒（8000119），${SAME_NAME_ATTEMPTS - attempt} 次后重试同名`)
          continue
        }
        warnings.push(
          `${label}部署失败：${message}` +
            (blocked ? '（平台已拒绝该脚本；已重试并尝试更换名称）' : '')
        )
        return null
      }
    }
  }
  return null
}
