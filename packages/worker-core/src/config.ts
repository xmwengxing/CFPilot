/**
 * 配置加载：KV CONFIG > 环境变量 > 内置默认值
 */
import type { Env, UserConfig } from './types'
import { randomUuid } from './util'
import type { Store } from './store'

export const CONFIG_KEY = 'CONFIG'
export const LOCAL_IPS_KEY = 'LOCAL_PREFERRED_IPS'
export const SCANNER_TOKEN_KEY = 'SCANNER_TOKEN'
/** KV 中热更新的优选域名库（每行一个域名；为空则用内置库） */
export const POOL_DOMAIN_KEY = 'POOL_DOMAIN_LIBRARY'
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
  nat64: '',
  concurrentDial: true,
  resolvePreferred: true,
  relayPool: '',
  useBuiltinRelay: true,
  enableTrojan: true,
  enableXhttp: true,
  subDomain: '',
  subProtocol: 'vless',
  subTransport: 'ws',
  subVariants: 'vless-ws',
  clientFingerprint: 'chrome',
  ech: false,
  echHost: 'cloudflare-ech.com',
  echDns: '',
  tlsFragment: false,
  tlsFragmentSize: '10-20',
  tlsFragmentDelay: '10-20',
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

function text(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback
  return String(value)
}

/** 从环境变量构造默认配置 */
export function configFromEnv(env: Env): UserConfig {
  return {
    uuid: text(env.UUID, ''),
    trojanPassword: text(env.TROJAN_PASSWORD, ''),
    // WS 路径：PATH 是 CFNext 的历史命名，WS_PATH 是本项目的命名。
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
    nat64: text(env.NAT64, ''),
    concurrentDial: bool(env.TCP_CONCURRENT_DIAL, true),
    resolvePreferred: bool(env.RESOLVE_PREFERRED, DEFAULT_CONFIG.resolvePreferred),
    relayPool: text(env.RELAY_POOL, ''),
    useBuiltinRelay: bool(env.USE_BUILTIN_RELAY, DEFAULT_CONFIG.useBuiltinRelay),
    enableTrojan: bool(env.ENABLE_TROJAN ?? env.TROJAN, DEFAULT_CONFIG.enableTrojan),
    enableXhttp: bool(env.ENABLE_XHTTP ?? env.XHTTP, DEFAULT_CONFIG.enableXhttp),
    subDomain: '',
    subProtocol: 'both',
    subTransport: 'both',
    subVariants: text(env.SUB_VARIANTS, DEFAULT_CONFIG.subVariants),
    clientFingerprint: DEFAULT_CONFIG.clientFingerprint,
    ech: bool(env.ECH, DEFAULT_CONFIG.ech),
    echHost: text(env.ECH_HOST, DEFAULT_CONFIG.echHost),
    echDns: text(env.ECH_DNS, DEFAULT_CONFIG.echDns),
    tlsFragment: false,
    tlsFragmentSize: DEFAULT_CONFIG.tlsFragmentSize,
    tlsFragmentDelay: DEFAULT_CONFIG.tlsFragmentDelay,
  }
}

/** 合并配置：KV 覆盖环境变量覆盖默认值 */
export function mergeConfig(base: UserConfig, override: Partial<UserConfig>): UserConfig {
  const merged: UserConfig = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue
    if (key === 'dls' || key === 'maxLatency' || key === 'maxNodes' || key === 'officialCount' || key === 'domainCount') {
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
      key === 'poolManual'
    ) {
      ;(merged as unknown as Record<string, boolean>)[key] = bool(value, false)
    } else if (key === 'subProtocol') {
      const v = String(value)
      ;(merged as unknown as Record<string, string>)[key] = v === 'vless' || v === 'trojan' || v === 'both' ? v : 'both'
    } else if (key === 'subTransport') {
      const v = String(value)
      ;(merged as unknown as Record<string, string>)[key] = v === 'ws' || v === 'xhttp' || v === 'both' ? v : 'both'
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
  if (!config.uuid) {
    config.uuid = randomUuid()
    dirty = true
  }
  if (!config.trojanPassword) {
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
