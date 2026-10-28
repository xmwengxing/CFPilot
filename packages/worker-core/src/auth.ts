/**
 * 面板鉴权：密码登录 + KV 会话 + 一次性扫描令牌
 *
 * ## 凭据的优先级与存储
 *
 * 历史实现是「KV 优先，环境变量只在 KV 为空时生效」，这导致复用 KV 重新部署时，
 * 新注入的 `PANEL_PASSWORD` / `PANEL_PATH` 被静默忽略，用户拿着新密码登不进去。
 *
 * 现在的规则：
 *   - **环境变量优先**：部署时显式注入的凭据应当生效，否则部署向导失去意义。
 *   - KV 只存**派生值**（salt:hash），绝不存明文密码。
 *   - 环境变量未提供时才随机生成，并把明文写进 KV 的 `ADMIN_PW_PLAIN`
 *     （这是用户唯一的取回途径，因为 Worker 无状态）。
 *
 * 需要「改回 KV 里的旧密码」时，删掉环境变量即可；需要重置则删 KV 的两个键。
 */
import type { Store } from './store'
import {
  ADMIN_PW_HASH_KEY,
  ADMIN_PW_PLAIN_KEY,
  ONE_TIME_TOKEN_PREFIX,
  PANEL_PATH_KEY,
  PANEL_PATH_DEFAULT,
  SESSION_PREFIX,
} from './config'
import { randomHex, randomAlnum, sha256Hex, timingSafeEqual } from './util'

export const SESSION_COOKIE = 'cfpilot_sess'
const SESSION_TTL = 60 * 60 * 24 // 24 小时
const ONE_TIME_TTL = 60 * 10 // 10 分钟

export interface AuthContext {
  /** 面板访问路径（含前导斜杠） */
  panelPath: string
  /** 面板密码哈希（salt:hash） */
  passwordHash: string
  /** 自动生成的明文密码（仅在未注入 PANEL_PASSWORD 时存在） */
  generatedPassword: string | null
}

async function hashPassword(password: string, salt: string): Promise<string> {
  return await sha256Hex(`${salt}:${password}`)
}

/**
 * 判断 KV 里存着的 `salt:hash` 是否就是给定密码的派生值。
 *
 * 空值、不含分隔符、缺 salt/缺 hash 的脏数据一律返回 false（视为需要重新写）。
 * 用 `timingSafeEqual` 比较，避免逐字符比较泄露哈希前缀。
 */
async function hashMatches(passwordHash: string, password: string): Promise<boolean> {
  const [salt, expected] = passwordHash.split(':')
  if (!salt || !expected) return false
  const actual = await hashPassword(password, salt)
  return timingSafeEqual(actual, expected)
}

/** 规范化路径：确保有且仅有一个前导斜杠 */
function normalizePath(path: string): string {
  return `/${path.trim().replace(/^\/+/, '')}`
}

/**
 * 首次启动引导：确定面板路径与密码哈希。
 *
 * 优先级：**环境变量 > KV**。环境变量变化时会同步刷新 KV，
 * 这样「重新部署并注入新密码」能立即生效，不会被旧值挡住。
 */
export async function ensureBootstrap(
  store: Store,
  envPassword?: string,
  envPath?: string
): Promise<AuthContext> {
  /* ---- 面板路径 ---- */
  let panelPath = (await store.get(PANEL_PATH_KEY)) ?? ''
  const envPathNorm = envPath && envPath.trim() ? normalizePath(envPath) : ''
  if (envPathNorm) {
    // 环境变量优先：与 KV 不一致时以环境变量为准并回写
    if (panelPath !== envPathNorm) {
      panelPath = envPathNorm
      await store.put(PANEL_PATH_KEY, panelPath)
    }
  } else if (!panelPath) {
    panelPath = normalizePath(`${PANEL_PATH_DEFAULT}-${randomAlnum(6)}`)
    await store.put(PANEL_PATH_KEY, panelPath)
  }

  /* ---- 密码 ---- */
  // ⚠️ 这一段绝不能无条件写 KV —— 写入放大是三个因素叠加出来的：
  //   1. Cloudflare KV 免费版每天只有 1000 次写/删除，配额写光后面板保存配置、
  //      回填优选 IP 等需要写 KV 的接口会全部 500；
  //   2. routes/shared.ts 的 getAuth() 模块级缓存只有 60 秒，过期后每次请求
  //      都会重新调 ensureBootstrap()；
  //   3. 模块级缓存是「每个边缘 isolate 一份」的，全球几十个 isolate 各自冷启动，
  //      每个都要独立引导一次。
  // 所以「环境变量已注入」不等于「必须重新派生并落盘」：只有密码真的变了
  // （或 KV 里还没有哈希）才写一次；密码没变读取即可，一次 KV 写都不做
  // （get 不计入写配额）。两个 isolate 同时冷启动各写一次是可接受的下界，
  // 不要为此引入跨请求锁或模块级可变状态。
  let passwordHash = (await store.get(ADMIN_PW_HASH_KEY)) ?? ''
  let generatedPassword: string | null = null
  const envPw = envPassword && envPassword.trim() ? envPassword.trim() : ''

  if (envPw) {
    // 环境变量优先：密码变化时必须按新环境变量重新派生（重新部署即可改密码，
    // 不需要手动清 KV）；但密码未变时复用 KV 里那份哈希，避免每次引导都重写。
    if (!passwordHash || !(await hashMatches(passwordHash, envPw))) {
      const salt = randomHex(8)
      passwordHash = `${salt}:${await hashPassword(envPw, salt)}`
      await store.put(ADMIN_PW_HASH_KEY, passwordHash)
    }
    // 环境变量已提供密码，KV 里不应再留明文副本。
    // delete 同样消耗一次写配额，所以先 get：只有确实存在残留才删。
    const plain = await store.get(ADMIN_PW_PLAIN_KEY)
    if (plain) await store.delete(ADMIN_PW_PLAIN_KEY)
  } else if (!passwordHash) {
    // 未注入密码：随机生成并保留明文副本供用户取回
    const password = `cfp-${randomHex(8)}`
    const salt = randomHex(8)
    passwordHash = `${salt}:${await hashPassword(password, salt)}`
    await store.put(ADMIN_PW_HASH_KEY, passwordHash)
    generatedPassword = password
    await store.put(ADMIN_PW_PLAIN_KEY, password)
  }

  return { panelPath, passwordHash, generatedPassword }
}

/** 校验密码 */
export async function verifyPassword(context: AuthContext, password: string): Promise<boolean> {
  const [salt, expected] = context.passwordHash.split(':')
  if (!salt || !expected) return false
  const actual = await hashPassword(password, salt)
  return timingSafeEqual(actual, expected)
}

/** 解析 Cookie 头 */
export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie') ?? ''
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

/** 创建会话并返回 Set-Cookie 值 */
export async function createSession(store: Store): Promise<string> {
  const token = randomHex(24)
  await store.put(`${SESSION_PREFIX}${token}`, JSON.stringify({ ua: '', t: Date.now() }), SESSION_TTL)
  return token
}

/** 校验会话 */
export async function verifySession(store: Store, request: Request): Promise<boolean> {
  const token = parseCookies(request)[SESSION_COOKIE]
  if (!token) return false
  const value = await store.get(`${SESSION_PREFIX}${token}`)
  return Boolean(value)
}

export function sessionCookie(token: string, maxAge = SESSION_TTL): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export async function destroySession(store: Store, request: Request): Promise<void> {
  const token = parseCookies(request)[SESSION_COOKIE]
  if (token) await store.delete(`${SESSION_PREFIX}${token}`)
}

/** 签发一次性扫描令牌（10 分钟有效，用后即焚） */
export async function issueOneTimeToken(store: Store): Promise<string> {
  const token = randomHex(20)
  await store.put(`${ONE_TIME_TOKEN_PREFIX}${token}`, '1', ONE_TIME_TTL)
  return token
}

/** 校验扫描回调令牌：支持长期 SCANNER_TOKEN 与一次性令牌 */
export async function verifyScanToken(store: Store, provided: string | null): Promise<boolean> {
  if (!provided) return false
  const longTerm = await store.get('SCANNER_TOKEN')
  if (longTerm && timingSafeEqual(longTerm, provided)) return true
  const oneTime = await store.get(`${ONE_TIME_TOKEN_PREFIX}${provided}`)
  if (oneTime) {
    await store.delete(`${ONE_TIME_TOKEN_PREFIX}${provided}`)
    return true
  }
  return false
}
