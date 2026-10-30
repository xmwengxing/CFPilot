/**
 * 配置加载：KV CONFIG > 环境变量 > 内置默认值
 */
import type { Env, UserConfig, ProxyMode
} from './types'
import { randomUuid } from './util'
import type { Store } from './store'
import { KvStore } from './store'

export const CONFIG_KEY = 'CONFIG'
export const LOCAL_IPS_KEY = 'LOCAL_PREFERRED_IPS'
export const SCANNER_TOKEN_KEY = 'SCANNER_TOKEN'
/** KV 中热更新的优选域名库（每行一个域名；为空则用内置库） */
export const POOL_DOMAIN_KEY = 'POOL_DOMAIN_LIBRARY'
/**
 * KV 中的分流规则配置（route-profile ini 原文）。
 *
 * 为空时用内置配置（构建期内联的 assets/route-profiles.ini）。
 * 用户想换一套分组时，在面板「订阅」页或直接写 KV 覆盖。
 */
export const ROUTE_PROFILE_KEY = 'ROUTE_PROFILE'
export const ONE_TIME_TOKEN_PREFIX = 'ONETIME:'
export const SESSION_PREFIX = 'SESSION:'
export const PANEL_PATH_KEY = 'PANEL_PATH'
export const ADMIN_PW_HASH_KEY = 'ADMIN_PW_HASH'
export const ADMIN_PW_PLAIN_KEY = 'ADMIN_PW_PLAIN'
export const PANEL_PATH_DEFAULT = '/cfpilot'

export const DEFAULT_CONFIG: UserConfig = {
  uuid: '',
  trojanPassword: '',
  wsPath: '/vless',
  trojanPath: '/trojan',
  xhttpPath: '/xhttp',
  add: '',
  addApi: '',
  addCsv: '',
  poolOfficial: true,
  officialCount: 20,
  poolDomain: true,
  domainCount: 10,
  poolManual: false,
  poolCountries: '',
  dls: 0,
  maxLatency: 0,
  maxNodes: 0,
  proxyIp: '',
  socks5: '',
  httpProxy: '',
  proxyMode: 'only' as ProxyMode,
  nat64: '',
  concurrentDial: true,
  dataBudgetMB: 0,
  resolvePreferred: true,
  relayPool: '',
  useBuiltinRelay: true,
  enableTrojan: true,
  enableXhttp: true,
  subDomain: '',
  subProtocol: 'vless',
  subTransport: 'ws',
  subVariants: 'vless-ws',
  subName: 'CFPilot',
  subPorts: '443',
  clientFingerprint: 'chrome',
  ech: false,
  echHost: 'cloudflare-ech.com',
  echDns: '',
  tlsFragment: false,
  tlsFragmentSize: '10-20',
  tlsFragmentDelay: '10-20',
  subToken: 'legacy',
  subTokenTtlDays: 0,
  unlockProbe: false,
  udpDns: 'off',
  // ⚠️ 必须是**非 Cloudflare** 的 DoH 端点：Worker 连回 CF 自家网段会被拒
  // （TCP Loop detected，见 AGENTS 铁律 9）。
  udpDnsEndpoint: 'https://dns.google/dns-query',
}

function num(value: unknown, fallback: number): number {
  // 注意：不能直接用 Number('')，它等于 0，会把「未配置」错误地变成 0。
  // 历史上这里导致 officialCount/domainCount 在没设环境变量时变成 0，订阅直接为空。
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  if (text === '') return fallback
  const n = Number(text)
  return Number.isFinite(n) ? n : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

/** 合法的代理调度模式 */
export const PROXY_MODES: ProxyMode[] = ['only', 'global', 'fallback', 'smart']

/**
 * 归一化代理调度模式。
 *
 * 读不懂的值一律回落 `only` —— 那是**最保守**的语义
 * （有代理只走代理，绝不静默改走直连）。
 */
export function normalizeProxyMode(value: string): ProxyMode {
  const text = value.trim().toLowerCase()
  if (text === 'global' || text === 'fallback' || text === 'smart') return text
  return 'only'
}

/** 归一化订阅令牌模式；读不懂一律回落 `legacy`（最保守：不改变既有行为） */
export function normalizeSubTokenMode(value: string): 'legacy' | 'signed' {
  return value.trim().toLowerCase() === 'signed' ? 'signed' : 'legacy'
}

/** 归一化 UDP 处理模式；读不懂一律 `off`（保持历史行为：明确拒绝） */
export function normalizeUdpDns(value: string): 'off' | 'doh' {
  return value.trim().toLowerCase() === 'doh' ? 'doh' : 'off'
}

function text(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback
  return String(value)
}

/** 从环境变量构造默认配置 */
export function configFromEnv(env: Env): UserConfig {
  return {
    uuid: text(env.UUID, ''),
    trojanPassword: text(env.TROJAN_PASSWORD, ''),
    // WS 路径：PATH 是 旧版的历史命名，WS_PATH 是本项目的命名。
    // 两者都读，避免部署向导注入的 PATH 被静默忽略。
    wsPath: text(env.WS_PATH || env.PATH, DEFAULT_CONFIG.wsPath),
    trojanPath: DEFAULT_CONFIG.trojanPath,
    xhttpPath: DEFAULT_CONFIG.xhttpPath,
    add: text(env.ADD, ''),
    addApi: text(env.ADDAPI, ''),
    addCsv: text(env.ADD_CSV, ''),
    poolOfficial: bool(env.OFFICIAL_IP, DEFAULT_CONFIG.poolOfficial),
    officialCount: num(env.OFFICIAL_IP_COUNT, DEFAULT_CONFIG.officialCount),
    poolDomain: bool(env.PREFERRED_DOMAIN, DEFAULT_CONFIG.poolDomain),
    domainCount: num(env.PREFERRED_DOMAIN_COUNT, DEFAULT_CONFIG.domainCount),
    poolManual: bool(env.MANUAL_IP, DEFAULT_CONFIG.poolManual),
    poolCountries: text(env.POOL_COUNTRIES, DEFAULT_CONFIG.poolCountries),
    dls: num(env.DLS, 0),
    maxLatency: num(env.MAX_LATENCY, 0),
    maxNodes: 0,
    proxyIp: text(env.PROXYIP, ''),
    socks5: text(env.SOCKS5, ''),
    httpProxy: text(env.HTTP_PROXY, ''),
    proxyMode: normalizeProxyMode(text(env.PROXY_MODE, '')),
    nat64: text(env.NAT64, ''),
    concurrentDial: bool(env.TCP_CONCURRENT_DIAL, true),
    dataBudgetMB: num(env.DATA_BUDGET_MB, DEFAULT_CONFIG.dataBudgetMB),
    resolvePreferred: bool(env.RESOLVE_PREFERRED, DEFAULT_CONFIG.resolvePreferred),
    relayPool: text(env.RELAY_POOL, ''),
    useBuiltinRelay: bool(env.USE_BUILTIN_RELAY, DEFAULT_CONFIG.useBuiltinRelay),
    enableTrojan: bool(env.ENABLE_TROJAN ?? env.TROJAN, DEFAULT_CONFIG.enableTrojan),
    enableXhttp: bool(env.ENABLE_XHTTP ?? env.XHTTP, DEFAULT_CONFIG.enableXhttp),
    subDomain: '',
    subProtocol: 'both',
    subTransport: 'both',
    subVariants: text(env.SUB_VARIANTS, DEFAULT_CONFIG.subVariants),
    subName: text(env.SUB_NAME, DEFAULT_CONFIG.subName).trim() || DEFAULT_CONFIG.subName,
    subPorts: text(env.SUB_PORTS, DEFAULT_CONFIG.subPorts),
    clientFingerprint: DEFAULT_CONFIG.clientFingerprint,
    ech: bool(env.ECH, DEFAULT_CONFIG.ech),
    echHost: text(env.ECH_HOST, DEFAULT_CONFIG.echHost),
    echDns: text(env.ECH_DNS, DEFAULT_CONFIG.echDns),
    tlsFragment: false,
    tlsFragmentSize: DEFAULT_CONFIG.tlsFragmentSize,
    tlsFragmentDelay: DEFAULT_CONFIG.tlsFragmentDelay,
    subToken: normalizeSubTokenMode(text(env.SUB_TOKEN_MODE, '')),
    subTokenTtlDays: num(env.SUB_TOKEN_TTL_DAYS, DEFAULT_CONFIG.subTokenTtlDays),
    unlockProbe: bool(env.UNLOCK_PROBE, DEFAULT_CONFIG.unlockProbe),
    udpDns: normalizeUdpDns(text(env.UDP_DNS, '')),
    udpDnsEndpoint: text(env.UDP_DNS_ENDPOINT, DEFAULT_CONFIG.udpDnsEndpoint),
  }
}

/** 合并配置：KV 覆盖环境变量覆盖默认值 */
export function mergeConfig(base: UserConfig, override: Partial<UserConfig>): UserConfig {
  const merged: UserConfig = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue
    if (
      key === 'dls' ||
      key === 'maxLatency' ||
      key === 'maxNodes' ||
      key === 'officialCount' ||
      key === 'domainCount' ||
      key === 'dataBudgetMB' ||
      key === 'subTokenTtlDays'
    ) {
      ;(merged as unknown as Record<string, number>)[key] = num(value, 0)
    } else if (
      key === 'concurrentDial' ||
      key === 'resolvePreferred' ||
      key === 'useBuiltinRelay' ||
      key === 'enableTrojan' ||
      key === 'enableXhttp' ||
      key === 'tlsFragment' ||
      key === 'ech' ||
      key === 'poolOfficial' ||
      key === 'poolDomain' ||
      key === 'poolManual' ||
      key === 'unlockProbe'
    ) {
      ;(merged as unknown as Record<string, boolean>)[key] = bool(value, false)
    } else if (key === 'subProtocol') {
      const v = String(value)
      ;(merged as unknown as Record<string, string>)[key] = v === 'vless' || v === 'trojan' || v === 'both' ? v : 'both'
    } else if (key === 'subTransport') {
      const v = String(value)
      ;(merged as unknown as Record<string, string>)[key] = v === 'ws' || v === 'xhttp' || v === 'both' ? v : 'both'
    } else if (key === 'subToken') {
      ;(merged as unknown as Record<string, string>)[key] = normalizeSubTokenMode(String(value))
    } else if (key === 'udpDns') {
      ;(merged as unknown as Record<string, string>)[key] = normalizeUdpDns(String(value))
    } else {
      ;(merged as unknown as Record<string, string>)[key] = String(value)
    }
  }
  return merged
}

/**
 * 加载完整配置。
 * 若尚无 UUID / Trojan 密码，则生成随机值并写回 KV，保证开箱即用。
 */
export async function loadConfig(store: Store, env: Env): Promise<UserConfig> {
  const fromEnv = configFromEnv(env)
  const raw = await store.get(CONFIG_KEY)
  let stored: Partial<UserConfig> = {}
  if (raw) {
    try {
      stored = JSON.parse(raw) as Partial<UserConfig>
    } catch {
      stored = {}
    }
  }
  const config = mergeConfig(fromEnv, stored)

  let dirty = false
  // ⚠️ 只有**持久化存储（KV）**才允许自动生成凭据并写回：
  // 生产上未绑定 KV 时 `createStore` 每个请求都 `new MemoryStore()`，
  // 「生成并写回」等于每个请求/每个隔离体都得到不同的随机 UUID ——
  // 客户端按面板显示的 UUID 连接会随机失败，且完全无从排查
  // （2026-10-27 实测核实）。
  // 未配置时保持空值 fail-closed：所有实例行为一致（一律拒绝认证，
  // 含 Trojan 空口令防护），面板显示空 UUID 提示用户补配置。
  const canPersist = store instanceof KvStore
  if (!config.uuid && canPersist) {
    config.uuid = randomUuid()
    dirty = true
  }
  if (!config.trojanPassword && canPersist) {
    config.trojanPassword = randomUuid().replace(/-/g, '').slice(0, 16)
    dirty = true
  }
  // 自愈：历史上 num() 的 bug 把未配置的官方 IP / 域名数量写成了 0，
  // 导致订阅为空。这里把「小于 1」视为未配置并回落到默认值。
  if (config.officialCount < 1) {
    config.officialCount = DEFAULT_CONFIG.officialCount
    dirty = true
  }
  if (config.domainCount < 1) {
    config.domainCount = DEFAULT_CONFIG.domainCount
    dirty = true
  }
  if (dirty) await saveConfig(store, config)
  return config
}

/** 持久化配置到 KV */
export async function saveConfig(store: Store, config: UserConfig): Promise<void> {
  await store.put(CONFIG_KEY, JSON.stringify(config))
}

/** 读取本地真连接优选池原始文本 */
export async function loadLocalIps(store: Store): Promise<string> {
  return (await store.get(LOCAL_IPS_KEY)) ?? ''
}

/**
 * 读取 KV 中热更新的优选域名库。
 * 返回空数组表示「没有自定义库」，调用方应回落到内置域名库。
 */
export async function loadDomainLibrary(store: Store): Promise<string[]> {
  const raw = await store.get(POOL_DOMAIN_KEY)
  if (!raw) return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 保存优选域名库（空数组表示清空自定义库、回落到内置库） */
export async function saveDomainLibrary(store: Store, domains: string[]): Promise<void> {
  const cleaned = domains
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
  if (cleaned.length === 0) {
    await store.delete(POOL_DOMAIN_KEY)
    return
  }
  await store.put(POOL_DOMAIN_KEY, cleaned.join('\n'))
}
