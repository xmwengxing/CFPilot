/**
 * 配置导入导出（脱敏）
 *
 * ## 为什么用白名单而不是黑名单
 *
 * 「排除 UUID / 口令 / Token」这种写法，在**新增字段的那一天就漏了**：
 * 谁也不会记得回来补一行排除。所以这里反过来 —— 只有显式列进 `EXPORTABLE`
 * 的字段才会被导出，新增字段默认不导出，漏的代价从「泄露」变成「没带上」。
 *
 * ## 为什么要给 omitted 说明
 *
 * 用户导出后换账号导入，如果某些字段悄悄没带过去，他会在几天后才发现
 * 「怎么连不上了」。所以导出的同时返回「哪些字段没导出、为什么」，
 * 面板直接展示，让用户在**导出那一刻**就知道要手工补什么。
 */
import type { UserConfig } from './types'

/** 导出格式版本：将来字段结构变化时用它做迁移 */
export const EXPORT_SCHEMA_VERSION = 1

/**
 * 可导出字段（白名单）。
 *
 * 刻意**不包含**：
 * - `uuid` / `trojanPassword`：凭据，导出去等于把节点送人；
 * - `wsPath` / `trojanPath` / `xhttpPath` / `subDomain`：实例标识，泄露即暴露入口；
 * - `addApi` / `addCsv`：URL 里可能带私有 token；
 * - `socks5` / `httpProxy`：可能含 `user:pass@`（见 buildConfigExport 的条件导出）。
 */
const EXPORTABLE: ReadonlyArray<keyof UserConfig> = [
  'poolOfficial',
  'officialCount',
  'poolDomain',
  'domainCount',
  'poolManual',
  'poolCountries',
  'add',
  'dls',
  'maxLatency',
  'maxNodes',
  'proxyIp',
  'relayPool',
  'useBuiltinRelay',
  'proxyMode',
  'nat64',
  'concurrentDial',
  'dataBudgetMB',
  'resolvePreferred',
  'enableTrojan',
  'enableXhttp',
  'subProtocol',
  'subTransport',
  'subVariants',
  'subName',
  'subPorts',
  'clientFingerprint',
  'ech',
  'echHost',
  'echDns',
  'tlsFragment',
  'tlsFragmentSize',
  'tlsFragmentDelay',
  'subToken',
  'subTokenTtlDays',
  'unlockProbe',
  'udpDns',
  'udpDnsEndpoint',
]

/** 永远不导出的字段（用于生成 omitted 说明） */
const NEVER_EXPORT: ReadonlyArray<{ field: keyof UserConfig; reason: string }> = [
  { field: 'uuid', reason: '入站凭据' },
  { field: 'trojanPassword', reason: '入站凭据' },
  { field: 'wsPath', reason: '实例标识（订阅链接里可见，导出即暴露入口）' },
  { field: 'trojanPath', reason: '实例标识' },
  { field: 'xhttpPath', reason: '实例标识' },
  { field: 'subDomain', reason: '实例标识' },
  { field: 'addApi', reason: 'URL 可能含私有 token' },
  { field: 'addCsv', reason: 'URL 可能含私有 token' },
]

export interface ConfigExport {
  schemaVersion: number
  exportedAt: string
  config: Record<string, unknown>
  omitted: Array<{ field: string; reason: string }>
}

/** 构造导出包 */
export function buildConfigExport(config: UserConfig, now: number = Date.now()): ConfigExport {
  const out: Record<string, unknown> = {}
  for (const key of EXPORTABLE) {
    const value = config[key]
    if (value === undefined) continue
    out[key] = value
  }

  const omitted = NEVER_EXPORT.map((item) => ({ field: item.field, reason: item.reason }))

  // 落地代理里可能带 `user:pass@`：有凭据就整体不导出，避免把 VPS 口令送出去
  for (const key of ['socks5', 'httpProxy'] as const) {
    const value = String(config[key] ?? '')
    if (!value) {
      out[key] = ''
      continue
    }
    if (value.includes('@')) {
      omitted.push({ field: key, reason: '含用户名/口令，需手工重新填写' })
      continue
    }
    out[key] = value
  }

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    config: out,
    omitted,
  }
}

/** 导入时只接受白名单内的字段 */
export function pickImportable(incoming: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set<string>([
    ...EXPORTABLE.map(String),
    // 这两项在白名单里但属于条件导出，导入时允许出现
    'socks5',
    'httpProxy',
  ])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (allowed.has(key)) out[key] = value
  }
  return out
}

export interface ConfigDiffItem {
  field: string
  from: string
  to: string
}

/** 值太长时截断，避免面板被一整段配置撑爆 */
function brief(value: unknown): string {
  if (value === undefined || value === null) return '（空）'
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim()
    return text.length > 60 ? `${text.slice(0, 60)}…` : text || '（空）'
  }
  return String(value)
}

/**
 * 比对「当前配置」与「待导入配置」，只返回**真正会变**的字段。
 *
 * 导入必须让用户先看到差异：直接从别人那里拿一份配置覆盖，
 * 会静默改掉节点来源、代理模式这些不显眼但影响很大的项。
 */
export function diffConfig(current: UserConfig, incoming: Record<string, unknown>): ConfigDiffItem[] {
  const diffs: ConfigDiffItem[] = []
  for (const [key, value] of Object.entries(incoming)) {
    const before = (current as unknown as Record<string, unknown>)[key]
    // 统一成字符串比较：数字/布尔在 JSON 里类型一致，但 `0` 与 `'0'` 要算相同
    if (String(before) === String(value)) continue
    diffs.push({ field: key, from: brief(before), to: brief(value) })
  }
  return diffs
}
