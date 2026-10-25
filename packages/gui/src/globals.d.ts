/**
 * 跨包动态导入的类型垫片。
 *
 * bridge.ts 在运行时按多个候选路径动态 import deploy-wizard 的源码
 * （开发时走 TS 源码，打包后走 dist）。tsc 无法解析这些猜测路径，
 * 这里用模块声明让类型检查通过，运行时由 esbuild 打包成真实 import。
 */
declare module '../../deploy-wizard/src/pages-deploy' {
  export function deployPagesSplit(options: {
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
    /** 实际生效的控制面面板密码（首次部署时随机生成） */
    panelPassword?: string
    warnings: string[]
  }>
}

declare module '../../deploy-wizard/src/cf-api' {
  export class CloudflareClient {
    constructor(options: { token: string; apiBase?: string })
    getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null>
  }
}

/** 渲染层的 window.cfpilot（由 preload 通过 contextBridge 注入） */
interface CFPilotLogEntry {
  message: string
  level: string
  at: number
}

/**
 * 账户配置视图（渲染层用）。
 *
 * ⚠️ **不包含 `cfToken`**：令牌明文只留在主进程，
 * 渲染层只能通过 `hasToken` 知道「配没配」。
 */
interface CFPilotProfileView {
  id: string
  name: string
  accountId: string
  accountName: string
  kvNamespaceId: string
  /** 是否已保存 Token */
  hasToken: boolean
  createdAt: string
  updatedAt: string
  /** 是否是当前激活项 */
  active: boolean
}

interface CFPilotDeployStatus {
  hasDeploy: boolean
  /** 结论：none 未部署 / outdated 可更新 / latest 已是最新 / blocked 前置条件不满足 */
  state: 'none' | 'outdated' | 'latest' | 'blocked'
  /** 阻塞原因（state=blocked 时才有） */
  reason?: 'no-token' | 'no-account' | 'no-kv'
  /** 线上（KV 清单）的构建版本 */
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
 * KV 候选列表项。
 *
 * ownership 标明该命名空间当前归谁，供界面提示用户选择。
 */
interface CFPilotKvOption {
  id: string
  title: string
  ownership: 'instance' | 'foreign' | 'cfpilot' | 'empty'
  controlProject?: string
  dataProject?: string
  at?: string
  build?: string
  controlSubdomain?: string
  dataSubdomain?: string
}

interface Window {
  cfpilot: {
    // ---- 多账户（profile）管理 ----
    /** 列出所有账户配置（不含 Token 明文） */
    listProfiles(): Promise<CFPilotProfileView[]>
    /** 新建账户配置并激活 */
    createProfile(name?: string): Promise<CFPilotProfileView>
    /** 更新账户配置 */
    updateProfile(
      id: string,
      patch: {
        name?: string
        cfToken?: string
        accountId?: string
        accountName?: string
        kvNamespaceId?: string
        panelPassword?: string
      }
    ): Promise<{ ok: boolean; error?: string }>
    /** 删除账户配置 */
    deleteProfile(id: string): Promise<{ deleted: boolean; activeId: string }>
    /** 切换激活账户 */
    switchProfile(id: string): Promise<{ ok: boolean; activeId: string }>
    /** 当前激活账户 */
    currentProfile(): Promise<CFPilotProfileView | null>

    runDeploy(
      params: {
        mode: 'auto' | 'fresh' | 'update'
        force: boolean
        forceKv: boolean
        newCredentials: boolean
        controlProject: string
        dataProject: string
        panelPath: string
        wsPath: string
      },
      kvNamespaceId?: string    ): Promise<{
      ok: boolean
      error?: string
      /** 控制面面板完整地址（含面板路径） */
      panelUrl?: string
      /** 面板密码（首次部署时随机生成） */
      panelPassword?: string
      /** 数据面域名 */
      dataUrl?: string
      uuid?: string
      wsPath?: string
    }>
  /**
   * 检查线上部署状态。
   *
   * 返回的 `state` 直接决定部署按钮的语义：
   * `none` → 首次部署；`outdated` → 更新部署；`latest` → 已是最新。
   */
  checkDeployed(kvNamespaceId?: string): Promise<{
    hasDeploy: boolean
    state: 'none' | 'outdated' | 'latest' | 'blocked'
    reason?: 'no-token' | 'no-account' | 'no-kv'
    /** 线上（KV 清单）的构建版本 */
    build?: string
    /** 本地内核产物的构建版本 */
    localBuild?: string
    at?: string
    controlProject?: string
    dataProject?: string
    controlSubdomain?: string
    dataSubdomain?: string
  }>
    runScan(params: {
      host: string
      wsPath: string
      probePath: string
      skipSpeed: boolean
      sample: number
      top: number
      /** 机房国家筛选（可多选，空 = 不筛选） */
      countries?: string[]
      speedMode?: 'auto' | 'probe' | 'url'
      speedUrl?: string
      speedConnections?: number
      speedDurationMs?: number
    }): Promise<{ ok: boolean; count?: number; copyable?: string; error?: string }>
    /** 自动识别数据面域名（优先自定义域名，回落 pages.dev） */
    detectScanHost(): Promise<{
      ok: boolean
      host?: string
      source?: 'custom' | 'pages'
      error?: string
    }>
    /** 自动识别数据面 WS 路径（读 KV 的 CONFIG，回落环境变量 WS_PATH） */
    detectScanPath(): Promise<{
      ok: boolean
      path?: string
      source?: 'kv' | 'env'
      error?: string
    }>
    /** 优选器支持的国家列表（与面板 / 命令行版同源） */
    listScanCountries(): Promise<Array<{ code: string; name: string }>>
    detectAccount(): Promise<{ accountId: string; accountName: string }>
    listKvOptions(accountId: string): Promise<{
      options: CFPilotKvOption[]
    }>
    createKvNamespace(accountId: string, title?: string): Promise<{ id: string; title: string } | null>
    checkEnvironment(): Promise<{ clean: boolean; findings: string[] }>
    saveCredentials(input: {
      cfToken?: string
      accountId?: string
      kvNamespaceId?: string
      panelPassword?: string
    }): Promise<{ saved: boolean }>
    wipeCredentials(): Promise<{ wiped: boolean }>
    credentialsState(): Promise<{ hasToken: boolean; accountId: string; kvNamespaceId: string }>
    openExternal(url: string): Promise<void>
    onLog(cb: (entry: CFPilotLogEntry) => void): () => void
    onDeployStatus(cb: (status: CFPilotDeployStatus) => void): () => void
    onScanResult(cb: (payload: CFPilotScanResult) => void): () => void
    onUpdateProgress(
      cb: (p: {
        received: number
        total: number
        /** 当前下载源名称（GitHub / 镜像名） */
        source: string
        /** 第几次尝试（1 = 直连） */
        attempt: number
      }) => void
    ): () => void
    checkUpdate(): Promise<{
      current: string
      latest: string | null
      hasUpdate: boolean
      downloadUrl: string | null
      notes: string
      error?: string
    }>
    downloadUpdate(url: string): Promise<{ ok: boolean; file: string }>
    applyUpdate(file: string): Promise<{ ok: boolean; error?: string }>
  }
}

interface CFPilotScanResult {
  entries: Array<{ ip: string; port: number; colo: string; latency: number; tlsMs: number; speed: number }>
  copyable: string
  stats: Record<string, number>
  skippedSpeed?: boolean
}
