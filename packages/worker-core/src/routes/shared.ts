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

/**
 * 解析订阅格式参数（URL 显式指定，优先级最高）。
 *
 * 显式参数 > User-Agent 推断 > 默认 base64。
 */
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
      return 'base64'
    default:
      return 'base64'
  }
}

/**
 * 把「节点域名」配置规范化成裸域名。
 *
 * ## 为什么需要（2026-10-23 真机踩坑）
 *
 * `DATA_HOST` / `subDomain` 的值会被**原样**用作订阅节点里的
 * `sni` / `host` / `servername` / Clash `Host` 头。
 * 用户在面板里很容易顺手填成完整 URL（`https://xxx.pages.dev/`），
 * 于是 SNI 变成 `https://xxx.pages.dev/` —— TLS 握手必败，
 * 且**没有任何报错**（客户端只表现为「全部节点连不上」）。
 *
 * 部署向导写的一直是裸域名（`result.data.subdomain`），
 * 所以这个坑只在**用户手改**时出现；这里兜底，防再犯。
 */
export function normalizeNodeDomain(value: string): string {
  let text = String(value ?? '').trim()
  if (!text) return text
  // 去掉 scheme（http:// / https://，大小写不敏感）
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  // 去掉路径 / query / hash（第一个 / ? # 起都不要）
  text = text.replace(/[/?#].*$/, '')
  // 去掉用户信息（user@host 形式不会出现，防御而已）
  const at = text.lastIndexOf('@')
  if (at >= 0) text = text.slice(at + 1)
  // 去掉端口（host:port → host；IPv6 [addr]:port → addr）
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end > 0) text = text.slice(1, end)
  } else {
    const first = text.indexOf(':')
    if (first >= 0 && text.indexOf(':', first + 1) < 0) text = text.slice(0, first)
  }
  return text.trim()
}

/**
 * 按 User-Agent 推断订阅格式。
 *
 * ## 为什么必须有这一步
 *
 * 客户端导入订阅时**只给订阅 URL，不会加 `?target=clash`**，
 * 而是靠自己的 User-Agent 表明身份：
 *   - Clash Verge / Clash / mihomo → `clash-verge/…`、`ClashforWindows/…`、`mihomo/…`
 *   - sing-box → `sing-box/…`
 *   - V2Ray / v2rayN / Shadowrocket → `v2rayNG/…` 等
 *
 * 只认 URL 参数的话，Clash Verge 导入拿到的是 **base64 分享链接集合**，
 * 它按 YAML 解析必然失败——表现为「浏览器里能看到 YAML 文本，
 * 但 Clash Verge 导入报错」。这是用户实际遇到的症状。
 *
 * 识别不出来时返回 null，由调用方回落到默认格式（不猜）。
 */
export function resolveFormatByUserAgent(userAgent: string | null): SubFormat | null {
  const ua = (userAgent ?? '').toLowerCase()
  if (!ua) return null
  // Clash 系：Verge / Clash for Windows / ClashX / mihomo / FlClash
  if (
    ua.includes('clash') ||
    ua.includes('mihomo') ||
    ua.includes('flclash') ||
    ua.includes('clashx') ||
    ua.includes('stash')
  ) {
    return 'clash'
  }
  // sing-box / v2rayN 的 sing-box 模式
  if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox'
  // 传统分享链接订阅
  if (
    ua.includes('v2ray') ||
    ua.includes('v2rayng') ||
    ua.includes('shadowrocket') ||
    ua.includes('nekobox') ||
    ua.includes('surge') ||
    ua.includes('loon') ||
    ua.includes('quantumult')
  ) {
    return 'base64'
  }
  return null
}
