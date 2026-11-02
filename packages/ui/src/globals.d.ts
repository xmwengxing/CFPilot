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
  /**
   * 部署结束事件才带的最终结论。
   *
   * 同一个通道既推「状态快照」（hasDeploy/state/…），
   * 也推「一次部署的最终结果」（ok/error），所以两者都必须是可空的。
   */
  ok?: boolean
  /** 部署失败原因（ok=false 时） */
  error?: string
  hasDeploy?: boolean
  /** 结论：none 未部署 / outdated 可更新 / latest 已是最新 / blocked 前置条件不满足 */
  state?: 'none' | 'outdated' | 'latest' | 'blocked'
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
         * 数据面部署形态：pages（默认）/ workers。
         *
         * 留空 = 沿用部署清单里记录的形态（没有清单则 pages）。
         * 与清单不一致时后端会当成形态切换：新数据面上线后删除旧的并迁移域名。
         */
        dataPlaneMode?: 'pages' | 'workers'
        /**
         * Workers 数据面的**节点域名**（写进控制面 DATA_HOST）。
         * 工具不会绑定它，部署后需用户到 Worker 的「域」标签页自行添加。
         */
        dataHost?: string
        /**
         * 本次部署要设置的面板密码（可选）。
         *
         * 留空 = 首次随机生成 / 更新沿用原密码。
         * ⚠️ 与账户里的 panelPassword（改已部署面板密码用）严格分开。
         */
        panelPassword?: string
      },
      kvNamespaceId?: string    ): Promise<{
      /**
       * 部署是否已成功完成。
       *
       * ⚠️ 可空：Go 版把部署放到后台执行，接口**立即返回** `{started:true}`
       * 且不带 ok —— 最终结果走 SSE 的 deploy-status 事件。
       */
      ok?: boolean
      /**
       * 后端已受理、正在后台执行。
       *
       * 为 true 时不要按 `ok` 判断成败：那一刻既没成功也没失败。
       */
      started?: boolean
      error?: string
      /**
       * 全新部署时后端**新建**的 KV 命名空间 ID（其余模式不带）。
       *
       * 全新部署 = 再开一套实例，不能复用凭据页选中的 KV ——
       * 内核的 KV 键全局平铺，复用会把新凭据写进原实例的 CONFIG。
       */
      kvNamespaceId?: string
      /** 全新部署时新建的 KV 名称 */
      kvTitle?: string
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
    }): Promise<{
      /** 同上：Go 版异步执行时只返回 `started`，结果走 SSE 的 scan-result */
      ok?: boolean
      started?: boolean
      count?: number
      copyable?: string
      error?: string
    }>
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
    /** 从本地历史聚合质量报告，不触发额外检测。 */
    getIPQualityReport(params: { sessionId: string; ip: string; port: number }): Promise<{ ok: boolean; report?: IPQualityReport; error?: string }>
    /**
     * 实验性功能开关（默认全部关闭）。
     *
     * 这些能力会改变优选行为，必须由用户显式开启才生效。
     */
    getExperimental(): Promise<{
      ok: boolean
      experimental?: ExperimentalSettings
      /** 当前档案状态（样本量、是否够用、是否久未使用） */
      profile?: ExperimentalProfileStatus
      /** 全部档案（管理界面用） */
      profiles?: ExperimentalProfileStatus[]
      error?: string
    }>
    saveExperimental(params: ExperimentalSettings): Promise<{ ok: boolean; experimental?: ExperimentalSettings; error?: string }>
    /** 列出网络档案（含样本量与当前档案）。 */
    listExperimentalProfiles(): Promise<{ ok: boolean; profiles?: ExperimentalProfileStatus[]; error?: string }>
    /** 重命名网络档案（改维度 → 档案 ID 变化，观测一并迁移）。 */
    renameExperimentalProfile(params: {
      id: string
      isp: string
      region: string
      access: string
    }): Promise<{ ok: boolean; error?: string }>
    /** 删除网络档案及其观测。 */
    deleteExperimentalProfile(id: string): Promise<{ ok: boolean; error?: string }>
    /** 自适应效果 A/B 对照（同一档案、同一域名下的开/关对照）。 */
    getAdaptiveEffect(profileId?: string): Promise<{
      ok: boolean
      profileId?: string
      profile?: string
      enabled?: AdaptiveEffectSide
      disabled?: AdaptiveEffectSide
      notice?: string
      recent?: Array<{
        at: string
        adaptive: boolean
        tcpRate: number
        wsRate: number
        nodes: number
      }>
      error?: string
    }>
    /**
     * 账号用量与额度。
     *
     * 默认**只读缓存**（不发 Cloudflare 请求）；refresh=true 才真正重新采集一次。
     */
    getUsage(refresh?: boolean): Promise<{
      ok: boolean
      usage?: UsageSnapshot
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
      /** 本程序版本号（如 0.13.6），用于「运行状态」展示真实版本 */
      version?: string
    }>
    /**
     * 纯本地的部署信息（不联网、不用 Token）。
     *
     * 常态下「运行状态」卡片只读它：内置内核版本 + 最近一次部署的本地留档。
     */
    getLocalDeployInfo(): Promise<{
      ok: boolean
      snapshot?: {
        kvNamespaceId?: string
        kvTitle?: string
        controlProject?: string
        controlSubdomain?: string
        dataProject?: string
        dataSubdomain?: string
        kernelVersion?: string
        build?: string
        at?: string
        accountId?: string
        accountName?: string
        dataPlaneMode?: string
        /**
         * 数据面的**权威节点域名**（按当前账号在平台上的真实绑定解析）。
         *
         * 不用清单里记的值 —— 清单可能已被写脏（串号事故）。
         */
        nodeHost?: string
        /** nodeHost 的来源：Worker 自定义域名 / workers.dev 兜底 / Pages 自定义域名 … */
        nodeHostSource?: string
        /** 读不到节点域名时的提示 */
        nodeHostWarning?: string
        /** 清单里记的值与平台实际不一致（已按平台实际值为准） */
        nodeHostStale?: boolean
      }
      localKernelVersion?: string
      localBuild?: string
      accountId?: string
      accountName?: string
      /** 本机已知的实例索引（KV 命名空间 ID → 名称与项目名） */
      instances?: Record<string, {
        kvTitle?: string
        controlProject?: string
        dataProject?: string
        controlSubdomain?: string
        dataSubdomain?: string
        kernelVersion?: string
        build?: string
        at?: string
      }>
      error?: string
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
  entries: Array<{
    ip: string
    port: number
    colo: string
    /** 机房城市中文名（如「新加坡」） */
    city?: string
    latency: number
    tlsMs: number
    speed: number
  }>
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
  /** 机房城市中文名（如「新加坡」），用于展示与复制备注 */
  city?: string
  latency: number
  tlsMs: number
  speed: number
  /** TCP 建连耗时（ms）；旧历史没有该字段时为空 */
  tcpMs?: number
  /** 测速窗口峰值（MB/s）；旧历史没有该字段时为空 */
  peakSpeed?: number
  lastTest?: ScanHistoryLastTest
  tests?: ScanHistoryLastTest[]
  qualityReport?: IPQualityReport
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

type QualityFieldStatus = 'available' | 'not_run' | 'not_implemented' | 'failed' | 'stale'

/**
 * 实验性功能开关。
 *
 * 默认全部关闭；开启后优选会按本机网络档案的历史表现调整网段权重，
 * 并保留固定比例的探索预算。
 */
interface ExperimentalSettings {
  /** 自适应网段权重（按网络档案学习） */
  adaptiveSampling: boolean
  /** 探索预算比例（0~1）；利用 = 1 - 探索 */
  exploreRatio: number
  /** 运营商：ct 电信 / cu 联通 / cm 移动 / other */
  isp: string
  /** 地区（粗粒度，可留空） */
  region: string
  /** 接入类型：fixed 固网 / mobile 移动网络 */
  access: string
}

/**
 * 一个网络档案的状态。
 *
 * 档案 ID 由「运营商 + 地区 + 接入方式 + 地址族」哈希得到，
 * 不同档案的历史互不混用。
 */
interface ExperimentalProfileStatus {
  id: string
  /** 可读名称，如「中国电信 · 福建 · 固定宽带」 */
  label: string
  isp: string
  region: string
  access: string
  /** 是否是当前设置正在使用的档案 */
  current: boolean
  /** 各阶段（tcp / tls / ws）的累计样本 */
  stages: Record<string, { attempts: number; successes: number }>
  /** 有观测记录的前缀（/24）数量 */
  prefixCount: number
  lastUpdated?: string
  lastUsedAt?: string
  /** 样本是否足以影响权重 */
  enoughSamples: boolean
  /** 一句话说明（样本不足 / 久未使用 / 正常） */
  notice: string
  /** 距离上次使用过去的天数 */
  idleDays: number
}

/** A/B 对照的一侧（开启或关闭）。 */
interface AdaptiveEffectSide {
  /** 参与统计的轮数 */
  runs: number
  /** 平均候选数 */
  avgCandidates: number
  /** 阶段通过率（0~1） */
  tcpRate: number
  tlsRate: number
  wsRate: number
  /** 平均可用节点数 */
  avgNodes: number
  /** 平均耗时（毫秒） */
  avgElapsedMs: number
  lastAt?: string
}

/** 某一天的用量。 */
interface UsagePoint {
  workersRequests: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  workersErrors: number
  workersSubrequests: number
}

/** 账号用量与额度快照。 */
interface UsageSnapshot {
  ok: boolean
  error?: string
  accountId?: string
  /** 套餐：free / paid */
  plan?: string
  generatedAt?: string
  /** 数据已过期（被风控或缓存兜底） */
  stale: boolean
  /** 本地风控拦截了本次刷新 */
  throttled: boolean
  notice?: string
  /** 缓存时长（秒） */
  ttlSec: number
  nextRefreshAt?: string

  limits: {
    plan: string
    /** 官方套餐名（如 Cloudflare Free Plan） */
    planName?: string
    workersRequests: number
    kvReads: number
    kvWrites: number
    kvStorageBytes: number
    unlimitedWorkers: boolean
    unlimitedKvOps: boolean
    unlimitedKvStorage: boolean
  }
  ratelimit: {
    /** 官方响应头给出的剩余调用次数 */
    remoteRemaining: number
    remoteLimit: number
    remoteWindowSec: number
    /** 本地风控的剩余次数 */
    localRemaining: number
    localLimit: number
    localBlocked: boolean
    localWindowSec: number
  }

  /** 时间轴（UTC 日期） */
  days: string[]
  /** 与 days 对齐的每日用量 */
  series: UsagePoint[]

  today: UsagePoint
  yesterday: UsagePoint
  average: UsagePoint
  storage: { bytes: number; keyCount: number }
  /** 调用状态分布（success / exceededResources / loadShed …） */
  statusCounts: Record<string, number>
  /** 每个脚本 × 每种状态的次数（悬浮提示用） */
  statusByScript?: Record<string, Record<string, number>>
  /** 按脚本的消耗排行 */
  scripts: Array<{ name: string; requests: number; errors: number; cfpilot?: boolean }>
  /** 本地 KV 写配额日风控：今日已用与上限 */
  dailyWriteUsed?: number
  dailyWriteLimit?: number
  /** 账号里的部署实例（Pages / Worker），标出哪些是本工具的 */
  instances?: Array<{ name: string; kind: 'pages' | 'worker'; cfpilot: boolean }>
  /** 属于本工具 Worker 的请求数（Pages 形态则为 0） */
  cfpilotWorkerRequests?: number
  /** 这份统计的覆盖范围说明 */
  scopeNote?: string
}
interface IPQualityReport {
  version: number
  generatedAt: string
  ip: string
  port: number
  colo: string
  city: string
  source: string
  networkProfileId: string
  basic: { tcpMs: number | null; status: QualityFieldStatus }
  protocol: { tlsMs: number | null; wsOk: boolean | null; pongOk: boolean | null; realTunnelOk: boolean | null }
  performance: { speedMBps: number | null; peakMBps: number | null; stabilityP95: number | null; jitter: number | null }
  egress: { transport?: string; remoteIp?: string; observedAt?: string; ageMs?: number; egressKind?: string; colo?: string; status: 'observed' | 'not-run' | 'failed' | 'stale' }
  compatibility: { status: string; targets: Array<{ urlLabel: string; status: 'ok' | 'challenge' | 'forbidden' | 'rate_limited' | 'tls_error' | 'timeout' | 'not_run'; httpStatus?: number; challengeHeader?: string; ms?: number; expectedContentOk?: boolean; error?: string }> }
  history: { firstSeen: string; lastSeen: string; testCount: number; successRate: number; trend: Array<{ at: string; sessionId: string; kind: 'scan' | 'retest'; ok: boolean; latencyMs: number | null; tlsMs: number | null; speedMBps: number | null; tcpMs?: number | null }> }
  fields: Array<{ name: string; status: QualityFieldStatus; value?: unknown; reason?: string }>
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
