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
 *   - KV 只存**派生值**，绝不存明文密码。
 *   - 环境变量未提供时才随机生成，并把明文写进 KV 的 `ADMIN_PW_PLAIN`
 *     （这是用户唯一的取回途径，因为 Worker 无状态）。
 *
 * 需要「改回 KV 里的旧密码」时，删掉环境变量即可；需要重置则删 KV 的两个键。
 *
 * ## 派生算法：版本化格式
 *
 *   新：`pbkdf2$<迭代次数>$<saltHex>$<hashHex>`
 *   旧：`<saltHex>:<sha256Hex>`（早期版本写进 KV 的格式）
 *
 * 单次 SHA-256 是快速哈希，KV 泄露后自定义弱口令可被离线快速爆破。
 * 现在改用 PBKDF2-HMAC-SHA256；旧格式**继续可验证**，
 * 并在用户成功登录时静默升级（见 `upgradePasswordHash`）。
 *
 * ⚠️ 迭代次数不能盲目调高：Workers 免费计划的单请求 CPU 上限是 10ms，
 * 而面板登录是一次同步请求 —— 迭代数过高会变成「登录直接 1102」。
 * 实测（本机原生实现）每次派生：1 万次 ≈ 1.5ms、3 万次 ≈ 3.7ms、
 * 10 万次 ≈ 12.3ms。故取 3 万次：仍在预算内，且比单次 SHA-256 慢约 300 倍。
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

/** PBKDF2 迭代次数（见文件头注释的 CPU 预算依据） */
const PBKDF2_ITERATIONS = 30000
/** 派生格式前缀 */
const KDF_PREFIX = 'pbkdf2'

/** 字节数组 → 小写十六进制 */
function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16)
  return out
}

/** 小写十六进制 → 字节数组；非法输入返回 null */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return null
  // 显式用 ArrayBuffer 构造：WebCrypto 的 BufferSource 不接受 SharedArrayBuffer 背书
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** PBKDF2-HMAC-SHA256 → 十六进制 */
async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string | null> {
  const salt = hexToBytes(saltHex)
  if (!salt) return null
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  )
  return bytesToHex(new Uint8Array(bits))
}

/** 解析后的密码派生值 */
interface ParsedHash {
  scheme: 'pbkdf2' | 'sha256'
  salt: string
  iterations: number
  expected: string
}

/**
 * 解析 KV 里的密码派生值；脏数据返回 null。
 *
 * 两种格式都要认 —— 只认新格式会让已部署的实例全部登录不了。
 */
function parsePasswordHash(value: string): ParsedHash | null {
  if (value.startsWith(`${KDF_PREFIX}$`)) {
    const [prefix, rawIterations, salt, expected] = value.split('$')
    if (prefix !== KDF_PREFIX || !salt || !expected) return null
    const iterations = Number.parseInt(rawIterations ?? '', 10)
    if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1_000_000) return null
    return { scheme: 'pbkdf2', salt, iterations, expected }
  }
  const [salt, expected] = value.split(':')
  if (!salt || !expected) return null
  return { scheme: 'sha256', salt, iterations: 0, expected }
}

/** 按解析出的方案重算派生值 */
async function derive(parsed: ParsedHash, password: string): Promise<string | null> {
  if (parsed.scheme === 'pbkdf2') return await pbkdf2Hex(password, parsed.salt, parsed.iterations)
  return await sha256Hex(`${parsed.salt}:${password}`)
}

/** 用当前方案生成 `salt` + 派生值 */
async function hashPassword(password: string, salt: string): Promise<string> {
  const digest = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)
  // 极端情况下（salt 非法）退回旧方案，绝不写入不可验证的哈希
  if (!digest) return `${salt}:${await sha256Hex(`${salt}:${password}`)}`
  return `${KDF_PREFIX}$${PBKDF2_ITERATIONS}$${salt}$${digest}`
}

/**
 * 判断 KV 里存着的派生值是否就是给定密码的派生结果。
 *
 * 空值、缺字段的脏数据一律返回 false（视为需要重新写）。
 * 用 `timingSafeEqual` 比较，避免逐字符比较泄露哈希前缀。
 */
async function hashMatches(passwordHash: string, password: string): Promise<boolean> {
  const parsed = parsePasswordHash(passwordHash)
  if (!parsed) return false
  const actual = await derive(parsed, password)
  if (!actual) return false
  return timingSafeEqual(actual, parsed.expected)
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
      passwordHash = await hashPassword(envPw, salt)
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
    passwordHash = await hashPassword(password, salt)
    await store.put(ADMIN_PW_HASH_KEY, passwordHash)
    generatedPassword = password
    await store.put(ADMIN_PW_PLAIN_KEY, password)
  }

  return { panelPath, passwordHash, generatedPassword }
}

/**
 * 校验密码，并告知调用方「这份哈希还是旧格式」。
 *
 * 旧格式（单次 SHA-256）验证通过后应当**立即升级**为 PBKDF2 ——
 * 用户不需要做任何操作，下次冷启动就与新实例一致。
 */
export async function verifyPasswordDetailed(
  context: AuthContext,
  password: string
): Promise<{ ok: boolean; legacy: boolean }> {
  const parsed = parsePasswordHash(context.passwordHash)
  if (!parsed) return { ok: false, legacy: false }
  const actual = await derive(parsed, password)
  if (!actual) return { ok: false, legacy: false }
  const ok = timingSafeEqual(actual, parsed.expected)
  return { ok, legacy: ok && parsed.scheme === 'sha256' }
}

/** 校验密码 */
export async function verifyPassword(context: AuthContext, password: string): Promise<boolean> {
  return (await verifyPasswordDetailed(context, password)).ok
}

/**
 * 把 KV 里的密码哈希升级为当前方案（幂等）。
 *
 * 只允许在**密码已经验证通过**之后调用 —— 这里不做任何校验，
 * 传错密码会把用户锁在面板外面。
 *
 * ⚠️ 这是一次显式写 KV。调用点必须保证「确实需要升级」，
 * 否则会放大会员配额消耗（免费版 1000 写/天，见 AGENTS §1.30）。
 */
export async function upgradePasswordHash(store: Store, password: string): Promise<void> {
  const salt = randomHex(8)
  await store.put(ADMIN_PW_HASH_KEY, await hashPassword(password, salt))
}

/**
 * 登录成功后丢弃 KV 里的自动生成密码明文。
 *
 * 只有「未注入 `PANEL_PASSWORD`、由内核随机生成」的实例才会写这个键。
 * 明文留在 KV 的唯一价值是「用户忘了密码，去 Cloudflare 控制台 KV 里取回」，
 * 而这个价值在**第一次成功登录之后就不存在了** —— 继续留着只是扩大
 * KV 被意外读取时的影响面。
 *
 * 因此把明文当作**一次性凭据**：登录成功即删。
 *
 * ⚠️ 先 `get` 再 `delete`：delete 同样消耗一次写配额（AGENTS §1.30），
 * 绝大多数实例（部署向导都会注入密码）根本没有这个键，
 * 不该为每次登录白付一次写。
 */
export async function discardPlaintextPassword(store: Store): Promise<void> {
  const plain = await store.get(ADMIN_PW_PLAIN_KEY)
  if (plain) await store.delete(ADMIN_PW_PLAIN_KEY)
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
