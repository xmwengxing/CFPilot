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

const CONFIG_DIR = join(homedir(), '.cfpilot')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export function configPath(): string {
  return CONFIG_FILE
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
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
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

export function clearConfig(): void {
  if (existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, '{}\n', 'utf8')
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
