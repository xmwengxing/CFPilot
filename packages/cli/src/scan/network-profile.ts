/** 本地网络档案：仅保存网络维度和前缀统计，不保存凭据或完整请求内容。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { parseCidr } from './ip-ranges'

export type FailureClass = 'timeout' | 'refused' | 'unreachable' | 'reset' | 'tls' | 'alpn' | 'dns' | 'http' | 'content' | 'cancelled' | 'unknown'
export interface FailureClassification { kind: FailureClass; status?: number; retryable: boolean; message: string }
export type ProbeStage = 'tcp' | 'tls' | 'ws' | 'speed'
export interface NetworkProfile {
  id: string
  isp: string
  region: string
  access: string
  family: string
  source: string
  confidence: number
  /** Unix 毫秒。识别来源不参与档案身份计算。 */
  updatedAt: number
}
export interface PrefixObservation {
  profileId: string
  prefix: string
  stage: ProbeStage
  attempts: number
  successes: number
  failures: Partial<Record<FailureClass, number>>
  latencyMs?: number
  speedMBps?: number
  updatedAt: number
}
export interface ProfileStoreDocument {
  version: 1
  profiles: Record<string, NetworkProfile>
  observations: Record<string, PrefixObservation>
}
export interface Observation {
  ip: string
  ok: boolean
  /** 未指定时兼容旧调用，记入 TCP；未执行的阶段不记失败。 */
  stage?: ProbeStage
  profileId?: string
  latencyMs?: number
  speedMBps?: number
  error?: string
  failure?: FailureClassification
  at?: number
}
export interface SamplingCandidate { ip: string; score?: number; prefix?: string; staticWeight?: number }
export interface AdaptiveSamplingOptions {
  explorationRate?: number
  limit: number
  random?: () => number
  halfLifeMs?: number
  now?: number
  profileId?: string
  /** 仅在探索预算中重新验证静态零权重网段；默认关闭。 */
  includeZeroWeight?: boolean
}
export type SamplingOptions = AdaptiveSamplingOptions
export const PROFILE_CAPACITY = 32
export const OBSERVATION_CAPACITY = 4096
const MAX_COUNTER = 1_000_000_000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_HALF_LIFE = 7 * 24 * 60 * 60 * 1000
const STAGES: readonly ProbeStage[] = ['tcp', 'tls', 'ws', 'speed']
const FAILURE_CLASSES: readonly FailureClass[] = ['timeout', 'refused', 'unreachable', 'reset', 'tls', 'alpn', 'dns', 'http', 'content', 'cancelled', 'unknown']
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const count = (value: unknown): number => finite(value) ? Math.min(MAX_COUNTER, Math.max(0, value)) : 0
const time = (value: unknown, fallback = 0): number => finite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : fallback
const halfLife = (value: unknown): number => finite(value) && value > 0 ? value : DEFAULT_HALF_LIFE
const decayAt = (from: number, to: number, duration: number): number => 2 ** (-Math.max(0, to - from) / halfLife(duration))
const text = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 128) : ''
const observationKey = (profileId: string, prefix: string, stage: ProbeStage): string => `${profileId}|${prefix}|${stage}`

/** 将探测错误转换为稳定、可序列化的失败分类。 */
export function classifyFailureDetailed(error: unknown, status?: number): FailureClassification {
  const value = String(error ?? '').trim()
  if (status && status >= 400) return { kind: 'http', status, retryable: status >= 500 || status === 408 || status === 429, message: `HTTP ${status}` }
  if (/cancel|abort|取消/i.test(value)) return { kind: 'cancelled', retryable: false, message: '请求取消' }
  if (/timeout|timed out|超时|ETIMEDOUT/i.test(value)) return { kind: 'timeout', retryable: true, message: '连接超时' }
  if (/ECONNREFUSED|connection refused|连接被拒/i.test(value)) return { kind: 'refused', retryable: false, message: '连接被拒' }
  if (/ENETUNREACH|EHOSTUNREACH|unreachable|网络不可达/i.test(value)) return { kind: 'unreachable', retryable: false, message: '网络不可达' }
  if (/ECONNRESET|socket hang up|连接重置/i.test(value)) return { kind: 'reset', retryable: true, message: '连接重置' }
  if (/certificate|CERT_|SELF_SIGNED|证书/i.test(value)) return { kind: 'tls', retryable: false, message: 'TLS 证书失败' }
  if (/ALPN/i.test(value)) return { kind: 'alpn', retryable: false, message: 'ALPN 协商失败' }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|解析失败/i.test(value)) return { kind: 'dns', retryable: true, message: '域名解析失败' }
  if (/PONG|pong|内容校验|响应异常/i.test(value)) return { kind: 'content', retryable: false, message: '内容校验失败' }
  return { kind: 'unknown', retryable: true, message: value || '未知原因' }
}
export function failureLabel(kind: FailureClass): string {
  return ({ timeout: '超时', refused: '连接被拒', unreachable: '网络不可达', reset: '连接重置', tls: '证书问题', alpn: 'ALPN 协商失败', dns: '域名解析失败', http: 'HTTP 状态异常', content: '内容校验不通过', cancelled: '已取消', unknown: '其他' } satisfies Record<FailureClass, string>)[kind]
}

/** 规范化 IPv4 /24、IPv6 /48；域名和无效字面量不进入网络统计。 */
export function networkBucket(ip: string): string {
  const value = ip.trim().replace(/^\[|\]$/g, '')
  const family = isIP(value)
  if (family === 4) return `${value.split('.').slice(0, 3).join('.')}.0/24`
  if (family === 6) {
    const parsed = parseCidr(`${value}/48`)
    if (parsed) return `${[112n, 96n, 80n].map((shift) => ((parsed.base >> shift) & 65535n).toString(16)).join(':')}::/48`
  }
  return ''
}
function canonicalPrefix(value: unknown): string {
  if (typeof value !== 'string') return ''
  const parts = value.split('/')
  if (parts.length !== 2 || !['24', '48'].includes(parts[1]!)) return ''
  const prefix = networkBucket(parts[0]!)
  return prefix.endsWith(`/${parts[1]}`) ? prefix : ''
}
/**
 * 地区归一化。
 *
 * 必须与桌面版（packages/desktop/internal/scan/profile.go 的 NormalizeRegion）
 * **逐字节一致**：档案 ID 由「运营商 + 地区 + 接入方式 + 地址族」哈希得到，
 * 两端算法不同就会算出两个档案 ID，样本无法互相看到。
 *
 * 规则：去空白 → 去结尾行政区后缀 → 单字简称映射成标准名。
 */
export function normalizeRegion(raw: string): string {
  let value = text(raw).replace(/[\u3000\s]+/g, '')
  if (!value) return ''
  for (const suffix of ['特别行政区', '自治区', '省', '市']) {
    if (value.length > suffix.length && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length)
      break
    }
  }
  return REGION_ALIASES[value] ?? value
}

/** 单字简称 → 标准地区名（与桌面版保持一致）。 */
const REGION_ALIASES: Record<string, string> = {
  闽: '福建', 粤: '广东', 京: '北京', 沪: '上海', 津: '天津', 渝: '重庆',
  浙: '浙江', 苏: '江苏', 鲁: '山东', 豫: '河南', 冀: '河北', 湘: '湖南',
  鄂: '湖北', 皖: '安徽', 赣: '江西', 桂: '广西', 云: '云南', 贵: '贵州',
  川: '四川', 晋: '山西', 陕: '陕西', 甘: '甘肃', 青: '青海', 宁: '宁夏',
  新: '新疆', 藏: '西藏', 蒙: '内蒙古', 港: '香港', 澳: '澳门', 台: '台湾',
}

export function normalizeNetworkProfile(input: Partial<NetworkProfile>, now = Date.now()): NetworkProfile {
  const isp = text(input.isp), region = normalizeRegion(text(input.region)), access = text(input.access).toLowerCase(), family = text(input.family).toLowerCase() || 'ipv4'
  const id = createHash('sha256').update(JSON.stringify([isp.toLowerCase(), region.toLowerCase(), access, family])).digest('hex').slice(0, 32)
  return { id, isp, region, access, family, source: text(input.source), confidence: Math.min(1, count(input.confidence)), updatedAt: time(input.updatedAt, time(now)) }
}
export function createNetworkProfile(network: string | Partial<NetworkProfile>, now = Date.now()): ProfileStoreDocument {
  const profile = normalizeNetworkProfile(typeof network === 'string' ? { isp: network.trim() || 'default', source: 'manual' } : network, now)
  return { version: 1, profiles: { [profile.id]: profile }, observations: {} }
}
function selectedProfile(store: ProfileStoreDocument, requested?: string): string | undefined {
  if (requested) return Object.hasOwn(store.profiles, requested) ? requested : undefined
  const ids = Object.keys(store.profiles)
  return ids.length === 1 ? ids[0] : undefined
}
function capStore(store: ProfileStoreDocument): ProfileStoreDocument {
  const profiles = Object.values(store.profiles).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, PROFILE_CAPACITY)
  const ids = new Set(profiles.map((profile) => profile.id))
  const observations = Object.values(store.observations).filter((item) => ids.has(item.profileId))
    .sort((a, b) => b.updatedAt - a.updatedAt || observationKey(a.profileId, a.prefix, a.stage).localeCompare(observationKey(b.profileId, b.prefix, b.stage))).slice(0, OBSERVATION_CAPACITY)
  return { version: 1, profiles: Object.fromEntries(profiles.map((profile) => [profile.id, profile])), observations: Object.fromEntries(observations.map((item) => [observationKey(item.profileId, item.prefix, item.stage), item])) }
}

/** 每条已完成的阶段独立计数；衰减使用真正半衰期且时间永不回退。 */
export function updateNetworkProfile(store: ProfileStoreDocument, observations: readonly Observation[], now = Date.now(), duration = DEFAULT_HALF_LIFE): ProfileStoreDocument {
  const next: ProfileStoreDocument = { version: 1, profiles: { ...store.profiles }, observations: { ...store.observations } }
  for (const item of observations) {
    const profileId = selectedProfile(next, item.profileId), prefix = networkBucket(item.ip), stage = item.stage ?? 'tcp'
    if (!profileId || !prefix || !STAGES.includes(stage) || item.failure?.kind === 'cancelled') continue
    const key = observationKey(profileId, prefix, stage), old = next.observations[key]
    const observedAt = time(item.at, time(now)), at = Math.max(time(now), observedAt, old?.updatedAt ?? 0)
    const decay = old ? decayAt(old.updatedAt, at, duration) : 0
    const evidence = decayAt(observedAt, at, duration)
    const oldSuccesses = (old?.successes ?? 0) * decay
    const failures: Partial<Record<FailureClass, number>> = {}
    for (const kind of FAILURE_CLASSES) if (old?.failures[kind]) failures[kind] = old.failures[kind]! * decay
    const updated: PrefixObservation = { profileId, prefix, stage, attempts: count((old?.attempts ?? 0) * decay + evidence), successes: count(oldSuccesses + (item.ok ? evidence : 0)), failures, updatedAt: at }
    for (const metric of ['latencyMs', 'speedMBps'] as const) {
      const value = item[metric], previous = old?.[metric]
      if (item.ok && finite(value) && value >= 0) updated[metric] = previous !== undefined && oldSuccesses > 0 ? (previous * oldSuccesses + value * evidence) / (oldSuccesses + evidence) : value
      else if (previous !== undefined) updated[metric] = previous
    }
    if (!item.ok) {
      const kind = item.failure?.kind ?? classifyFailureDetailed(item.error).kind
      updated.failures[kind] = count((updated.failures[kind] ?? 0) + evidence)
    }
    next.observations[key] = updated
    next.profiles[profileId] = { ...next.profiles[profileId]!, updatedAt: Math.max(next.profiles[profileId]!.updatedAt, at) }
  }
  return capStore(next)
}

/**
 * 采样内核**不在这里** —— 见 candidates_adaptive.ts 的 adaptivePool
 * （唯一权威实现，桌面版 internal/scan/adaptive_sampling.go 与它一一对应）。
 *
 * 早前这里还有第二套「按分数排序取前 N」的采样逻辑，与内核语义冲突：
 * 同一份档案在两端会得出不同的候选。现在只保留一套实现。
 */

function sanitizeObservation(raw: unknown, profiles: Record<string, NetworkProfile>): PrefixObservation | undefined {
  if (!record(raw)) return undefined
  const profileId = text(raw.profileId), prefix = canonicalPrefix(raw.prefix)
  if (!Object.hasOwn(profiles, profileId) || !prefix || !STAGES.includes(raw.stage as ProbeStage)) return undefined
  const attempts = count(raw.attempts), successes = Math.min(attempts, count(raw.successes)), failures: Partial<Record<FailureClass, number>> = {}
  let remaining = attempts - successes
  if (record(raw.failures)) for (const kind of FAILURE_CLASSES) {
    const value = Math.min(remaining, count(raw.failures[kind]))
    if (value > 0) { failures[kind] = value; remaining -= value }
  }
  const item: PrefixObservation = { profileId, prefix, stage: raw.stage as ProbeStage, attempts, successes, failures, updatedAt: time(raw.updatedAt) }
  for (const metric of ['latencyMs', 'speedMBps'] as const) if (finite(raw[metric]) && raw[metric] >= 0) item[metric] = raw[metric]
  return item
}
function sanitizeStore(raw: Record<string, unknown>): ProfileStoreDocument {
  if (!record(raw.profiles) || !record(raw.observations)) throw new Error('网络档案结构无效')
  const profiles: Record<string, NetworkProfile> = Object.create(null) as Record<string, NetworkProfile>
  for (const [key, value] of Object.entries(raw.profiles)) {
    if (!record(value) || !key || key.length > 128 || text(value.id) !== key) continue
    const profile = normalizeNetworkProfile(value as Partial<NetworkProfile>, 0)
    // 载入时保留持久化 ID，避免跨语言身份标识迁移破坏关联。
    profiles[key] = { ...profile, id: key }
  }
  const observations: Record<string, PrefixObservation> = Object.create(null) as Record<string, PrefixObservation>
  for (const value of Object.values(raw.observations)) {
    const item = sanitizeObservation(value, profiles)
    if (!item) continue
    const key = observationKey(item.profileId, item.prefix, item.stage), previous = observations[key]
    if (!previous || item.updatedAt > previous.updatedAt) observations[key] = item
  }
  return capStore({ version: 1, profiles, observations })
}
/** 旧 CLI 无阶段信息，只有总尝试数可迁移到 TCP，不能据此伪造 TLS/WS 结果。 */
function migrateLegacyCli(raw: Record<string, unknown>): ProfileStoreDocument {
  if (!record(raw.buckets) || typeof raw.networkKey !== 'string') throw new Error('旧网络档案结构无效')
  const store = createNetworkProfile(raw.networkKey, time(raw.updatedAt)), profileId = Object.keys(store.profiles)[0]!
  for (const [key, value] of Object.entries(raw.buckets)) {
    if (!record(value)) continue
    const prefix = key.startsWith('v4:') ? canonicalPrefix(key.slice(3).replace('/24', '.0/24')) : key.startsWith('v6:') ? canonicalPrefix(key.slice(3).replace('/48', '::/48')) : canonicalPrefix(key)
    const attempts = count(value.attempts), successes = Math.min(attempts, count(value.successes))
    const item = sanitizeObservation({ ...value, profileId, prefix, stage: 'tcp', attempts, successes, failures: { unknown: attempts - successes } }, store.profiles)
    if (item) store.observations[observationKey(profileId, prefix, 'tcp')] = item
  }
  return capStore(store)
}
/** 旧阶段聚合档案只拆分实际有计数的阶段，不把未执行的阶段当成失败。 */
function migrateAggregateStore(raw: Record<string, unknown>): ProfileStoreDocument {
  if (!record(raw.profiles) || !record(raw.observations)) throw new Error('旧网络档案结构无效')
  const expanded: Record<string, unknown> = {}
  for (const value of Object.values(raw.observations)) {
    if (!record(value)) continue
    for (const stage of ['tcp', 'tls', 'ws'] as const) {
      const attempts = count(value[`${stage}Attempts`])
      if (!attempts) continue
      const successes = Math.min(attempts, count(value[`${stage}Success`]))
      const item = { profileId: value.profileId, prefix: value.prefix, stage, attempts, successes, failures: { unknown: attempts - successes }, updatedAt: typeof value.lastTestAt === 'string' ? time(Date.parse(value.lastTestAt)) : 0 }
      expanded[`${String(value.profileId)}|${String(value.prefix)}|${stage}`] = item
    }
  }
  return sanitizeStore({ profiles: raw.profiles, observations: expanded })
}
export async function loadNetworkProfile(file: string, networkKey: string): Promise<ProfileStoreDocument> {
  let handle
  try { handle = await open(file, 'r') } catch (error) {
    if (record(error) && error.code === 'ENOENT') return createNetworkProfile(networkKey)
    throw error
  }
  try {
    if ((await handle.stat()).size > MAX_FILE_BYTES) throw new Error('网络档案超出大小限制')
    const raw: unknown = JSON.parse(await handle.readFile('utf8'))
    if (!record(raw)) throw new Error('网络档案格式无效')
    if (raw.version === 1 && record(raw.buckets)) return migrateLegacyCli(raw)
    if (raw.version === undefined && record(raw.profiles) && record(raw.observations)) return migrateAggregateStore(raw)
    if (raw.version !== 1) throw new Error('网络档案版本不兼容')
    return sanitizeStore(raw)
  } finally { await handle.close() }
}
/** 唯一写入格式是版本化 envelope；随机临时文件避免并发保存互相覆盖临时内容。 */
export async function saveNetworkProfile(file: string, store: ProfileStoreDocument): Promise<void> {
  const sanitized = sanitizeStore(store as unknown as Record<string, unknown>)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
}

/**
 * 合并另一个档案库（同一网络环境下两套程序的样本应当互通）。
 *
 * 桌面版把档案存在 `~/.cfpilot-gui/scan-profiles.json`，CLI 存在
 * `~/.cfpilot/network-profiles.json` —— 档案 ID 算法一致，所以样本可以合并。
 * 合并规则：同一「档案 + 前缀 + 阶段」取较新的一条。
 */
export function mergeProfileStores(base: ProfileStoreDocument, extra: ProfileStoreDocument): ProfileStoreDocument {
  const profiles = { ...base.profiles }
  for (const [id, profile] of Object.entries(extra.profiles)) {
    if (!profiles[id]) profiles[id] = profile
  }
  const observations = { ...base.observations }
  for (const [key, item] of Object.entries(extra.observations)) {
    const previous = observations[key]
    if (!previous || item.updatedAt > previous.updatedAt) observations[key] = item
  }
  return capStore({ version: 1, profiles, observations })
}

/** 桌面版的档案库路径（CLI 读它以共享样本）。 */
export function desktopProfileStorePath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (!home) return ''
  return join(home, '.cfpilot-gui', 'scan-profiles.json')
}
