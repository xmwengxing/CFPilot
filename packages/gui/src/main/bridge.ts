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
import {
  loadSecrets,
  saveSecrets,
  clearSecrets,
  hasToken,
  listProfiles,
  activeProfileId,
  createProfile,
  updateProfile,
  deleteProfile,
  setActiveProfile,
} from './config-store'
import { normalizePagesHost } from './pages-host'
import { runLocalScan, detectProxyInterference, listScanCountries, type ScanEvent } from './scanner'

// 国家列表与扫描逻辑同在 scanner.ts，这里转供 IPC 层使用
export { listScanCountries }
// 域名规整抽在 pages-host.ts（纯函数，可单测），这里转出保持历史 import 路径可用
export { normalizePagesHost }

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
    force?: boolean
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
    /** 实际生效的面板密码（首次部署时随机生成） */
    panelPassword?: string
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
    listPagesProjects(accountId: string): Promise<Array<CfPagesProject>>
  }
}

/** Pages 项目（listPagesProjects 的返回项，只取 GUI 用得到的字段） */
interface CfPagesProject {
  name: string
  subdomain: string
  /** 已绑定的自定义域名列表（不含 pages.dev 子域） */
  domains?: string[]
  /** 生产环境的部署配置（含环境变量与 KV 绑定） */
  deployment_configs?: {
    production?: {
      env_vars?: Record<string, { value: string }>
      kv_namespaces?: Record<string, { namespace_id: string }>
    }
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
  /** 明知 KV 属于别的实例仍然继续（跳过归属校验） */
  forceKv: boolean
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

/**
 * 部署结果。
 *
 * 成功时把用户真正要用的东西（面板地址 / 密码 / UUID / WS 路径）一并带回：
 * 这些值有相当一部分是部署时随机生成的（尤其是面板密码），
 * 不返回给渲染层就只能自己去 KV 的部署清单里翻。
 */
export interface DeployOutcome {
  ok: boolean
  error?: string
  /** 控制面面板完整地址（含面板路径） */
  panelUrl?: string
  /** 面板密码（首次部署时随机生成） */
  panelPassword?: string
  /** 数据面域名 */
  dataUrl?: string
  /** VLESS UUID */
  uuid?: string
  /** WS 路径 */
  wsPath?: string
}

/**
 * 执行部署，日志实时推给窗口。
 *
 * KV 的选择：
 *   1. 界面显式传入的 `kvNamespaceId`（本次部署专用，不落盘）
 *   2. 否则用本机保存的 `kvNamespaceId`
 *   3. 都没有 → 报错并提示去凭据页选一个或新建
 */
export async function runDeploy(
  win: BrowserWindow | null,
  params: DeployParams,
  kvNamespaceId?: string
): Promise<DeployOutcome> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim()) {
    sendLog(win, '尚未保存 Cloudflare API Token，请先填写并保存', 'err')
    return { ok: false, error: '缺少 API Token' }
  }
  const kvId = (kvNamespaceId ?? '').trim() || secrets.kvNamespaceId.trim()
  if (!kvId) {
    sendLog(
      win,
      '尚未选择 KV 命名空间。请到「Cloudflare 凭据」页点「刷新 KV 列表」，' +
        '选一个已有的，或点「新建 KV」为本次部署单独建一个。',
      'err'
    )
    return { ok: false, error: '缺少 KV 命名空间' }
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
      kvNamespaceId: kvId,
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
      force: params.forceKv,
      localBuild,
      bundles: { control, data },
      log: (m: string) => sendLog(win, m),
    })

    const panelUrl = `https://${result.control.subdomain}${result.panelPath ?? ''}`
    sendLog(win, `控制面：${panelUrl}`)
    sendLog(win, `数据面：https://${result.data.subdomain}`)
    if (result.uuid) sendLog(win, `UUID：${result.uuid}`)
    if (result.wsPath) sendLog(win, `WS 路径：${result.wsPath}`)
    if (result.panelPassword) sendLog(win, `面板密码：${result.panelPassword}`)

    if (result.warnings.length > 0) {
      for (const w of result.warnings) sendLog(win, w, 'warn')
    }

    // 明确的成功横幅：把用户真正要用的东西（面板地址 + 密码）集中放在最后，
    // 不用自己去日志里翻，也不用去 KV 里查密码。
    sendLog(win, '── 部署成功 ──', 'ok')
    sendLog(win, `面板地址：${panelUrl}`, 'ok')
    if (result.panelPassword) sendLog(win, `面板密码：${result.panelPassword}`, 'ok')
    return {
      ok: true,
      panelUrl,
      panelPassword: result.panelPassword,
      uuid: result.uuid,
      wsPath: result.wsPath,
      dataUrl: `https://${result.data.subdomain}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendLog(win, `部署失败：${message}`, 'err')
    return { ok: false, error: message }
  }
}

/**
 * 从产物里读构建版本。
 *
 * ## 版本串格式（build.mjs 的 buildVersion）
 *
 * `<git短hash>-<源码内容哈希前8位>`，例如 `ba44891-0b9cdd59`。
 *
 * ## 2026-10-25 修复：正则写死了「12 位纯数字」
 *
 * 老正则 `/["']([0-9a-f]{7,10}-\d{12})["']/` 只匹配 `-` 后面 12 位**十进制**数字，
 * 而实际后缀是 **8 位十六进制**（含 `a-f`）—— 永远匹配不上，
 * GUI 因此一直显示「版本 unknown」。
 *
 * 现在放宽为：短 hash + `-` + 4~16 位十六进制。
 */
async function readLocalBuild(dist: string): Promise<string | undefined> {
  try {
    const code = await readFile(join(dist, 'control.js'), 'utf8')
    // 同时兼容旧的 12 位数字格式与新格式，避免历史产物读不出
    const m = /["']([0-9a-f]{7,10}-(?:[0-9a-f]{4,16}|\d{12}))["']/i.exec(code)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** 优选参数 */
export interface ScanParams {
  host: string
  wsPath: string
  probePath: string
  skipSpeed: boolean
  sample: number
  top: number
  /**
   * 机房国家筛选（可多选，ISO 3166-1 alpha-2）。
   * 空 / 不传 = 不筛选，按采样设置跑全量。
   */
  countries?: string[]
  speedMode?: 'auto' | 'probe' | 'url'
  speedUrl?: string
  speedConnections?: number
  speedDurationMs?: number
}

/**
 * 自动检测账号。
 *
 * ## 为什么不再自动挑选 KV
 *
 * 旧实现会在账号下存在 KV 时直接复用 `namespaces[0]` 并落盘锁定，
 * 导致：
 *   - 可能选中别的项目的命名空间并写坏它；
 *   - 用户无法修改，唯一的解锁方式是「清除本机凭据」（连 Token 一起清掉）；
 *   - 账号下已有 KV 时就永远无法为新实例新建一个。
 *
 * 现在只解析账号；KV 由用户在界面上显式选择（见 listKvOptions）。
 */
export async function detectAccount(
  win: BrowserWindow | null
): Promise<{ accountId: string; accountName: string }> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim()) {
    sendLog(win, '尚未保存 API Token', 'err')
    return { accountId: '', accountName: '' }
  }
  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })

    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      sendLog(win, '该 Token 没有可见的账号', 'err')
      return { accountId: '', accountName: '' }
    }
    const account = accounts[0]!
    sendLog(win, `账号：${account.name}（${account.id}）`, 'ok')

    // 账号可能换了（换了 Token），因此每次检测都同步一次账号 ID。
    // 旧实现只在 kvNamespaceId 为空时才保存，导致换账号后仍用旧账号部署。
    saveSecrets({ accountId: account.id })

    return { accountId: account.id, accountName: account.name }
  } catch (err) {
    sendLog(win, `检测账号失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    return { accountId: '', accountName: '' }
  }
}

/**
 * KV 候选列表项。
 *
 * `ownership` 说明这个命名空间当前归谁：
 * - `instance`  本工具部署的实例（含清单）
 * - `foreign`   被其他项目占用（键不重叠，可共存）
 * - `cfpilot`   含 CFPilot 配置但无清单（残留）
 * - `empty`     空命名空间
 */
export interface KvOption {
  id: string
  title: string
  ownership: 'instance' | 'foreign' | 'cfpilot' | 'empty'
  /** instance 时：控制面 / 数据面项目名 */
  controlProject?: string
  dataProject?: string
  /** instance 时：部署时间与版本 */
  at?: string
  build?: string
  /** instance 时：面板与数据面域名 */
  controlSubdomain?: string
  dataSubdomain?: string
}

/**
 * 列出账号下的 KV 候选，供界面下拉选择。
 *
 * **不自动选中、不自动落盘** —— 归属由用户决定。
 */
export async function listKvOptions(
  win: BrowserWindow | null,
  accountId: string
): Promise<{ options: KvOption[] }> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim() || !accountId.trim()) {
    sendLog(win, '尚未保存 API Token 或未检测账号', 'err')
    return { options: [] }
  }
  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })
    const namespaces = await client.listKvNamespaces(accountId)
    const options: KvOption[] = []

    for (const ns of namespaces) {
      let ownership: KvOption['ownership'] = 'empty'
      let controlProject: string | undefined
      let dataProject: string | undefined
      let at: string | undefined
      let build: string | undefined
      let controlSubdomain: string | undefined
      let dataSubdomain: string | undefined

      const manifestRaw = await client.getKvValue(accountId, ns.id, 'CFP_DEPLOY_MANIFEST')
      if (manifestRaw) {
        try {
          const m = JSON.parse(manifestRaw) as {
            controlProject?: string
            dataProject?: string
            at?: string
            build?: string
            controlSubdomain?: string
            dataSubdomain?: string
          }
          ownership = 'instance'
          controlProject = m.controlProject
          dataProject = m.dataProject
          at = m.at
          build = m.build
          controlSubdomain = m.controlSubdomain
          dataSubdomain = m.dataSubdomain
        } catch {
          ownership = 'cfpilot'
        }
      } else {
        // 探测小写 `config` 键：某些同源项目用它存配置。
        // 存在即说明该命名空间被别的项目占用 —— 本工具**不写**这个键
        // （AGENTS.md 铁律 3），仅用它做归属判定。
        const foreignConfig = await client.getKvValue(accountId, ns.id, 'config')
        if (foreignConfig !== null) {
          ownership = 'foreign'
        } else {
          const cfpilot = await client.getKvValue(accountId, ns.id, 'CONFIG')
          if (cfpilot !== null) ownership = 'cfpilot'
        }
      }

      options.push({
        id: ns.id,
        title: ns.title,
        ownership,
        controlProject,
        dataProject,
        at,
        build,
        controlSubdomain,
        dataSubdomain,
      })
    }

    const instanceCount = options.filter((o) => o.ownership === 'instance').length
    sendLog(
      win,
      `找到 ${options.length} 个 KV 命名空间，其中 ${instanceCount} 个是 CFPilot 实例`,
      'ok'
    )
    return { options }
  } catch (err) {
    sendLog(win, `列出 KV 失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    return { options: [] }
  }
}

/**
 * 新建一个 KV 命名空间（用于部署新的实例）。
 */
export async function createKvNamespace(
  win: BrowserWindow | null,
  accountId: string,
  title?: string
): Promise<{ id: string; title: string } | null> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim() || !accountId.trim()) {
    sendLog(win, '尚未保存 API Token 或未检测账号', 'err')
    return null
  }
  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })
    const finalTitle = (title && title.trim()) || `cfpilot-gui-${Date.now().toString(36)}`
    const created = await client.createKvNamespace(accountId, finalTitle)
    sendLog(win, `已创建 KV：${created.title}（${created.id}）`, 'ok')
    return created
  } catch (err) {
    sendLog(win, `创建 KV 失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    return null
  }
}

/**
 * 优选前的环境预检。
 *
 * ## 为什么必须提醒用户关闭代理工具
 *
 * 扫描器要测的是「本机直连某个 Cloudflare IP 的真实质量」。
 * 但只要本机有代理工具在接管流量（TUN 模式、系统代理、或者规则里把这些
 * 目标 IP 走了代理），测出来的就是**到代理的延迟**，而不是到目标 IP 的延迟。
 *
 * 后果具有欺骗性：
 *   - 结果看起来是「正常的」，不会报错
 *   - 但所有候选 IP 的成绩趋于一致（都走同一条出口）
 *   - 优选出的 IP 导入客户端后大量 -1，因为从未真正直连验证过
 *
 * 因此这里做检测，并且**只警告不阻断**（用户可能确实需要走代理，
 * 例如目标域名在本地被污染；强行阻断反而挡住正常用法）。
 *
 * 判定逻辑来自 scanner-cli 的 net-env 模块，命令行版与图形版共用一套。
 */
async function preflightScan(
  win: BrowserWindow | null,
  host: string,
  path: string
): Promise<{ fatal: boolean }> {
  let fatal = false

  // 1) 路径格式
  if (!path.startsWith('/')) {
    sendLog(win, `WS 路径必须以 / 开头，当前是「${path}」`, 'err')
    fatal = true
  }

  // 2) 代理干扰检测
  const env = await detectProxyInterference(host)
  if (!env.clean) {
    sendLog(win, '', 'warn')
    sendLog(win, '⚠️ 网络环境提醒：检测到可能干扰优选的因素', 'warn')
    for (const f of env.findings) sendLog(win, '   ' + f.message, 'warn')
    sendLog(win, '', 'warn')
    sendLog(win, '   优选器测的是「本机直连该 IP」的真实质量。', 'warn')
    sendLog(win, '   只要流量被代理接管，测出来的就是到代理的延迟而不是到目标 IP 的延迟：', 'warn')
    sendLog(win, '     · 结果会看起来正常，但所有 IP 成绩趋于一致', 'warn')
    sendLog(win, '     · 导入客户端后大量 -1，因为从未真正直连验证过', 'warn')
    sendLog(win, '   → 建议先关闭代理工具（含 TUN 模式、系统代理），再重新优选。', 'warn')
    sendLog(win, '   → 如果必须开着代理，请把本程序加入直连/绕过名单。', 'warn')
    sendLog(win, '', 'warn')
  }

  // 3) 根路径提示
  if (path === '/') {
    sendLog(win, '提示：WS 路径填 / 表示「目标项目的 WebSocket 就在根路径」。', 'warn')
    sendLog(win, '      仅当该项目确实如此时才对；若它用的是 /vless、/<UUID> 这类路径，', 'warn')
    sendLog(win, '      用 / 会连不上（校验阶段就会失败，不会产生假结果）。', 'warn')
  }

  return { fatal }
}

/**
 * 独立的网络环境检测（供「检测网络环境」按钮调用）。
 */
export async function checkNetworkEnvironment(
  win: BrowserWindow | null
): Promise<{ clean: boolean; findings: string[] }> {
  sendLog(win, '── 网络环境检测 ──')
  const env = await detectProxyInterference()
  if (env.clean) {
    sendLog(win, '✅ 未检测到代理干扰，优选结果可信', 'ok')
    return { clean: true, findings: [] }
  }

  const lines: string[] = []
  sendLog(win, '⚠️ 检测到以下可能干扰优选的因素：', 'warn')
  for (const f of env.findings) {
    for (const line of f.message.split('\n')) {
      sendLog(win, '   ' + line, 'warn')
      lines.push(line)
    }
    sendLog(win, '   → ' + f.advice, 'warn')
    lines.push(f.advice)
  }
  sendLog(win, '', 'warn')
  sendLog(win, '   优选需要的是「本机直连」的测量结果，请先关闭代理再重试。', 'warn')
  return { clean: false, findings: lines }
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
  const host = params.host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (!host) {
    sendLog(win, '请填写 Worker 域名', 'err')
    return { ok: false, error: '缺少域名' }
  }
  const wsPath = params.wsPath.trim()
  if (!wsPath) {
    sendLog(win, '请填写 WS 路径（不知道就填 / 试试）', 'err')
    return { ok: false, error: '缺少 WS 路径' }
  }

  const pre = await preflightScan(win, host, wsPath)
  if (pre.fatal) return { ok: false, error: '参数不合法' }

  // 端口固定 443：Cloudflare Pages 的 HTTPS 入口就是 443，
  // 2053 等端口在部分网络环境会被中间设备阻断，给用户选只会引入不确定性。
  const port = 443
  const countries = (params.countries ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean)
  if (countries.length > 0) {
    sendLog(win, `国家筛选：${countries.join(' / ')}（只保留这些地区的机房）`)
  }

  sendLog(win, `开始优选：${host}${wsPath}（端口 ${port}）`)

  try {
    const result = await runLocalScan({
      host,
      port,
      wsPath,
      // 探针路径：用户填了就用，没填则用 CFPilot 的默认端点做「是否存在」探测
      probePath: params.probePath.trim() || '/__edge_probe',
      skipSpeed: params.skipSpeed,
      sample: params.sample,
      top: params.top,
      countries: countries.length > 0 ? countries : undefined,
      speedMode: params.speedMode ?? 'auto',
      speedUrl: params.speedUrl,
      speedConnections: params.speedConnections,
      speedDurationMs: params.speedDurationMs,
      onProgress: (event: ScanEvent) => {
        if (event.type === 'stage') {
          sendLog(win, `阶段 ${event.stage}：${event.name}（共 ${event.total ?? 0} 个候选）`)
        } else if (event.type === 'progress' && event.message) {
          sendLog(win, '  ' + event.message)
        } else if (event.type === 'result' && event.entry) {
          const e = event.entry
          const speed = params.skipSpeed ? '' : `  ${e.speed}MB/s`
          sendLog(win, `  ✅ ${e.ip}:${e.port}  ${e.colo}  ${e.latency}ms${speed}`, 'ok')
        } else if (event.type === 'error') {
          sendLog(win, event.message ?? '优选失败', 'err')
        }
      },
    })

    if (result.entries.length === 0) {
      sendLog(win, '', 'warn')
      sendLog(win, '没有 IP 通过 101 校验。常见原因：', 'warn')
      sendLog(win, '  1. WS 路径不对（必须与目标项目实际路径完全一致）', 'warn')
      sendLog(win, '  2. 目标项目在根路径不提供 WebSocket', 'warn')
      sendLog(win, '  3. TUN / fake-ip 拦截（见上方警告）', 'warn')
      sendLog(win, '  4. 采样数太小，试试调到 500~1000', 'warn')
      return { ok: false, error: '无可用节点' }
    }

    sendLog(win, `优选完成，共 ${result.entries.length} 个可用 IP`, 'ok')
    if (params.skipSpeed) {
      sendLog(win, '（已跳过测速，按延迟排序；速度列显示 — 属正常）', 'warn')
    }
    sendLog(win, '可直接复制到面板「手动优选 IP」输入框：')
    for (const line of result.copyable.split('\n')) sendLog(win, '  ' + line, 'ok')

    win?.webContents.send('scan-result', {
      entries: result.entries,
      copyable: result.copyable,
      stats: result.stats,
      skippedSpeed: params.skipSpeed,
    })
    return { ok: true, count: result.entries.length, copyable: result.copyable }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendLog(win, `优选失败：${message}`, 'err')
    return { ok: false, error: message }
  }
}

/**
 * 部署状态（供部署页显示）。
 *
 * `state` 是给 UI 用的结论，UI 不必自己拼 if-else：
 *   - `none`      已确认没有部署（KV 里没有清单）
 *   - `outdated`  已部署，但版本与本地不一致（可更新）
 *   - `latest`    已部署，且线上就是当前版本
 *   - `blocked`   **前置条件不满足**（没填令牌 / 没选 KV / 没检测账号），
 *                 此时「有没有部署」是未知的，不能当成 `none`
 */
export interface DeployStatus {
  hasDeploy: boolean
  state: 'none' | 'outdated' | 'latest' | 'blocked'
  /** 阻塞原因（state=blocked 时给 UI 展示与引导） */
  reason?: 'no-token' | 'no-account' | 'no-kv'
  /** 线上（KV 清单里记录的）构建版本 */
  build?: string
  /** 本地内核产物的构建版本 */
  localBuild?: string
  at?: string
  controlProject?: string
  dataProject?: string
  controlSubdomain?: string
  dataSubdomain?: string
}

/**
 * 探测线上部署状态：是否存在清单、线上版本与本地内核版本是否一致。
 *
 * ## 为什么要比对版本（2026-10-25）
 *
 * 之前只显示清单里的 `build`，用户看到一串 `hash-xxxx` 也不知道是不是最新。
 * 现在同时读**本地** `dist/control.js` 的构建版本，两者对比：
 * 不一致就提示「有更新可用」，UI 把按钮变成「更新部署」。
 *
 * ## 为什么不用「仓库最新版」比对
 *
 * 部署到 Cloudflare 的是**内核产物**（由本机构建），不是 npm 包；
 * 本地构建版本就是「能部署的最好版本」。仓库 latest 只用于 GUI 自身升级，
 * 与这个检查无关 —— 混在一起会让用户以为要重新下载 exe。
 */
export async function checkDeployed(
  win: BrowserWindow | null,
  kvNamespaceId?: string
): Promise<DeployStatus> {
  const secrets = loadSecrets()
  const kvId = (kvNamespaceId ?? '').trim() || secrets.kvNamespaceId.trim()
  const localBuild = await readLocalBuild(findDistDir())

  /**
   * 前置条件不满足时的统一出口。
   *
   * ⚠️ 关键：这种情况**不能**返回 `state: 'none'`（2026-10-25 用户反馈）。
   * `none` 的含义是「已经查过、确实没部署」，UI 会显示「开始首次部署」；
   * 而没填令牌时「有没有部署」根本无从判断 —— 报成 `none` 会误导用户
   * 以为自己没部署过，进而重复部署一个新实例。
   */
  const blocked = (
    reason: 'no-token' | 'no-account' | 'no-kv',
    message: string,
    hint?: string
  ): DeployStatus => {
    sendLog(win, message, 'err')
    if (hint) sendLog(win, hint, 'warn')
    const status: DeployStatus = { hasDeploy: false, state: 'blocked', reason, localBuild }
    win?.webContents.send('deploy-status', status)
    return status
  }

  if (!secrets.cfToken.trim()) {
    return blocked(
      'no-token',
      '还没有填写 Cloudflare API Token，无法检查部署状态',
      '请先到「Cloudflare 凭据」页填入 Token 并保存，再回来点「检查状态」。'
    )
  }
  if (!secrets.accountId.trim()) {
    return blocked(
      'no-account',
      '还没有检测到 Cloudflare 账号',
      '请到「Cloudflare 凭据」页点「检测账号」，确认 Token 能读取到账号。'
    )
  }
  if (!kvId) {
    return blocked(
      'no-kv',
      '还没有选择 KV 命名空间，无法检查部署状态',
      '请到「Cloudflare 凭据」页点「刷新 KV 列表」选择一个，或点「新建 KV」。'
    )
  }

  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })
    const raw = await client.getKvValue(
      secrets.accountId.trim(),
      kvId,
      'CFP_DEPLOY_MANIFEST'
    )
    if (!raw) {
      sendLog(win, '该 KV 里没有部署记录 —— 可以「首次部署」', 'info')
      const status: DeployStatus = { hasDeploy: false, state: 'none', localBuild }
      win?.webContents.send('deploy-status', status)
      return status
    }

    const manifest = JSON.parse(raw) as {
      build?: string
      at?: string
      controlProject?: string
      dataProject?: string
      controlSubdomain?: string
      dataSubdomain?: string
    }
    // 历史遗留：早期向导在「没读到本地版本」时会写入字符串 `'unknown'`。
    // 它不是真版本号，语义等同「无记录」—— 必须当成空处理，
    // 否则界面会出现「线上内核 unknown ≠ 本地 xxx」这种谁也看不懂的话。
    const rawRemote = (manifest.build ?? '').trim()
    const remoteBuild = rawRemote.toLowerCase() === 'unknown' ? '' : rawRemote
    const same = Boolean(remoteBuild && localBuild && remoteBuild === localBuild)
    const state: DeployStatus['state'] = same ? 'latest' : 'outdated'

    // 日志措辞要说人话：不展示 `unknown` 这种占位符，直接说明「没有版本记录」
    if (same) {
      sendLog(win, `✅ 线上已是最新内核（${remoteBuild}）`, 'ok')
    } else if (!remoteBuild) {
      sendLog(
        win,
        '线上部署记录里没有内核版本号（可能是较早版本部署的），建议更新一次以记录版本',
        'warn'
      )
    } else if (!localBuild) {
      sendLog(win, `线上内核 ${remoteBuild}，但读不到本地内核版本（产物可能缺失），建议重新构建`, 'warn')
    } else {
      sendLog(win, `线上内核 ${remoteBuild} ≠ 本地 ${localBuild}，可更新部署`, 'warn')
    }
    sendLog(
      win,
      `实例：控制面 ${manifest.controlProject ?? '?'} / 数据面 ${manifest.dataProject ?? '?'}` +
        (manifest.at ? `（部署于 ${manifest.at}）` : ''),
      'info'
    )

    const status: DeployStatus = {
      hasDeploy: true,
      state,
      build: remoteBuild || undefined,
      localBuild,
      at: manifest.at,
      controlProject: manifest.controlProject,
      dataProject: manifest.dataProject,
      controlSubdomain: manifest.controlSubdomain,
      dataSubdomain: manifest.dataSubdomain,
    }
    win?.webContents.send('deploy-status', status)
    return status
  } catch (err) {
    sendLog(win, `检查部署状态失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    const status: DeployStatus = { hasDeploy: false, state: 'none', localBuild }
    win?.webContents.send('deploy-status', status)
    return status
  }
}

/**
 * 自动识别数据面域名（供优选页「自动识别域名」按钮）。
 *
 * ## 优先级
 *
 *   1. 数据面 Pages 项目绑定的**自定义域名**（`domains` 里非 pages.dev 的条目）
 *   2. 数据面 Pages 项目的 `<subdomain>.pages.dev`
 *
 * ## 为什么自定义域名优先
 *
 * pages.dev 是 Cloudflare 给项目提供的生产链接，在部分网络环境（尤其国内）
 * 会因 SNI 被阻断或 QoS，拿它当优选目标本身就测不出真实可用性；
 * 自定义域名走用户自己的 zone，是唯一推荐的做法。
 *
 * ## 数据来源
 *
 * KV 里的部署清单（`CFP_DEPLOY_MANIFEST`）记录了 `dataProject` 项目名，
 * 再用 `listPagesProjects` 找到该项目当前的域名列表。
 */
export async function detectDataPlaneHost(
  win: BrowserWindow | null
): Promise<{ ok: boolean; host?: string; source?: 'custom' | 'pages'; error?: string }> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim()) {
    sendLog(win, '尚未保存 API Token，无法自动识别域名', 'err')
    return { ok: false, error: '尚未保存 API Token' }
  }
  const accountId = secrets.accountId.trim()
  const kvId = secrets.kvNamespaceId.trim()
  if (!accountId || !kvId) {
    sendLog(win, '未检测账号或未选择 KV，无法自动识别域名', 'err')
    return { ok: false, error: '未检测账号或未选择 KV' }
  }
  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })

    // 1) 从部署清单拿数据面项目名
    const raw = await client.getKvValue(accountId, kvId, 'CFP_DEPLOY_MANIFEST')
    if (!raw) {
      sendLog(win, 'KV 里没有部署清单，请先部署或点「检查更新」', 'err')
      return { ok: false, error: '未找到部署清单' }
    }
    let manifest: { dataProject?: string; dataSubdomain?: string }
    try {
      manifest = JSON.parse(raw) as { dataProject?: string; dataSubdomain?: string }
    } catch {
      sendLog(win, '部署清单不是合法 JSON', 'err')
      return { ok: false, error: '部署清单解析失败' }
    }
    const dataProject = (manifest.dataProject ?? '').trim()
    if (!dataProject) {
      sendLog(win, '部署清单里没有数据面项目名', 'err')
      return { ok: false, error: '清单缺少 dataProject' }
    }

    // 2) 列出 Pages 项目，找到数据面对应的那个
    const projects = await client.listPagesProjects(accountId)
    const project = projects.find((p) => p.name === dataProject)
    if (!project) {
      // 项目被删了但清单还在：退回清单里记录的子域
      if (manifest.dataSubdomain) {
        sendLog(win, `Pages 项目 ${dataProject} 不存在，退回清单记录的子域`, 'warn')
        return { ok: true, host: manifest.dataSubdomain, source: 'pages' }
      }
      sendLog(win, `找不到 Pages 项目：${dataProject}`, 'err')
      return { ok: false, error: `找不到 Pages 项目 ${dataProject}` }
    }

    // 3) 自定义域名优先；pages.dev 子域兜底
    const custom = (project.domains ?? []).filter((d) => d && !d.endsWith('.pages.dev'))
    if (custom.length > 0) {
      sendLog(win, `识别到自定义域名：${custom[0]}`, 'ok')
      return { ok: true, host: custom[0]!, source: 'custom' }
    }

    // ⚠️ `project.subdomain` 的取值形态在不同 API 版本下不一致：
    // 有时是 `cpdata`，有时已经是 `cpdata.pages.dev`。
    // 早年这里无条件拼 `.pages.dev`，导致出现 `cpdata.pages.dev.pages.dev`
    // 这种双后缀（2026-10-25 用户反馈）。因此先规整再去重。
    const fallback =
      normalizePagesHost(project.subdomain) || normalizePagesHost(manifest.dataSubdomain)
    if (!fallback) {
      sendLog(win, `项目 ${dataProject} 没有可用域名`, 'err')
      return { ok: false, error: '项目没有可用域名' }
    }
    sendLog(win, `未绑定自定义域名，使用 pages.dev 域名：${fallback}`, 'warn')
    sendLog(win, '建议尽快绑定自定义域名——pages.dev 生产链接在部分网络会被阻断', 'warn')
    return { ok: true, host: fallback, source: 'pages' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendLog(win, `自动识别域名失败：${message}`, 'err')
    return { ok: false, error: message }
  }
}


/**
 * 自动识别数据面的 WebSocket 路径。
 *
 * ## 为什么需要
 *
 * 优选时必须让 WS 路径与目标项目**完全一致**，否则一个 IP 都选不出来
 * （握手 101 校验全失败）。而路径是部署时随机生成的（一长串字符），
 * 用户很难记住或找回来。
 *
 * ## 数据来源（三级，从权威到兜底）
 *
 * 1. **KV 的 `CONFIG` 键**：内核把完整配置（含 `wsPath`）写在这里，
 *    这是最权威的来源 —— 数据面实际读的就是它。
 * 2. **环境变量 `WS_PATH`**：部署向导写进 Pages 项目的变量，
 *    早期版本或未写 KV 时靠它。
 * 3. 都没有则失败，提示用户去面板或部署日志里找。
 *
 * ## 为什么不用「探测」的方式
 *
 * 理论上可以拿一批候选路径逐个打 WS 握手试出来，但：
 *   - 每次尝试都是一次真实的 TLS + WS 握手（慢）；
 *   - 路径是随机的，暴力枚举不现实；
 *   - 猜错了在服务端留下大量 404，没有收益。
 * 直接读配置是唯一可靠且零成本的做法。
 */
export async function detectDataPlanePath(
  win: BrowserWindow | null
): Promise<{ ok: boolean; path?: string; source?: 'kv' | 'env'; error?: string }> {
  const secrets = loadSecrets()
  if (!secrets.cfToken.trim()) {
    sendLog(win, '尚未保存 API Token，无法自动识别 WS 路径', 'err')
    return { ok: false, error: '尚未保存 API Token' }
  }
  const accountId = secrets.accountId.trim()
  const kvId = secrets.kvNamespaceId.trim()
  if (!accountId || !kvId) {
    sendLog(win, '未检测账号或未选择 KV，无法自动识别 WS 路径', 'err')
    return { ok: false, error: '未检测账号或未选择 KV' }
  }

  try {
    const cfApi = loadCfApi()
    const client = new cfApi.CloudflareClient({ token: secrets.cfToken })

    // ---- 1) KV 的 CONFIG（最权威）----
    const rawConfig = await client.getKvValue(accountId, kvId, 'CONFIG')
    if (rawConfig) {
      try {
        const config = JSON.parse(rawConfig) as { wsPath?: string }
        const wsPath = (config.wsPath ?? '').trim()
        if (wsPath) {
          sendLog(win, `已从 KV 配置读到 WS 路径：${wsPath}`, 'ok')
          return { ok: true, path: wsPath, source: 'kv' }
        }
      } catch {
        sendLog(win, 'KV 里的 CONFIG 不是合法 JSON，改读环境变量', 'warn')
      }
    }

    // ---- 2) 环境变量 WS_PATH（部署向导写入）----
    // 需要先知道是哪个 Pages 项目 —— 从部署清单拿项目名，再从项目列表里取详情
    const rawManifest = await client.getKvValue(accountId, kvId, 'CFP_DEPLOY_MANIFEST')
    if (rawManifest) {
      try {
        const manifest = JSON.parse(rawManifest) as { dataProject?: string }
        const dataProject = (manifest.dataProject ?? '').trim()
        if (dataProject) {
          // GUI 的 CfApiModule 没暴露 getPagesProject，用列表接口取（多一次全量但足够）
          const projects = await client.listPagesProjects(accountId)
          const project = projects.find((p) => p.name === dataProject)
          const envVars = project?.deployment_configs?.production?.env_vars ?? {}
          const wsPath = (envVars.WS_PATH?.value ?? envVars.PATH?.value ?? '').trim()
          if (wsPath) {
            sendLog(win, `已从数据面环境变量读到 WS 路径：${wsPath}`, 'ok')
            return { ok: true, path: wsPath, source: 'env' }
          }
        }
      } catch {
        /* 清单解析失败 → 继续走失败分支 */
      }
    }

    sendLog(win, 'KV 配置与数据面环境变量里都没有 WS 路径', 'err')
    sendLog(win, '请到面板「订阅」页查看，或重新部署一次让向导写入 KV', 'warn')
    return { ok: false, error: '未找到 WS 路径（KV 与环境变量均为空）' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendLog(win, `自动识别 WS 路径失败：${message}`, 'err')
    return { ok: false, error: message }
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
}export function wipeCredentials(): { wiped: boolean } {
  clearSecrets()
  return { wiped: true }
}

export function credentialsState(): { hasToken: boolean; accountId: string; kvNamespaceId: string } {
  const s = loadSecrets()
  return { hasToken: hasToken(), accountId: s.accountId, kvNamespaceId: s.kvNamespaceId }
}

/* ------------------------------------------------------------------ */
/* 多账户（profile）管理                                               */
/* ------------------------------------------------------------------ */

/**
 * 对外暴露的 profile 视图。
 *
 * **绝不包含 `cfToken` 全文** —— 渲染层只需要知道「有没有配」，
 * 不需要拿到明文令牌。这样即使渲染层被注入脚本，也偷不到 Token。
 */
export interface ProfileView {
  id: string
  name: string
  accountId: string
  accountName: string
  kvNamespaceId: string
  /** 是否已保存 Token（不返回 Token 本身） */
  hasToken: boolean
  /** Token 是否看起来是脱敏占位（也用于 UI 判断） */
  createdAt: string
  updatedAt: string
  /** 是否是当前激活项 */
  active: boolean
}

/** 列出所有账户配置 */
export function listCredentialProfiles(): ProfileView[] {
  const activeId = activeProfileId()
  return listProfiles().map((p) => ({
    id: p.id,
    name: p.name,
    accountId: p.accountId,
    accountName: p.accountName,
    kvNamespaceId: p.kvNamespaceId,
    hasToken: p.cfToken.trim().length > 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    active: p.id === activeId,
  }))
}

/** 新建账户配置并激活 */
export function createCredentialProfile(name?: string): ProfileView {
  const profile = createProfile(name)
  return {
    id: profile.id,
    name: profile.name,
    accountId: '',
    accountName: '',
    kvNamespaceId: '',
    hasToken: false,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    active: true,
  }
}

/** 更新账户配置（不需要改的字段不传） */
export function updateCredentialProfile(
  id: string,
  patch: {
    name?: string
    cfToken?: string
    accountId?: string
    accountName?: string
    kvNamespaceId?: string
    panelPassword?: string
  }
): { ok: boolean; error?: string } {
  try {
    updateProfile(id, patch)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 删除账户配置 */
export function deleteCredentialProfile(id: string): { deleted: boolean; activeId: string } {
  return deleteProfile(id)
}

/**
 * 切换激活账户。
 *
 * ⚠️ 切换后必须让上游重新检测账号 / KV —— 不同账户下的 KV 完全不同。
 * 因此这里只负责落盘，UI 负责提示用户重新点「检测账号」。
 */
export function switchCredentialProfile(id: string): { ok: boolean; activeId: string } {
  return setActiveProfile(id)
}

/** 当前激活账户（供 UI 顶部显示） */
export function currentCredentialProfile(): ProfileView | null {
  const all = listCredentialProfiles()
  return all.find((p) => p.active) ?? null
}
