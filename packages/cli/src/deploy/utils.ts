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

/**
 * 生成纯随机的 Worker 名称。
 *
 * 社区通用的防风控建议：名称里不要带任何项目特征
 * （例如 cfpilot / vless / proxy 之类），否则同一账号下批量部署时更容易被识别。
 * 规则：首字符为小写字母，其余为小写字母或数字，总长度 8~10 位。
 */
export function randomWorkerName(): string {
  const length = 8 + (randomBytes(1)[0]! % 3)
  const first = 'abcdefghijklmnopqrstuvwxyz'[randomBytes(1)[0]! % 26]!
  return `${first}${randomAlnum(length - 1)}`
}

/** 生成权限预检用的探测脚本名（纯随机，避免与真实脚本撞名） */
export function randomProbeScriptName(): string {
  return `probe${randomAlnum(10)}`
}

/** 人类可读的随机面板路径 */
export function randomPanelPath(): string {
  return `/p-${randomAlnum(8)}`
}

/**
 * 生成随机的 WebSocket 代理路径。
 *
 * 不要用 `/vless`、`/trojan`、`/proxy` 这类字面量：它们既是强特征文本，
 * 也会让所有用默认配置的部署完全一致。用一段无意义的随机串更稳妥。
 */
export function randomWsPath(): string {
  return `/${randomAlnum(10)}`
}
