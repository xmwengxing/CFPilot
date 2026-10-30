/**
 * 本地配置（~/.cfpilot/config.json）
 *
 * 只存**非敏感**信息（账号 ID、KV ID、控制面域名等）。
 * Token 与面板密码默认不落盘，除非用户显式选择保存。
 *
 * ## 文件权限
 *
 * 一旦用户选择保存 Token / 面板密码，这个文件就是**完整凭据** ——
 * 拿到它就能操作用户的 Cloudflare 账号。所以：
 *
 *   目录 0700（仅本人可进入）
 *   文件 0600（仅本人可读写）
 *
 * ⚠️ 仅对新建文件生效是不够的：已有文件（旧版本创建的默认 0644）
 * 必须显式 `chmod` 修正，否则升级后仍然全局可读。
 * Windows 上 chmod 只切换只读位，不影响 ACL，调用一律容错处理。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

/** 配置目录权限（仅本人可进入） */
const DIR_MODE = 0o700
/** 配置文件权限（仅本人可读写） */
const FILE_MODE = 0o600

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

/**
 * 与**账号绑定**的字段。
 *
 * 这些字段描述的是「某个账号下的某个实例」，一旦换了 Token（= 换了账号）
 * 就全部失效。若不清空，就会出现「A 的 KV + B 的 Token」这种串号：
 * 部署落到新账号、回填打到旧账号的面板、改密码改到旧账号的实例。
 */
export const ACCOUNT_SCOPED_FIELDS = [
  'accountId',
  'accountName',
  'kvNamespaceId',
  'panelHost',
  'dataHost',
  'wsPath',
  'panelPassword',
] as const

/**
 * 创建（或收紧）配置目录权限。
 *
 * `mkdirSync` 的 `mode` 只对**新建**目录生效，已有目录保持原样；
 * 所以这里补一次 `chmodSync`。失败（Windows / 只读挂载）不影响写入。
 */
function ensureConfigDir(): string {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try {
    chmodSync(dir, DIR_MODE)
  } catch {
    /* Windows / 无权限：交给操作系统默认策略 */
  }
  return dir
}

export function saveConfig(patch: Partial<Config>): void {
  const current = loadConfig()
  const next = { ...current, ...patch }
  // 删除空值，避免残留空字符串
  for (const k of Object.keys(next) as Array<keyof Config>) {
    if (next[k] === '' || next[k] === undefined) delete next[k]
  }
  ensureConfigDir()
  const file = configFile()
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE })
  try {
    // 旧版本创建的 0644 文件不会因为 mode 参数而改变，必须显式修正
    chmodSync(file, FILE_MODE)
  } catch {
    /* 同上 */
  }
}

/**
 * 保存 API Token。
 *
 * ## 为什么要单独一个函数
 *
 * `saveConfig` 是**合并语义**（`{ ...current, ...patch }`），
 * 没在 patch 里出现的字段全部保留。于是「贴入新 Token」之后配置会变成：
 *
 *   { token: tokenB, accountId: A, kvNamespaceId: KVA,
 *     panelHost: A的域名, dataHost: A的域名, wsPath: A的WS路径 }
 *
 * —— **新 Token 配旧账户的 KV 与域名**。
 * 后续回填会打到上一个账户的面板、改密码会改到上一个账户的实例。
 *
 * 所以换 Token 时必须**先清空所有账号相关字段**，再写新 Token。
 * （`saveConfig` 会把空串键删掉，所以传空串即等于「清空」。）
 *
 * @param token 新 Token
 * @param keep  同一次调用里**显式指定**的字段（不清空），
 *              例如 `cfpilot config --token X --account Y`
 */
export function saveToken(token: string, keep: Partial<Config> = {}): void {
  const trimmed = token.trim()
  const current = loadConfig()
  const changed = (current.token ?? '') !== trimmed

  // 只保留**显式给出**的字段（undefined 视为没给）
  const explicit: Partial<Config> = {}
  for (const key of Object.keys(keep) as Array<keyof Config>) {
    const value = keep[key]
    if (value !== undefined) explicit[key] = value
  }

  if (!changed) {
    // 同一个 Token：账号没变，已有字段仍然有效
    saveConfig({ token: trimmed, ...explicit })
    return
  }

  const clearing: Partial<Config> = {}
  for (const key of ACCOUNT_SCOPED_FIELDS) clearing[key] = ''
  saveConfig({ ...clearing, ...explicit, token: trimmed })
}

export function clearConfig(): void {
  const file = configFile()
  if (!existsSync(file)) return
  // 同样是凭据文件：清空后仍要维持 0600，否则后续写入会落在全局可读的旧文件上
  writeFileSync(file, '{}\n', { encoding: 'utf8', mode: FILE_MODE })
  try {
    chmodSync(file, FILE_MODE)
  } catch {
    /* Windows / 无权限 */
  }
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
