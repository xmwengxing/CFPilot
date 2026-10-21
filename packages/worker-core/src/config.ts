/**
 * 配置加载：KV CONFIG > 环境变量 > 内置默认值
 */
import type { Env, UserConfig } from './types'
import { randomUuid } from './util'
import type { Store } from './store'

export const CONFIG_KEY = 'CONFIG'
export const LOCAL_IPS_KEY = 'LOCAL_PREFERRED_IPS'
export const SCANNER_TOKEN_KEY = 'SCANNER_TOKEN'
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
  dls: 0,
  maxLatency: 0,
  maxNodes: 0,
  proxyIp: '',
  socks5: '',
  httpProxy: '',
  nat64: '',
  concurrentDial: true,
  enableTrojan: true,
  enableXhttp: true,
  subDomain: '',
  subProtocol: 'both',
  subTransport: 'both',
  clientFingerprint: 'chrome',
  tlsFragment: false,
  tlsFragmentSize: '10-20',
  tlsFragmentDelay: '10-20',
}

function num(value: unknown, fallback: number): number {
  const n = Number(String(value ?? '').trim())
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
    trojanPassword: '',
    wsPath: DEFAULT_CONFIG.wsPath,
    trojanPath: DEFAULT_CONFIG.trojanPath,
    xhttpPath: DEFAULT_CONFIG.xhttpPath,
    add: text(env.ADD, ''),
    addApi: text(env.ADDAPI, ''),
    addCsv: text(env.ADD_CSV, ''),
    dls: num(env.DLS, 0),
    maxLatency: num(env.MAX_LATENCY, 0),
    maxNodes: 0,
    proxyIp: text(env.PROXYIP, ''),
    socks5: text(env.SOCKS5, ''),
    httpProxy: text(env.HTTP_PROXY, ''),
    nat64: text(env.NAT64, ''),
    concurrentDial: bool(env.TCP_CONCURRENT_DIAL, true),
    enableTrojan: true,
    enableXhttp: true,
    subDomain: '',
    subProtocol: 'both',
    subTransport: 'both',
    clientFingerprint: DEFAULT_CONFIG.clientFingerprint,
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
    if (key === 'dls' || key === 'maxLatency' || key === 'maxNodes') {
      ;(merged as unknown as Record<string, number>)[key] = num(value, 0)
    } else if (key === 'concurrentDial' || key === 'enableTrojan' || key === 'enableXhttp' || key === 'tlsFragment') {
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
