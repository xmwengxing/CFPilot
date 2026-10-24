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
import { runLocalScan, detectProxyInterference, listScanCountries, type ScanEvent } from './scanner'

// 国家列表与扫描逻辑同在 scanner.ts，这里转供 IPC 层使用
export { listScanCountries }

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
    /** 数据面实现：self（自研，默认）/ vendor（CFNext 原版） */
    dataPlane?: 'vendor' | 'self'
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
  /**
   * 数据面实现：`self`（自研，默认）/ `vendor`（CFNext 原版）。
   *
   * 2026-10-23 起自研为默认 —— 同环境对照实验已确认两者可用性持平，
   * 而自研额外提供失败分级诊断、SOCKS5/HTTP/HTTPS 代理池、
   * DoH 优选解析与可配置的反代入口。
   */
  dataPlane: 'self' | 'vendor'
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
): Promise<{ ok: boolean; error?: string }> {
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
      // 数据面实现：self（默认）/ vendor
      dataPlane: params.dataPlane ?? 'self',
      mode: params.mode,
      keepCredentials: !params.newCredentials,
      skipSameVersion: !params.force,
      force: params.forceKv,
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
 *   - 可能选中别的项目（甚至用户自己的原版 CFNext）的命名空间并写坏它；
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
 * - `cfnext`    疑似原版 CFNext 项目占用（键不重叠，可共存）
 * - `cfpilot`   含 CFPilot 配置但无清单（残留）
 * - `empty`     空命名空间
 */
export interface KvOption {
  id: string
  title: string
  ownership: 'instance' | 'cfnext' | 'cfpilot' | 'empty'
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
        const cfnext = await client.getKvValue(accountId, ns.id, 'config')
        if (cfnext !== null) {
          ownership = 'cfnext'
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

/** 探测线上部署状态：是否存在清单、版本是否落后 */
export async function checkDeployed(
  win: BrowserWindow | null,
  kvNamespaceId?: string
): Promise<void> {
  const secrets = loadSecrets()
  const kvId = (kvNamespaceId ?? '').trim() || secrets.kvNamespaceId.trim()
  if (!secrets.cfToken.trim() || !kvId) {
    sendLog(win, '未配置 Token 或未选择 KV，跳过检查', 'warn')
    win?.webContents.send('deploy-status', { hasDeploy: false })
    return
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
    const fallback = project.subdomain ? `${project.subdomain}.pages.dev` : manifest.dataSubdomain
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
