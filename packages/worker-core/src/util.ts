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
