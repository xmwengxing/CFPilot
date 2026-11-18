/**
 * 通用工具函数
 */

const HEX = '0123456789abcdef'

/** 随机十六进制字符串 */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

/** 随机 UUID v4 */
export function randomUuid(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  buf[6] = (buf[6]! & 0x0f) | 0x40
  buf[8] = (buf[8]! & 0x3f) | 0x80
  const hex: string[] = []
  for (const b of buf) hex.push(HEX[b >> 4]! + HEX[b & 15]!)
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

/** 随机字母数字串（用于 Worker 名称混淆） */
export function randomAlnum(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const buf = new Uint8Array(length)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += alphabet[b % alphabet.length]
  return out
}

/** UTF-8 字符串 → Base64 */
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Base64 → UTF-8 字符串（容错：忽略非法字符） */
export function base64Decode(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9+/=]/g, '')
  const binary = atob(cleaned)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** SHA-256 → 十六进制 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const view = new Uint8Array(digest)
  let out = ''
  for (const b of view) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

/** 恒定时间字符串比较 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 安全解析 JSON */
export function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 截断字符串 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 读取请求体，但**在读取过程中**就限制字节数。
 *
 * ## 为什么不能用 `await request.arrayBuffer()` 再判长度
 *
 * `Content-Length` 并不可信（可以缺失、也可以是分块传输）：先完整读进内存
 * 再判超限，超限那一刻内存**已经分配出去了**。XHTTP 的 packet-up 与面板
 * 配置接口都吃过这个亏 —— 并发几个大 body 就能把 isolate 顶到 1101。
 *
 * 这里按流式累加：越界立刻 `cancel()` 并返回 `null`，分配量始终 ≤ maxBytes。
 *
 * @returns 正文（可能为空数组）；超限或读取失败返回 `null`
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  // 先看声明值：能提前拒绝的就不要开始读
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return null

  const body = request.body
  if (!body) {
    try {
      const buffer = await request.arrayBuffer()
      return buffer.byteLength > maxBytes ? null : new Uint8Array(buffer)
    } catch {
      return null
    }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel('body too large')
        } catch {
          /* 已取消 */
        }
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * 限量读取 + 解析 JSON。
 *
 * `tooLarge` 与「不是合法 JSON」必须分开：前者是 413，后者是 400 ——
 * 混成一个错误会让客户端分不清该改内容还是该减体积。
 */
export async function readJsonLimited<T>(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; value: T } | { ok: false; tooLarge: boolean }> {
  const bytes = await readBodyLimited(request, maxBytes)
  if (!bytes) return { ok: false, tooLarge: true }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T }
  } catch {
    return { ok: false, tooLarge: false }
  }
}
