/**
 * 本地凭据存储
 *
 * ## 安全边界（重要）
 *
 * Cloudflare API Token 与面板密码**只写在本机**：
 *   - 路径：`<用户目录>/.cfpilot-gui/secrets.json`
 *   - 该文件不进 Git、不进安装包、不上传任何服务器
 *   - 唯一出境网络请求是 Cloudflare 官方 API（api.cloudflare.com）
 *     ——这是部署功能本身必需的，令牌仅用于该请求的 Authorization 头
 *
 * 工具在 UI 上对此有明示，见 renderer 的「安全说明」区块。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface StoredSecrets {
  /** Cloudflare API Token */
  cfToken: string
  /** 账号 ID（非敏感，方便下次预填） */
  accountId: string
  /** KV 命名空间 ID（非敏感） */
  kvNamespaceId: string
  /** 面板密码（敏感） */
  panelPassword: string
}

const EMPTY: StoredSecrets = {
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

/** 读取本机保存的凭据；不存在返回空对象 */
export function loadSecrets(): StoredSecrets {
  try {
    const raw = readFileSync(secretsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSecrets>
    return { ...EMPTY, ...parsed }
  } catch {
    return { ...EMPTY }
  }
}

/** 保存凭据到本机。目录不存在时创建。 */
export function saveSecrets(secrets: Partial<StoredSecrets>): void {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const merged = { ...loadSecrets(), ...secrets }
  writeFileSync(secretsPath(), JSON.stringify(merged, null, 2), 'utf8')
}

/** 清除本机保存的所有凭据 */
export function clearSecrets(): void {
  try {
    rmSync(secretsPath(), { force: true })
  } catch {
    /* 文件不存在时忽略 */
  }
}

/** 是否已保存令牌（用于 UI 显示状态） */
export function hasToken(): boolean {
  return loadSecrets().cfToken.trim().length > 0
}
