/**
 * CFPilot 边缘内核 —— 共享类型定义
 */

/** Worker 运行时环境变量 */
export interface Env {
  /** KV 命名空间绑定（未绑定时内核降级为内存存储，仅用于本地调试） */
  KV?: KVNamespace
  /** 面板初始密码（部署向导注入，首次启动后写入 KV 哈希） */
  PANEL_PASSWORD?: string
  /** 面板访问路径（不设则随机生成） */
  PANEL_PATH?: string
  /** 长期扫描回填令牌 */
  SCANNER_TOKEN?: string
  /**
   * 数据面域名（拆分部署时使用）。
   * 控制面生成订阅时用它作为节点地址；不设则回落到 subDomain 或请求域名。
   */
  DATA_HOST?: string
  /** VLESS UUID 覆盖值 */
  UUID?: string
  /** Trojan 密码（明文，仅用于生成订阅与数据面认证） */
  TROJAN_PASSWORD?: string
  /** WebSocket 路径（`WS_PATH` 优先，兼容 `PATH`） */
  WS_PATH?: string
  PATH?: string
  /** 是否启用 Trojan 入站（兼容旧名 `TROJAN`） */
  ENABLE_TROJAN?: string
  TROJAN?: string
  /** 是否启用 XHTTP 入站（兼容旧名 `XHTTP`） */
  ENABLE_XHTTP?: string
  XHTTP?: string
  /** 数据面实现（仅 `self`，纯自研） */
  DATAPLANE?: string
  /** 是否在订阅节点里启用 ECH（客户端侧能力） */
  ECH?: string
  /** ECH 查询用服务器名（留空用 cloudflare-ech.com） */
  ECH_HOST?: string
  /** 自定义 ECH DNS（DoH 地址，留空用客户端默认） */
  ECH_DNS?: string
  /** 出站代理 IP 池 */
  PROXYIP?: string
  /** SOCKS5 代理 host:port */
  SOCKS5?: string
  /** HTTP 代理 host:port */
  HTTP_PROXY?: string
  /** NAT64 前缀，例如 64:ff9b:: */
  NAT64?: string
  /** 手动优选池 */
  ADD?: string
  /** 远程 TXT 优选 API */
  ADDAPI?: string
  /** 远程 CSV 测速结果 */
  ADD_CSV?: string
  /** 最低下载速度阈值（MB/s） */
  DLS?: string
  /** 最高延迟阈值（ms） */
  MAX_LATENCY?: string
  /** 并发竞速拨号 */
  TCP_CONCURRENT_DIAL?: string
  /** 出站前是否自动 DoH 解析目标域名以获得优选 IP 候选 */
  RESOLVE_PREFERRED?: string
  /** 自定义反代入口池（每行一条） */
  RELAY_POOL?: string
  /** 是否启用内置反代入口表 */
  USE_BUILTIN_RELAY?: string
  [key: string]: unknown
}

/** 用户可配置项（KV CONFIG > 环境变量 > 内置默认值） */
export interface UserConfig {
  /** VLESS UUID */
  uuid: string
  /** Trojan 密码（明文，仅用于生成订阅） */
  trojanPassword: string
  /** VLESS WebSocket 路径 */
  wsPath: string
  /** Trojan WebSocket 路径 */
  trojanPath: string
  /** VLESS XHTTP 路径 */
  xhttpPath: string
  /** L2 手动优选池 */
  add: string
  /** L3 远程 TXT API 池（换行或逗号分隔） */
  addApi: string
  /** L4 远程 CSV 池 */
  addCsv: string
  /** 是否启用内置「官方优选 IP」来源 */
  poolOfficial: boolean
  /** 官方优选 IP 生成数量 */
  officialCount: number
  /** 是否启用内置「优选域名」来源 */
  poolDomain: boolean
  /** 优选域名取样数量 */
  domainCount: number
  /** 是否启用「手动优选 IP」（本地真连接池 + ADD 文本） */
  poolManual: boolean
  /**
   * 国家 / 地区筛选（逗号分隔的国家代码，如 `HK,JP,SG`；空 = 不限）。
   *
   * 只能作用于「已知机房」的条目：Cloudflare 的 anycast IP 本身没有国家归属，
   * 真正落地到哪个机房由就近路由决定。随机生成的官方 IP 机房未知，会被排除。
   */
  poolCountries: string
  /** CSV 最低下载速度阈值（MB/s），0 表示不限制 */
  dls: number
  /** CSV 最高延迟阈值（ms），0 表示不限制 */
  maxLatency: number
  /** 合并去重后保留的最大节点数 */
  maxNodes: number
  /** ProxyIP 池（出站落地代理） */
  proxyIp: string
  /** SOCKS5 代理 host:port */
  socks5: string
  /** HTTP 代理 host:port */
  httpProxy: string
  /** NAT64 前缀 */
  nat64: string
  /** 是否开启并发竞速拨号 */
  concurrentDial: boolean
  /**
   * 自定义反代入口池（每行一条，支持 `IP` / `IP:端口` / `域名`）。
   *
   * 反代入口是**第三方服务器**，收到 TLS ClientHello 后按 **SNI** 转发到目标。
   * 这是打通 **Cloudflare 网段目标**的唯一手段 ——
   * Worker 不能连回 Cloudflare 自家 Anycast 入口（`TCP Loop detected`），
   * 而大量目标站解析到的正是 Cloudflare 网段。
   *
   * 留空则只用内置表（见 `useBuiltinRelay`）。
   */
  relayPool: string
  /**
   * 是否启用**内置**反代入口表。
   *
   * 内置表与内置表一致（`proxyip.<地区>.cmliussss.net` 等 14 个域名），
   * 依赖社区第三方服务。关闭后只用用户在 `relayPool` 里自配的入口 ——
   * 自配入口不依赖任何第三方。
   *
   * 默认 true（开箱即用）。
   */
  useBuiltinRelay: boolean
  /**
   * 是否在出站前自动用 DoH 解析目标域名以获得优选 IP 候选。
   *
   * 机制与 DoH 逐级回退、「预加载竞速」一致：
   * TXT 记录里的社区优选 IP 库优先，回退 A / AAAA。
   *
   * 为什么需要：Worker **连不回 Cloudflare 自家的 Anycast 地址**
   * （`1.1.1.1` / `104.16.0.1` 一律被拒）。目标域名若解析到 CF 网段，
   * 直连必然失败；解析出的第三方 IP 才是可用候选。
   * Cloudflare 网段的解析结果会被自动降权（见 `outbound/route.ts`）。
   *
   * 关闭则只用手工配置的优选 IP，不产生额外 DoH 请求。
   */
  resolvePreferred: boolean
  /** 是否启用 Trojan 入站 */
  enableTrojan: boolean
  /** 是否启用 XHTTP 入站 */
  enableXhttp: boolean
  /** 订阅使用的域名覆盖（留空则使用请求来源域名） */
  subDomain: string
  /** 订阅协议 */
  subProtocol: 'vless' | 'trojan' | 'both'
  /** 订阅传输方式 */
  subTransport: 'ws' | 'xhttp' | 'both'
  /**
   * 订阅下发的**节点形态组合**（多选，逗号分隔）。
   *
   * 可选值：
   *   - `vless-ws`     VLESS over WebSocket
   *   - `vless-xhttp`  VLESS over XHTTP
   *   - `trojan`       Trojan over WebSocket
   *
   * ## 为什么需要它
   *
   * 原来的 `subProtocol`（vless/trojan/both）× `subTransport`（ws/xhttp/both）
   * 是**两个独立开关**，组合起来会生成
   * `vless+ws` / `vless+xhttp` / `trojan+ws` 三种形态 —— 节点数被**乘三**。
   * 用户只想用 vless+ws 时也会收到另外两种，于是：
   *   - 客户端里出现大量用不了的节点（XHTTP 需要 Xray 内核，Trojan 需另行配置）；
   *   - 延迟测试里一堆 `-1`，看起来像「节点坏了」。
   *
   * 改成**显式勾选**后，订阅只包含用户真正要的形态。
   *
   * 默认只勾 `vless-ws`（兼容性最好，Clash Verge / mihomo / v2rayN 都支持）。
   */
  subVariants: string
  /**
   * 订阅名称：客户端导入订阅后自动填入的名字（如 Clash Verge 的配置名）。
   *
   * 历史上文件名写死 `CFPilot.yaml`，部分客户端会把**扩展名也带进名称**
   * （导入后显示"CFPilot.yaml"）。这里允许自定义，且渲染时不再附加扩展名。
   * 仅影响展示名，不影响协议内容。
   */
  subName: string
  /**
   * 订阅节点下发的端口（多选，逗号分隔）。
   *
   * Cloudflare 的 TLS 端口除 443 外还有 2053/2083/2087/2096/8443，
   * 部分网络环境 443 被针对性干扰时换端口即可恢复。
   *
   * 语义：
   *   - 每个「自动池」条目（官方 IP / 优选域名 / 远程池）按勾选的端口各生成一份；
   *   - 「手动池」里显式写了 `IP:端口` 的条目保持原端口，不参与乘法
   *     （用户手动指定即意图，避免被乘成 N 份）。
   *
   * 留空或解析失败 = 只用 443。
   */
  subPorts: string
  /** 客户端指纹 */
  clientFingerprint: string
  /**
   * 是否在订阅节点里启用 ECH（Encrypted Client Hello）。
   *
   * ECH 让客户端把 TLS ClientHello 里的 SNI 加密，隐藏真实访问的域名。
   * 这是**客户端侧**的能力：内核只负责把 ECH 参数写进订阅，
   * 由支持 ECH 的客户端（mihomo / sing-box / v2rayN 等）实际执行。
   *
   * 默认关闭。
   */
  ech: boolean
  /** ECH 查询用的服务器名（对外隐藏的 SNI），留空用 cloudflare-ech.com */
  echHost: string
  /** 自定义 ECH DNS（DoH 地址），留空用客户端默认 */
  echDns: string
  /** 是否下发 TLS Fragment 参数（部分内核支持该扩展） */
  tlsFragment: boolean
  /** TLS Fragment 长度范围 */
  tlsFragmentSize: string
  /** TLS Fragment 延迟范围 */
  tlsFragmentDelay: string
}

/** 优选节点条目 */
export interface NodeEntry {
  /** IP 或优选域名 */
  ip: string
  /** 端口 */
  port: number
  /** 备注 / 机房三字码 */
  remark: string
  /** 机房代码 */
  colo: string
  /** 延迟（ms） */
  latency: number
  /** 下载速度（MB/s） */
  speed: number
  /**
   * 来源：manual 侧（local / add）、official（内置随机）、domain（内置域名库）、远程（addapi / addcsv）
   */
  source: NodeSource
  /** 所属国家代码（由 colo 反推；未知为空串） */
  country?: string
}

/** 节点来源标识 */
export type NodeSource = 'local' | 'add' | 'official' | 'domain' | 'addapi' | 'addcsv'

/** 订阅输出格式 */
export type SubFormat = 'base64' | 'clash' | 'singbox' | 'v2ray'
