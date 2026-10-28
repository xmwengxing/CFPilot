/**
 * 本地配置（~/.cfpilot/config.json）
 *
 * 只存**非敏感**信息（账号 ID、KV ID、控制面域名等）。
 * Token 与面板密码默认不落盘，除非用户显式选择保存。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface Config {
  /** Cloudflare API Token（可选保存） */
  token?: string
  /** 账号 ID */
  accountId?: string
  /** 账号名（仅展示） */
  accountName?: string
  /** KV 命名空间 ID */
  kvNamespaceId?: string
  /** 控制面域名（回填用） */
  panelHost?: string
  /** 面板密码（可选保存） */
  panelPassword?: string
  /** 数据面域名（优选用） */
  dataHost?: string
  /** WS 路径 */
  wsPath?: string
}

/**
 * 配置目录。
 *
 * 默认 `~/.cfpilot`；`CFPILOT_CONFIG_DIR` 可覆盖 —— **仅供测试隔离**，
 * 避免单元测试写到用户真实的配置里。
 *
 * ⚠️ 每次调用都重新读环境变量（不是模块加载时求值），
 * 否则测试里 `vi.stubEnv` 会不生效。
 */
function configDir(): string {
  const override = process.env.CFPILOT_CONFIG_DIR?.trim()
  return override ? override : join(homedir(), '.cfpilot')
}

function configFile(): string {
  return join(configDir(), 'config.json')
}

export function configPath(): string {
  return configFile()
}

export function loadConfig(): Config {
  const file = configFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Config
  } catch {
    return {}
  }
}

export function saveConfig(patch: Partial<Config>): void {
  const current = loadConfig()
  const next = { ...current, ...patch }
  // 删除空值，避免残留空字符串
  for (const k of Object.keys(next) as Array<keyof Config>) {
    if (next[k] === '' || next[k] === undefined) delete next[k]
  }
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

export function clearConfig(): void {
  const file = configFile()
  if (existsSync(file)) writeFileSync(file, '{}\n', 'utf8')
}

/**
 * 取 Token：优先参数 → 环境变量 → 配置文件。
 */
export function resolveToken(fromArgs?: string): string {
  return (fromArgs || '').trim() || (process.env.CLOUDFLARE_API_TOKEN || '').trim() || loadConfig().token || ''
}

/** 配置是否完整到可以部署。 */
export function isConfigured(cfg: Config = loadConfig()): boolean {
  return Boolean(cfg.token)
}
