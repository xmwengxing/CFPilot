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
 */
export async function loadSubSecret(store: Store): Promise<string> {
  const existing = (await store.get(SUB_SECRET_KEY))?.trim()
  if (existing) return existing
  const fresh = newSecret()
  if (store instanceof KvStore) await store.put(SUB_SECRET_KEY, fresh)
  return fresh
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
