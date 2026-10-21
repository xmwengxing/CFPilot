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
  /** 客户端指纹 */
  clientFingerprint: string
  /** 是否下发 TLS Fragment 参数（BPB 风格，部分内核支持） */
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
