/**
 * 本地凭据存储 —— 多账户（profile）版本
 *
 * ## 安全边界（重要，不变）
 *
 * Cloudflare API Token 与面板密码**只写在本机**：
 *   - 路径：`<用户目录>/.cfpilot-gui/secrets.json`
 *   - 该文件不进 Git、不进安装包、不上传任何服务器
 *   - 唯一出境网络请求是 Cloudflare 官方 API（api.cloudflare.com）
 *
 * ## 文件格式（v2，2026-10-25）
 *
 * ```json
 * {
 *   "version": 2,
 *   "activeId": "acc_ab12cd34",
 *   "profiles": [
 *     {
 *       "id": "acc_ab12cd34",
 *       "name": "主账号（xxx@qq.com）",
 *       "cfToken": "...",
 *       "accountId": "...",
 *       "accountName": "...",
 *       "kvNamespaceId": "...",
 *       "panelPassword": "...",
 *       "createdAt": "2026-10-25T10:00:00.000Z",
 *       "updatedAt": "2026-10-25T10:00:00.000Z"
 *     }
 *   ]
 * }
 * ```
 *
 * ## 为什么要有 profile
 *
 * 一台机器上经常需要维护多个 Cloudflare 账号（自己的、朋友的、测试号）。
 * 老版本只存一份凭据，切账号就得反复覆盖 token，还容易把 A 账号的部署
 * 写到 B 账号的 KV 上。现在每个账号一份独立配置，界面上一键切换。
 *
 * ## 向后兼容（v1 → v2 自动迁移）
 *
 * 老文件是扁平的 `{ cfToken, accountId, kvNamespaceId, panelPassword }`。
 * 读取时检测到没有 `profiles` 字段就自动包成一个 profile 并落盘，
 * 用户无感、不需要重新填 Token。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** 一份账户配置 */
export interface CredentialProfile {
  /** 稳定 id（`acc_` + 8 位随机） */
  id: string
  /** 展示名，默认自动生成（账号名或邮箱） */
  name: string
  /** Cloudflare API Token（敏感） */
  cfToken: string
  /** 账号 ID（非敏感，方便预填） */
  accountId: string
  /** 账号名（检测账号后自动填，用于展示） */
  accountName: string
  /** KV 命名空间 ID（非敏感） */
  kvNamespaceId: string
  /** 面板密码（敏感） */
  panelPassword: string
  createdAt: string
  updatedAt: string
}

/** 磁盘文件结构 */
interface SecretsFile {
  version: 2
  activeId: string
  profiles: CredentialProfile[]
}

/**
 * 兼容旧调用方的「扁平」视图。
 *
 * 老代码（bridge / renderer）到处用 `loadSecrets().cfToken`，
 * 这里保留同名导出并映射到**当前激活的 profile**，
 * 这样多账户改造不需要动所有调用点。
 */
export interface StoredSecrets {
  cfToken: string
  accountId: string
  kvNamespaceId: string
  panelPassword: string
}

const EMPTY_SECRETS: StoredSecrets = {
  cfToken: '',
  accountId: '',
  kvNamespaceId: '',
  panelPassword: '',
}

/** 配置目录：~/.cfpilot-gui */
export function configDir(): string {
  return join(homedir(), '.cfpilot-gui')
}

function secretsPath(): string {
  return join(configDir(), 'secrets.json')
}

/** 生成 profile id */
function newProfileId(): string {
  return 'acc_' + randomBytes(4).toString('hex')
}

/** 新建一份空 profile */
function blankProfile(name: string): CredentialProfile {
  const now = new Date().toISOString()
  return {
    id: newProfileId(),
    name,
    cfToken: '',
    accountId: '',
    accountName: '',
    kvNamespaceId: '',
    panelPassword: '',
    createdAt: now,
    updatedAt: now,
  }
}

/** 读取磁盘原始内容（不做迁移） */
function readRaw(): unknown {
  try {
    return JSON.parse(readFileSync(secretsPath(), 'utf8')) as unknown
  } catch {
    return null
  }
}

/** 写文件（目录不存在时创建） */
function writeFile(file: SecretsFile): void {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(secretsPath(), JSON.stringify(file, null, 2), 'utf8')
}

/**
 * v1（扁平）→ v2（profiles）迁移。
 *
 * 只在读到旧格式时执行一次；迁移后立即落盘。
 */
function migrateV1(raw: Partial<StoredSecrets>): SecretsFile {
  const profile = blankProfile(deriveName(raw.accountId ?? '', ''))
  profile.cfToken = (raw.cfToken ?? '').trim()
  profile.accountId = (raw.accountId ?? '').trim()
  profile.kvNamespaceId = (raw.kvNamespaceId ?? '').trim()
  profile.panelPassword = (raw.panelPassword ?? '').trim()
  const file: SecretsFile = { version: 2, activeId: profile.id, profiles: [profile] }
  writeFile(file)
  return file
}

/** 读取整个文件（含自动迁移） */
function readFile(): SecretsFile {
  const raw = readRaw()
  // 完全没有文件
  if (raw === null || typeof raw !== 'object') {
    return { version: 2, activeId: '', profiles: [] }
  }
  const obj = raw as Record<string, unknown>
  // v2
  if (Array.isArray(obj.profiles)) {
    const profiles = (obj.profiles as unknown[])
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
      .map((p) => normalizeProfile(p))
    const activeId = typeof obj.activeId === 'string' ? obj.activeId : ''
    // activeId 失效时回落到第一个
    const effective = profiles.some((p) => p.id === activeId) ? activeId : (profiles[0]?.id ?? '')
    return { version: 2, activeId: effective, profiles }
  }
  // v1（扁平）
  return migrateV1(obj as Partial<StoredSecrets>)
}

/** 把磁盘上的任意对象补全成合法 profile */
function normalizeProfile(p: Record<string, unknown>): CredentialProfile {
  const now = new Date().toISOString()
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: str(p.id) || newProfileId(),
    name: str(p.name) || '未命名账户',
    cfToken: str(p.cfToken),
    accountId: str(p.accountId),
    accountName: str(p.accountName),
    kvNamespaceId: str(p.kvNamespaceId),
    panelPassword: str(p.panelPassword),
    createdAt: str(p.createdAt) || now,
    updatedAt: str(p.updatedAt) || now,
  }
}

/**
 * 推导一个像样的展示名。
 *
 * 优先用邮箱/账号名；都没有时用账号 ID 前 8 位，最后回落「新账户」。
 */
export function deriveName(accountName: string, accountId: string): string {
  const name = accountName.trim()
  if (name) return name
  const id = accountId.trim()
  if (id) return `账户 ${id.slice(0, 8)}`
  return '新账户'
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 列出全部 profile（不含激活标记，UI 自己用 activeId 比对） */
export function listProfiles(): CredentialProfile[] {
  return readFile().profiles
}

/** 当前激活的 profile id */
export function activeProfileId(): string {
  return readFile().activeId
}

/** 取当前激活的 profile（没有则返回 null） */
export function activeProfile(): CredentialProfile | null {
  const file = readFile()
  return file.profiles.find((p) => p.id === file.activeId) ?? null
}

/**
 * 兼容层：以「扁平」形态返回当前激活 profile 的凭据。
 *
 * 老代码的 `loadSecrets()` 调用点全部无需改动。
 */
export function loadSecrets(): StoredSecrets {
  const p = activeProfile()
  if (!p) return { ...EMPTY_SECRETS }
  return {
    cfToken: p.cfToken,
    accountId: p.accountId,
    kvNamespaceId: p.kvNamespaceId,
    panelPassword: p.panelPassword,
  }
}

/** 兼容层：更新当前激活 profile 的字段（没有激活项时自动新建一份） */
export function saveSecrets(secrets: Partial<StoredSecrets>): void {
  const file = readFile()
  let target = file.profiles.find((p) => p.id === file.activeId)
  if (!target) {
    target = blankProfile(deriveName(secrets.accountId ?? '', secrets.accountId ?? ''))
    file.profiles.push(target)
    file.activeId = target.id
  }
  if (secrets.cfToken !== undefined) target.cfToken = secrets.cfToken.trim()
  if (secrets.accountId !== undefined) target.accountId = secrets.accountId.trim()
  if (secrets.kvNamespaceId !== undefined) target.kvNamespaceId = secrets.kvNamespaceId.trim()
  if (secrets.panelPassword !== undefined) target.panelPassword = secrets.panelPassword
  target.updatedAt = new Date().toISOString()
  writeFile(file)
}

/** 是否已保存令牌 */
export function hasToken(): boolean {
  return loadSecrets().cfToken.trim().length > 0
}

/** 新建一份 profile 并设为激活；返回新 profile */
export function createProfile(name?: string, init?: Partial<StoredSecrets>): CredentialProfile {
  const file = readFile()
  const label = (name ?? '').trim() || deriveName(init?.accountId ?? '', init?.accountId ?? '')
  const profile = blankProfile(label)
  if (init?.cfToken !== undefined) profile.cfToken = init.cfToken.trim()
  if (init?.accountId !== undefined) profile.accountId = init.accountId.trim()
  if (init?.kvNamespaceId !== undefined) profile.kvNamespaceId = init.kvNamespaceId.trim()
  if (init?.panelPassword !== undefined) profile.panelPassword = init.panelPassword
  file.profiles.push(profile)
  file.activeId = profile.id
  writeFile(file)
  return profile
}

/** 更新指定 profile（id 不存在时抛错） */
export function updateProfile(
  id: string,
  patch: Partial<Omit<CredentialProfile, 'id' | 'createdAt'>>
): CredentialProfile {
  const file = readFile()
  const target = file.profiles.find((p) => p.id === id)
  if (!target) throw new Error(`账户配置不存在：${id}`)
  if (patch.name !== undefined) target.name = patch.name.trim() || target.name
  if (patch.cfToken !== undefined) target.cfToken = patch.cfToken.trim()
  if (patch.accountId !== undefined) target.accountId = patch.accountId.trim()
  if (patch.accountName !== undefined) target.accountName = patch.accountName.trim()
  if (patch.kvNamespaceId !== undefined) target.kvNamespaceId = patch.kvNamespaceId.trim()
  if (patch.panelPassword !== undefined) target.panelPassword = patch.panelPassword
  target.updatedAt = new Date().toISOString()
  // 名字没手工指定过时，跟随账号名自动更新
  if (patch.name === undefined && patch.accountName !== undefined) {
    target.name = deriveName(target.accountName, target.accountId)
  }
  writeFile(file)
  return target
}

/**
 * 删除指定 profile。
 *
 * - 不允许删到 0 份？
 *   **允许** —— 用户可能想完全清空。但删掉激活项时要顺延到下一个。
 * - 删除后 activeId 指向下一个可用项（优先原位置的下一项）。
 */
export function deleteProfile(id: string): { deleted: boolean; activeId: string } {
  const file = readFile()
  const index = file.profiles.findIndex((p) => p.id === id)
  if (index < 0) return { deleted: false, activeId: file.activeId }

  file.profiles.splice(index, 1)
  if (file.activeId === id) {
    const next = file.profiles[Math.min(index, file.profiles.length - 1)]
    file.activeId = next?.id ?? ''
  }
  writeFile(file)
  return { deleted: true, activeId: file.activeId }
}

/** 切换激活的 profile */
export function setActiveProfile(id: string): { ok: boolean; activeId: string } {
  const file = readFile()
  if (!file.profiles.some((p) => p.id === id)) {
    return { ok: false, activeId: file.activeId }
  }
  file.activeId = id
  writeFile(file)
  return { ok: true, activeId: id }
}

/**
 * 清除本机所有凭据。
 *
 * 优先移动到 `.bak` 而不是直接删：误点也能找回。
 * 只有 `.bak` 已存在时才真正删除旧文件。
 */
export function clearSecrets(): void {
  const path = secretsPath()
  try {
    if (!existsSync(path)) return
    const backup = path + '.bak'
    if (existsSync(backup)) rmSync(backup, { force: true })
    renameSync(path, backup)
  } catch {
    try {
      rmSync(path, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}
