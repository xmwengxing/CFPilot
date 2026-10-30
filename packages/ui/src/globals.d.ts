/**
 * 界面层类型声明（@cfpilot/ui 专用）
 *
 * 连同它的类型声明一起搬过来 —— 界面只依赖 `window.cfpilot` 这个契约，
 * 不依赖任何 Electron 或 Node 类型。
 *
 *   本文件声明的 `window.cfpilot` 是**契约**，
 *   由各外壳实现：
 *     - Go 版：packages/desktop/webui/adapter.js（HTTP fetch + SSE）
 *     - Electron 版（本地实验）：packages/gui/src/preload/preload.ts（IPC）
 *
 *   ⚠️ 改动这个契约必须同步两个外壳，否则界面运行时会读 undefined。
 *   `scripts/check-adapter-contract.mjs` 会校验 Go 版适配层是否符合本契约。
 */

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

/**
 * 日志读取结果（对应 Go 版的 GET /api/logs?tail=N）。
 *
 * ⚠️ 本文件是**全局脚本**（没有 import/export），
 *    里面的 interface 靠「全局增强」对整个项目可见。
 *    所以这里**不能**写 `export` —— 一旦写成模块，
 *    `interface Window` 就不再增强全局 Window，界面全部报类型错。
 */
interface LogsResult {
  ok: boolean
  /** 日志文件完整路径 */
  path?: string
  /** 文件大小（字节） */
  size?: number
  /** 人类可读的大小，如 "120.6 KB" */
  sizeText?: string
  /** 返回的**最后 N 行** */
  lines?: string[]
  /** 文件总行数 */
  total?: number
  /** 是否只返回了尾部（总行数 > 返回行数） */
  truncated?: boolean
  /** 轮转出去的历史日志文件名（可能为空） */
  rotated?: string[]
  error?: string
}

/**
 * 一键优选结果（对应 Go 版的 POST /api/scan/quick）。
 *
 * 与托盘菜单里的「一键优选 IP」是同一个后端接口。
 */
interface QuickScanResult {
  ok: boolean
  /** 优选出来的 IP 数量 */
  count?: number
  /** 数据面域名 */
  host?: string
  /** 控制面面板域名 */
  panel?: string
  /** 给用户看的成功提示 */
  message?: string
  error?: string
}

interface Window {
  cfpilot: {
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
        /**
         * 本次部署要设置的面板密码（可选）。
         *
         * 留空 = 首次随机生成 / 更新沿用原密码。
         * ⚠️ 与账户里的 panelPassword（改已部署面板密码用）严格分开。
         */
        panelPassword?: string
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

  /**
   * 读取部署清单里保存的面板凭据。
   *
   * 为什么需要：Cloudflare 云端环境变量是加密的（只显示 ****），
   * 密码一旦没记录就彻底拿不回来。这里从本机部署清单读明文。
   */
  getDeployCredentials(kvNamespaceId?: string): Promise<{
    ok: boolean
    error?: string
    /** 面板完整地址（https://<控制面域名><面板路径>） */
    panelUrl?: string
    panelPassword?: string
    uuid?: string
    wsPath?: string
    dataSubdomain?: string
    build?: string
    at?: string
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
      /**
       * 为 true 表示「只输出列表，不回填面板」。
       *
       * 界面上的同名勾选框控制它；Go 后端据此跳过回填。
       */
      noCallback?: boolean
      /** 回填用的扫描令牌（面板一次性令牌 / SCANNER_TOKEN） */
      scanToken?: string
      /** 自定义回填地址（留空由 host 推导） */
      callbackUrl?: string
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
    /**
     * 自动获取面板的一次性扫描令牌。
     *
     * 用保存的面板密码登录控制面，再调 /api/v1/scanner-token 换令牌。
     * 令牌有效期 10 分钟，用于回填优选结果。
     */
    /**
     * 把优选结果回填到面板的「手动优选 IP」。
     *
     * 服务端在回填那一刻才取临时令牌并写入，
     * 所以不会出现「优选耗时过长导致令牌过期」。
     */
    pushScanResults(lines: string[]): Promise<{
      ok: boolean
      count?: number
      host?: string
      error?: string
    }>
    fetchScannerToken(host?: string, password?: string): Promise<{
      ok: boolean
      token?: string
      host?: string
      expiresIn?: number
      error?: string
    }>
    /**
     * 优选器支持的国家目录（与 CLI / 面板同源）。
     *
     * `code` 是**国家码**（HK / JP / US），不是机房三字码；
     * 机房码放在 `colos` 里，只用于展示与搜索命中。
     */
    listScanCountries(): Promise<
      Array<{ code: string; name: string; group: string; colos: string[] }>
    >
    /**
     * 机房国家的分组筛选：分组名 → 该组的**国家码**。
     *
     * 界面把分组当关键字传给扫描器，展开由后端负责；
     * 表只在后端维护一份，这里拿不到时返回 `{}`。
     */
    listScanCountryGroups(): Promise<Record<string, string[]>>
    /**
     * 读取本机日志文件（末尾若干行）。
     *
     * @param tail 取末尾多少行（默认 500，后端上限 5000）
     */
    getLogs(tail?: number): Promise<LogsResult>
    /**
     * 一键优选并回填面板。
     *
     * 与托盘菜单里的「一键优选 IP」是同一个后端接口：
     * 后台跑完整优选 + 回填面板，完成后弹系统通知。
     */
    quickScan(): Promise<QuickScanResult>
    /**
     * 读取本机保存的优选历史（最新在前）。
     *
     * 优选成功由后端自动留底（本地优选 / 一键优选都会写），界面只读。
     */
    getScanHistory(): Promise<{
      ok: boolean
      sessions: ScanHistorySession[]
      error?: string
    }>
    /** 删除一条优选历史会话 */
    deleteScanHistory(id: string): Promise<{ ok: boolean; error?: string }>
    /**
     * 对选中的 IP 跑分层可用性复测（TCP → TLS → WS101，可选测速）。
     *
     * host / wsPath / probePath 必须用历史会话里保存的参数；
     * 传 sessionId 时复测结论会写回该历史会话的条目。
     */
    reTestIps(params: {
      sessionId?: string
      host: string
      wsPath?: string
      probePath?: string
      withSpeed?: boolean
      targets: Array<{ ip: string; port: number }>
    }): Promise<{ ok: boolean; results?: ReTestIPResult[]; error?: string }>
    /**
     * 在文件管理器中打开文件所在的文件夹。
     *
     * 日志页的「打开日志文件所在文件夹」用它 ——
     * 后端打开的是传入文件**所在目录**，所以传日志文件本身即可。
     */
    revealFile(file: string): Promise<{ ok: boolean; path?: string; error?: string }>
    detectAccount(): Promise<{ accountId: string; accountName: string }>
    /**
     * 链式代理：把内嵌的部署脚本取回来（原文 + 手动执行的命令）。
     *
     * 用途是「先审计再执行」，以及 ssh 走不通时复制命令到终端手动跑 ——
     * 终端里 ssh 才能正常提示输入密码，桌面进程没有终端。
     */
    chainScript(): Promise<{ script: string; command: string }>
    /**
     * 链式代理：通过本机 ssh 在远端 VPS 上执行部署脚本。
     *
     * 链路形态：客户端 → Worker（前置）→ 你的 VPS（落地）→ 目标站。
     * 成功后返回的 output 里含一行 `socks5://用户:口令@IP:端口`，
     * 粘进面板「出站与高级」的 SOCKS5 即可。
     */
    chainDeploy(params: { host: string; port: number }): Promise<{
      ok: boolean
      code: number
      output: string
      /** 失败时的人话提示（权限/解析/端口不通等） */
      error?: string
    }>
    listKvOptions(accountId: string): Promise<{
      options: CFPilotKvOption[]
    }>
    createKvNamespace(accountId: string, title?: string): Promise<{ id: string; title: string } | null>
    checkEnvironment(): Promise<{ clean: boolean; findings: string[] }>
    /**
     * 本地服务状态（桌面版自身的 HTTP 服务）。
     *
     * 用于「运行状态」卡片：端口、已运行时长、配置文件位置。
     */
    serviceStatus(): Promise<{
      running: boolean
      host: string
      port: number
      url: string
      uptimeSeconds: number
      keepInTray: boolean
      settingsFile: string
      pid: number
    }>
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

/** 优选历史：某条 IP 的最近一次复测结论（可为空 = 从未复测） */
interface ScanHistoryLastTest {
  at: string
  tcpMs: number
  tlsMs: number
  wsOk: boolean
  colo: string
  speed: number
  ok: boolean
  error?: string
}

/** 优选历史：单条结果 */
interface ScanHistoryEntry {
  ip: string
  port: number
  colo: string
  latency: number
  tlsMs: number
  speed: number
  lastTest?: ScanHistoryLastTest
}

/** 优选历史：一次优选会话的留底 */
interface ScanHistorySession {
  id: string
  /** ISO 时间（UTC） */
  at: string
  host: string
  wsPath: string
  probePath: string
  skipSpeed: boolean
  /** "local"（本地真连接优选）| "quick"（一键优选） */
  source: string
  entries: ScanHistoryEntry[]
}

/** 单 IP 复测结果（分层：TCP → TLS → WS101，可选测速） */
interface ReTestIPResult {
  ip: string
  port: number
  tcpMs: number
  tlsMs: number
  wsOk: boolean
  colo: string
  speed: number
  /** 三层全部通过 */
  ok: boolean
  /** 第一道失败层的原因 */
  error?: string
}
