/**
 * 界面层类型声明（@cfpilot/ui 专用）
 *
 * ## 这个文件为什么在 ui 包里
 *
 * 2026-10-27 界面源码从 packages/gui/src/renderer 抽到 packages/ui，
 * 连同它的类型声明一起搬过来 —— 界面只依赖 `window.cfpilot` 这个契约，
 * 不依赖任何 Electron 或 Node 类型。
 *
 * ## 与外壳的分工
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
       * 早期这个开关完全没接线，导致用户无法测试回填是否工作。
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
