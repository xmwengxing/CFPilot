/**
 * 订阅链接签名（无状态 HMAC 令牌）
 *
 * ## 解决什么问题
 *
 * 经典订阅链接是 `/sub/<UUID>`，**永久有效**：链接一旦泄露（截图、群里问、
 * 丢进某个机场聚合站），任何人都能无限期拉取订阅。而每次拉取订阅都要跑一遍
 * 节点收集（`collectNodes`，含远端池请求），烧的是 CPU 与 subrequest 配额 ——
 * 这才是「被白嫖」真正的代价，不是流量。
 *
 * ## 为什么是「可轮换签名」而不是「24 小时过期」
 *
 * 客户端（Clash / v2rayN / sing-box）把订阅 URL 存在本地，只会在定时器到点时
 * 重新拉取。给一个 24 小时就过期的链接，用户的体验是「第二天打开客户端
 * 一片红色报错，必须重新导入」—— 而**已导入的节点其实还能用**，
 * 所以这个 TTL 换来的不是安全，只是噪音。
 *
 * 真正能止损的是**密钥轮换**：泄露后点一下「轮换」，所有旧签名立即失效，
 * 已导入的客户端只是更新失败，节点照旧可用，用户再导入一次新链接即可。
 * 因此默认 TTL = 0（永久），需要更严格时才在面板里设 7 / 30 天。
 *
 * ## 格式
 *
 * ```
 * v1.<exp>.<nonce>.<sig>
 *   exp   过期时间（Unix 秒，base36）；0 = 永久
 *   nonce 8 位 base36 随机数（防止同一秒内签出相同令牌）
 *   sig   base64url(HMAC-SHA256(secret, "v1.<exp>.<nonce>")) 前 22 位
 * ```
 *
 * 无状态：校验只需要 secret，**不需要任何 KV 写**，也不会因为 isolate 不同而失效。
 */
import type { Store } from './store'
import { KvStore } from './store'
import { randomHex, timingSafeEqual } from './util'

/** KV 中的签名密钥（与本实例的其他键一样，全局平铺、无实例前缀） */
export const SUB_SECRET_KEY = 'SUB_TOKEN_SECRET'

/** 订阅令牌模式 */
export type SubTokenMode = 'legacy' | 'signed'

/** 令牌版本前缀 */
const VERSION = 'v1'

/** 签名截断长度：132 bit，暴力枚举不可行，且链接足够短 */
const SIG_LEN = 22

const TEXT = new TextEncoder()

/** 字节 → base64url（无填充） */
function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** HMAC-SHA256 → base64url */
async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, TEXT.encode(payload))
  return toBase64Url(new Uint8Array(sig))
}

/** 随机密钥（32 字节十六进制） */
const newSecret = (): string => randomHex(32)

/**
 * 读取签名密钥；不存在时**自动生成并写回**。
 *
 * ⚠️ 与 `loadConfig` 里的 UUID 自愈同一条规矩：只有**持久化存储（KV）**才允许
 * 自动生成并写回。未绑定 KV 时每次请求都是新的 `MemoryStore`，
 * 自动生成等于每个请求一把新密钥 —— 签出来的链接下一个请求就校验失败。
 *
 * ⚠️ **同样要避开「陈旧读」**（KV 读最终一致，约 60 秒）：
 * 若一次陈旧读读不到密钥，就会**生成一把新密钥**并写回 ⇒
 * **此前签发的所有 `v1.` 订阅链接立刻全部失效**，
 * 而且每次陈旧读都产生一次写。这类写用户点不到也拦不住。
 *
 * 办法：与 `loadConfig` 同一口径 —— **键持续缺失超过传播窗口**才生成
 * （90 秒），期间只读不写；并把已生成的密钥缓存在模块级，
 * 让同一隔离体在窗口内保持一致（不会签出「一把密钥一个链接」）。
 */
export async function loadSubSecret(store: Store): Promise<string> {
  const existing = (await store.get(SUB_SECRET_KEY))?.trim()
  if (existing) {
    // 键重新可见，说明此前的缺失窗口已结束；下一次陈旧读必须重新计时。
    subSecretAbsentSince = 0
    pendingSecret = null
    localSecret = existing
    return existing
  }
  // 未绑定 KV（本地调试）：不写回，每次一个新密钥。
  // ⚠️ 这是**刻意**的行为：未绑定 KV 时每个请求都是新的 MemoryStore，
  // 自动写回等于每个请求一把新密钥，签出来的链接下一个请求就校验失败。
  if (!(store instanceof KvStore)) return newSecret()
  // 持久化存储（KV）：先看模块级缓存（同一隔离体内保持一致）
  if (localSecret) return localSecret
  // 键持续缺失超过传播窗口才生成
  const now = Date.now()
  if (subSecretAbsentSince === 0) subSecretAbsentSince = now
  if (now - subSecretAbsentSince <= SUB_SECRET_ABSENT_GRACE_MS) {
    // 窗口内不生成、不写：返回一个隔离体内稳定的值，避免签出互相不认的令牌
    if (!pendingSecret) pendingSecret = newSecret()
    return pendingSecret
  }
  const fresh = newSecret()
  await store.put(SUB_SECRET_KEY, fresh)
  subSecretAbsentSince = 0
  pendingSecret = fresh
  localSecret = fresh
  return fresh
}

/** 本隔离体已确认写入 KV 的密钥。 */
let localSecret: string | null = null

/** 等待窗口内使用的临时密钥（未写入 KV，同一隔离体内稳定）。 */
let pendingSecret: string | null = null

/** 键「持续缺失」的起始时刻（隔离体级）。 */
let subSecretAbsentSince = 0

/**
 * 键缺失后要等多久才允许生成密钥（毫秒）。
 *
 * 必须大于 Cloudflare KV 的读传播窗口（约 60 秒）。
 */
const SUB_SECRET_ABSENT_GRACE_MS = 90_000

/** 只给测试隔离用：重置密钥缓存。 */
export function resetSubSecretState(): void {
  localSecret = null
  pendingSecret = null
  subSecretAbsentSince = 0
}

/** 轮换密钥：旧签名令牌立即全部失效（不可撤销） */
export async function rotateSubSecret(store: Store): Promise<string> {
  const fresh = newSecret()
  if (store instanceof KvStore) {
    await store.put(SUB_SECRET_KEY, fresh)
  } else {
    // 内存存储（本地调试）也写一次，保证同一实例内前后一致
    await store.put(SUB_SECRET_KEY, fresh)
  }
  // 轮换后立即同步本 isolate 缓存，避免 KV 陈旧读继续签出/验证旧密钥。
  localSecret = fresh
  pendingSecret = null
  subSecretAbsentSince = 0
  return fresh
}

export interface SignOptions {
  /** 有效期（天）；0 或负数 = 永久 */
  ttlDays?: number
  /** 当前时间（测试注入） */
  now?: number
}

/**
 * 签发订阅令牌。
 *
 * @param secret 由 `loadSubSecret` 取得
 */
export async function signSubToken(secret: string, options: SignOptions = {}): Promise<string> {
  const ttl = options.ttlDays ?? 0
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000)
  const exp = ttl > 0 ? nowSec + Math.round(ttl * 86400) : 0
  const nonce = Math.floor(Math.random() * 36 ** 8).toString(36).padStart(8, '0')
  const body = `${VERSION}.${exp.toString(36)}.${nonce}`
  const sig = (await hmac(secret, body)).slice(0, SIG_LEN)
  return `${body}.${sig}`
}

export interface VerifyResult {
  ok: boolean
  /** 失败原因（英文短码，便于日志与测试断言） */
  reason?: 'format' | 'signature' | 'expired'
  /** 过期时间（Unix 秒）；0 = 永久 */
  exp?: number
}

/**
 * 校验订阅令牌。
 *
 * 只做三件事：格式、签名、过期。**不查 KV**（secret 由调用方传入），
 * 因此可以放在订阅热路径上。
 */
export async function verifySubToken(
  secret: string,
  token: string,
  now: number = Date.now()
): Promise<VerifyResult> {
  if (!secret || !token) return { ok: false, reason: 'format' }
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: 'format' }
  const expText = parts[1]!
  const nonce = parts[2]!
  const sig = parts[3]!
  if (!expText || !nonce || sig.length !== SIG_LEN) return { ok: false, reason: 'format' }

  const exp = Number.parseInt(expText, 36)
  if (!Number.isFinite(exp) || exp < 0) return { ok: false, reason: 'format' }

  const expected = (await hmac(secret, `${VERSION}.${expText}.${nonce}`)).slice(0, SIG_LEN)
  // 定长比较：避免按字节提前返回泄露签名前缀
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: 'signature' }

  if (exp > 0 && Math.floor(now / 1000) >= exp) return { ok: false, reason: 'expired', exp }
  return { ok: true, exp }
}
