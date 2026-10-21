/**
 * 部署向导用到的随机值与工具
 */
import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function randomAlnum(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export function randomUuid(): string {
  return randomBytes(16).toString('hex').replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    '$1-$2-$3-$4-$5'
  )
}

export function randomPassword(): string {
  return `cfp-${randomAlnum(14)}`
}

/** 生成一个不易撞名的 Worker 名（借鉴 BPB-Wizard 的随机化思路） */
export function randomWorkerName(prefix = 'cfpilot'): string {
  return `${prefix}-${randomAlnum(6)}`
}

/** 人类可读的随机面板路径 */
export function randomPanelPath(): string {
  return `/p-${randomAlnum(8)}`
}
