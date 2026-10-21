/**
 * 控制面 / 数据面共用的配置与鉴权读取。
 *
 * 铁律：模块级缓存只允许存**纯数据**（配置对象、鉴权上下文），
 * 绝不能缓存 Store 或 env 上的绑定（跨请求会抛
 * "Cannot perform I/O on behalf of a different request"）。
 */
import type { Env, UserConfig } from '../types'
import { createStore, type Store, } from '../store'
import { loadConfig } from '../config'
import { ensureBootstrap, type AuthContext } from '../auth'
import type { SubFormat } from '../sub-engine'

const CONFIG_TTL_MS = 15_000
const AUTH_TTL_MS = 60_000

interface Caches {
  config: UserConfig | null
  configAt: number
  auth: AuthContext | null
  authAt: number
}

const caches: Caches = { config: null, configAt: 0, auth: null, authAt: 0 }

/** 每次请求都用当次请求的 env 新建 Store，禁止跨请求复用 */
export function getStore(env: Env): Store {
  return createStore(env)
}

export async function getConfig(store: Store, env: Env): Promise<UserConfig> {
  if (caches.config && Date.now() - caches.configAt < CONFIG_TTL_MS) return caches.config
  const config = await loadConfig(store, env)
  caches.config = config
  caches.configAt = Date.now()
  return config
}

export function invalidateConfig(): void {
  caches.config = null
  caches.configAt = 0
}

export async function getAuth(store: Store, env: Env): Promise<AuthContext> {
  if (caches.auth && Date.now() - caches.authAt < AUTH_TTL_MS) return caches.auth
  const auth = await ensureBootstrap(store, env.PANEL_PASSWORD, env.PANEL_PATH)
  caches.auth = auth
  caches.authAt = Date.now()
  return auth
}

/** 解析订阅格式参数 */
export function resolveFormat(value: string | null): SubFormat {
  switch ((value ?? '').toLowerCase()) {
    case 'clash':
    case 'mihomo':
    case 'yaml':
      return 'clash'
    case 'singbox':
    case 'sing-box':
    case 'json':
      return 'singbox'
    case 'v2ray':
      return 'v2ray'
    case 'base64':
    default:
      return 'base64'
  }
}
