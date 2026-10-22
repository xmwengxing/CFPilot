/**
 * 主进程桥接层
 *
 * 把 GUI 操作转成对 deploy-wizard / scanner 的**进程内调用**
 * （直接 import，不起子进程、不走 HTTP）。
 *
 * 这样做的原因：
 *   1. 令牌不经过任何中间层，只在主进程内存与 Cloudflare API 之间流动
 *   2. 部署产物（dist/control.js、dist/dataplane.js）直接读 monorepo 构建结果
 *   3. 日志可以实时推给渲染层
 */
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { app, type BrowserWindow } from 'electron'
import { loadSecrets, saveSecrets, clearSecrets, hasToken } from './config-store'
import { runLocalScan, type ScanEvent } from './scanner'

/**
 * 当前文件所在目录。
 *
 * 产物是 CJS，直接用 __dirname。
 * （早期用 `typeof __dirname === 'string' ? __dirname : fileURLToPath(import.meta.url)`
 *  的兼容写法会让 esbuild 在 CJS 输出里保留 import.meta 分支并告警，
 *  而 CJS 运行时该分支永远走不到，故删掉。）
 */
const here: string = __dirname

/** 推送日志到渲染层 */
function sendLog(win: BrowserWindow | null, message: string, level: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
  win?.webContents.send('log', { message, level, at: Date.now() })
}

/** 定位 worker-core 的产物目录（打包后随 extraResources 一起走） */
function findDistDir(): string {
  const candidates = [
    resolve(here, '../../worker-core/dist'),
    resolve(here, '../../../worker-core/dist'),
    resolve(process.cwd(), 'packages/worker-core/dist'),
    // 打包后：resources/worker-core/dist
    resolve(process.resourcesPath ?? '', 'worker-core/dist'),
    resolve(app.getAppPath(), '../worker-core/dist'),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'control.js'))) return c
    } catch {
      /* 某些路径在 Windows 下会抛异常，忽略 */
    }
  }
  return candidates[0]!
}

/**
 * deploy-wizard 的部署接口。
 *
 * 用手写接口而非 `typeof import('...')`：tsc 无法解析跨包路径，
 * 而 esbuild 会在构建时把库打成本地文件，运行时直接 require。
 */
interface DeployerModule {
  deployPagesSplit(options: {
    token: string
    accountId: string
    kvNamespaceId: string
    controlProject: string
    dataProject: string
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
    enableTrojan: boolean
    enableXhttp: boolean
    mode?: 'auto' | 'fresh' | 'update'
    keepCredentials?: boolean
    skipSameVersion?: boolean
    localBuild?: string
    bundles?: { control?: string; data?: string }
    wait?: { timeoutMs: number; intervalMs: number }
    log?: (m: string) => void
  }): Promise<{
    control: { name: string; subdomain: string; deploymentId?: string }
    data: { name: string; subdomain: string; deploymentId?: string }
    panelPath?: string
    uuid?: string
    wsPath?: string
    warnings: string[]
  }>
}

/** Cloudflare API 客户端（同上，运行时加载） */
interface CfApiModule {
  CloudflareClient: new (options: { token: string; apiBase?: string }) => {
    getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null>
    listAccounts(): Promise<Array<{ id: string; name: string }>>
    listKvNamespaces(accountId: string): Promise<Array<{ id: string; title: string }>>
    createKvNamespace(accountId: string, title: string): Promise<{ id: string; title: string }>
  }
}

/** 定位 deploy-wizard 库文件（构建产物） */
function findDeployerLib(): string {
  const candidates = [
    join(__dirname, 'deployer-lib.js'),
    join(__dirname, '../main/deployer-lib.js'),
    join(process.cwd(), 'packages/gui/dist/main/deployer-lib.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `未找到 deployer 库文件，试过：${candidates.join('、')}。请先执行 npm run build -w @cfpilot/gui`
  )
}

/** 加载 deploy-wizard 的部署函数 */
function loadDeployer(): DeployerModule {
  const req = createRequire(__filename)
  return req(findDeployerLib()) as DeployerModule
}

/** 加载 Cloudflare API 客户端（同一个库文件里导出） */
function loadCfApi(): CfApiModule {
  const req = createRequire(__filename)
  return req(findDeployerLib()) as unknown as CfApiModule
}

export interface DeployParams {
  /** 首次 / 更新 / 自动 */
  mode: 'auto' | 'fresh' | 'update'
  /** 强制重新部署 */
  force: boolean
  /** 更新时重新生成凭据 */
  newCredentials: boolean
  /** 控制面项目名（留空 = 随机 / 按清单） */
  controlProject: string
  /** 数据面项目名 */
  dataProject: string
  /** 面板路径（留空 = 随机 / 按清单） */
  panelPath: string
  /** WS 路径 */
  wsPath: string
}

/** 执行部署，日志实时推给窗口 */
export async function runDeploy(
  win: BrowserWindow | null,
  params: DeployParams
): Promise<{ ok: boolean; error?: string }> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim()) {
    sendLog(win, '尚未保存 Cloudflare API Token，请先填写并保存', 'err')
    return { ok: false, error: '缺少 API Token' }
  }
  if (!secrets.kvNamespaceId.trim()) {
    sendLog(win, '尚未保存 KV 命名空间 ID', 'err')
    return { ok: false, error: '缺少 KV ID' }
  }

  const dist = findDistDir()
  const localBuild = await readLocalBuild(dist)

  try {
    sendLog(win, '读取本地构建产物…')
    const [control, data] = await Promise.all([
      readFile(join(dist, 'control.js'), 'utf8'),
      readFile(join(dist, 'dataplane.js'), 'utf8'),
    ])

    const deployer = await loadDeployer()
    sendLog(win, '开始部署（日志来自部署向导）…')

    const result = await deployer.deployPagesSplit({
      token: secrets.cfToken,
      accountId: secrets.accountId.trim(),
      kvNamespaceId: secrets.kvNamespaceId.trim(),
      controlProject: params.controlProject.trim(),
      dataProject: params.dataProject.trim(),
      panelPath: params.panelPath.trim(),
      panelPassword: secrets.panelPassword,
      uuid: '',
      trojanPassword: '',
      wsPath: params.wsPath.trim(),
      enableTrojan: true,
      enableXhttp: false,
      mode: params.mode,
      keepCredentials: !params.newCredentials,
      skipSameVersion: !params.force,
      localBuild,
      bundles: { control, data },
      log: (m: string) => sendLog(win, m),
    })

    sendLog(win, `控制面：https://${result.control.subdomain}${result.panelPath ?? ''}`, 'ok')
    sendLog(win, `数据面：https://${result.data.subdomain}`, 'ok')
    if (result.uuid) sendLog(win, `UUID：${result.uuid}`)
    if (result.wsPath) sendLog(win, `WS 路径：${result.wsPath}`)

    if (result.warnings.length > 0) {
      for (const w of result.warnings) sendLog(win, w, 'warn')
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendLog(win, `部署失败：${message}`, 'err')
    return { ok: false, error: message }
  }
}

/** 从产物里读构建版本 */
async function readLocalBuild(dist: string): Promise<string | undefined> {
  try {
    const code = await readFile(join(dist, 'control.js'), 'utf8')
    const m = /["']([0-9a-f]{7,10}-\d{12})["']/.exec(code)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** 优选参数 */
export interface ScanParams {
  host: string
  port: number
  wsPath: string
  probePath: string
  skipSpeed: boolean
  sample: number
  top: number
}

/**
 * 自动检测账号 ID 与可用 KV。
 *
 * 账号 ID 不需要用户填：Token 本身就能列出可见账号（CLI 也是这么做的）。
 * KV 命名空间同理——没有就自动建一个。
 */
export async function detectAccount(
  win: BrowserWindow | null
): Promise<{ accountId: string; accountName: string; kvId: string }> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim()) {
    sendLog(win, '尚未保存 API Token', 'err')
    return { accountId: '', accountName: '', kvId: '' }
  }
  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })

    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      sendLog(win, '该 Token 没有可见的账号', 'err')
      return { accountId: '', accountName: '', kvId: '' }
    }
    const account = accounts[0]!
    sendLog(win, `账号：${account.name}（${account.id}）`, 'ok')

    // 已有 KV 就复用第一个，没有就自动建
    let kvId = secrets.kvNamespaceId.trim()
    if (!kvId) {
      const namespaces = await client.listKvNamespaces(account.id)
      if (namespaces.length > 0) {
        kvId = namespaces[0]!.id
        sendLog(win, `复用已有 KV：${namespaces[0]!.title}`, 'ok')
      } else {
        const created = await client.createKvNamespace(account.id, `cfpilot-gui-${Date.now().toString(36)}`)
        kvId = created.id
        sendLog(win, `已创建 KV：${created.title}`, 'ok')
      }
      saveSecrets({ accountId: account.id, kvNamespaceId: kvId })
    }

    return { accountId: account.id, accountName: account.name, kvId }
  } catch (err) {
    sendLog(win, `检测账号失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    return { accountId: '', accountName: '', kvId: '' }
  }
}

/**
 * 执行本地真连接优选。
 *
 * 直接复用 scanner-cli 的 runScan()（库函数），进度实时推给渲染层。
 */
export async function runScanJob(
  win: BrowserWindow | null,
  params: ScanParams
): Promise<{ ok: boolean; count?: number; copyable?: string; error?: string }> {
  const host = params.host.trim()
  if (!host) {
    sendLog(win, '请填写 Worker 域名', 'err')
    return { ok: false, error: '缺少域名' }
  }
  if (!params.wsPath.trim()) {
    sendLog(win, '请填写 WS 路径', 'err')
    return { ok: false, error: '缺少 WS 路径' }
  }

  sendLog(win, `开始优选：${host}${params.wsPath}（端口 ${params.port}）`)

  try {
    const result = await runLocalScan({
      host,
      port: params.port,
      wsPath: params.wsPath.trim(),
      probePath: params.probePath.trim() || params.wsPath.trim(),
      skipSpeed: params.skipSpeed,
      sample: params.sample,
      top: params.top,
      onProgress: (event: ScanEvent) => {
        if (event.type === 'stage') {
          sendLog(win, `阶段 ${event.stage}：${event.name}（共 ${event.total ?? 0} 个候选）`)
        } else if (event.type === 'progress' && event.message) {
          sendLog(win, '  ' + event.message)
        } else if (event.type === 'result' && event.entry) {
          const e = event.entry
          sendLog(win, `  ✅ ${e.ip}:${e.port}  ${e.colo}  ${e.latency}ms  ${e.speed}MB/s`, 'ok')
        } else if (event.type === 'error') {
          sendLog(win, event.message ?? '优选失败', 'err')
        }
      },
    })

    if (result.entries.length === 0) {
      sendLog(win, '没有通过校验的节点，试试增大采样数或换端口', 'warn')
      return { ok: false, error: '无可用节点' }
    }

    sendLog(win, `优选完成，共 ${result.entries.length} 个可用 IP`, 'ok')
    sendLog(win, '可直接复制到面板「手动优选 IP」输入框：')
    for (const line of result.copyable.split('\n')) sendLog(win, '  ' + line, 'ok')

    win?.webContents.send('scan-result', {
      entries: result.entries,
      copyable: result.copyable,
      stats: result.stats,
    })
    return { ok: true, count: result.entries.length, copyable: result.copyable }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendLog(win, `优选失败：${message}`, 'err')
    return { ok: false, error: message }
  }
}

/** 探测线上部署状态：是否存在清单、版本是否落后 */
export async function checkDeployed(win: BrowserWindow | null): Promise<void> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim() || !secrets.kvNamespaceId.trim()) {
    sendLog(win, '未配置 Token 或 KV，跳过检查', 'warn')
    win?.webContents.send('deploy-status', { hasDeploy: false })
    return
  }
  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })
    const raw = await client.getKvValue(
      secrets.accountId.trim(),
      secrets.kvNamespaceId.trim(),
      'CFP_DEPLOY_MANIFEST'
    )
    if (!raw) {
      sendLog(win, '未检测到已有部署', 'info')
      win?.webContents.send('deploy-status', { hasDeploy: false })
      return
    }
    const manifest = JSON.parse(raw) as { build: string; at: string; controlProject: string; dataProject: string }
    sendLog(win, `已有部署：${manifest.controlProject} / ${manifest.dataProject}（版本 ${manifest.build}）`)
    win?.webContents.send('deploy-status', {
      hasDeploy: true,
      build: manifest.build,
      at: manifest.at,
      controlProject: manifest.controlProject,
      dataProject: manifest.dataProject,
    })
  } catch (err) {
    sendLog(win, `检查失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    win?.webContents.send('deploy-status', { hasDeploy: false })
  }
}

/** 保存 / 清除凭据 */
export function saveCredentials(input: {
  cfToken?: string
  accountId?: string
  kvNamespaceId?: string
  panelPassword?: string
}): { saved: boolean } {
  saveSecrets(input)
  return { saved: true }
}

export function wipeCredentials(): { wiped: boolean } {
  clearSecrets()
  return { wiped: true }
}

export function credentialsState(): { hasToken: boolean; accountId: string; kvNamespaceId: string } {
  const s = loadSecrets()
  return { hasToken: hasToken(), accountId: s.accountId, kvNamespaceId: s.kvNamespaceId }
}
