/**
 * 外部 IP 候选池（CLI / 桌面版共用一份本地文件）。
 *
 * ## 为什么是本地池，不是 KV
 *
 * KV 的 `LOCAL_PREFERRED_IPS` 是**订阅下发池**：`sub-engine.ts` 里 `maxNodes` 默认 0，
 * 每一行都会变成一个节点；`/preferred-ips` 的 append 还没有条数上限。
 * 外部发现的原始候选如果写进 KV，会直接把订阅撑爆，而且跳过了完整优选测速。
 *
 * 本模块只负责「发现 + 轻量校验」的**入口 IP 候选**：
 * 长期积累在磁盘上，用户主动跑完整优选时才从池中取样，测速通过的少量精选
 * 才经现有 `/preferred-ips` 回填。Worker 控制面因此零改动。
 *
 * ## 共用契约（E2）
 *
 * 路径固定为 `<configDir>/external-candidates.json`，CLI 与 Go 桌面版读写同一份、
 * 同一 schema、同一 lockfile 语义。两端都认 `CFPILOT_CONFIG_DIR` 覆盖（测试隔离用）。
 * ⚠️ Go 桌面版其它配置在 `~/.cfpilot-gui`，这个池刻意放在 CLI 的 `~/.cfpilot`，
 * 是跨版本共用的结果，不是路径写错。
 *
 * ## 不做的事
 *
 * 不解析外部清单（Phase 2 复用 `readIpFile`）、不做 TCP/TLS 校验（Phase 3）、
 * 不触发完整优选或回填（Phase 4）。本层只管持久化、去重、来源关联与状态。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BUILTIN_IPV4_CIDRS,
  BUILTIN_IPV6_CIDRS,
  parseCidr,
  type ParsedCidr,
} from '../scan/ip-ranges'

export const POOL_SCHEMA = 1
export const POOL_FILENAME = 'external-candidates.json'
/** 只允许入口 IP 候选；ProxyIP / NAT64 / Relay 必须独立管理，不能混进来 */
export const ENTRY_IP = 'entry_ip' as const

export type CandidateStatus = 'pending' | 'active' | 'failed' | 'disabled' | 'expired'
export type CandidateType = typeof ENTRY_IP

export interface LightCheck {
  tcpOk: boolean
  tlsOk: boolean
  tlsMs?: number
  at: number
}

export interface FullTest {
  at: number | null
  wsOk: boolean | null
  speedMBps: number | null
  colo: string | null
}

export interface ExternalCandidate {
  key: string
  ip: string
  port: number
  /** 4 = IPv4，6 = IPv6，0 = 域名（域名不是 IP，是否落在 CF 段由后续探测决定） */
  ipVersion: 0 | 4 | 6
  candidateType: CandidateType
  /** 同一 IP 可以来自多个数据源，合并时只增不删 */
  sources: string[]
  firstSeen: number
  lastSeen: number
  lightCheck: LightCheck | null
  fullTest: FullTest | null
  status: CandidateStatus
  failCount: number
  successCount: number
}

export interface ExternalPool {
  schema: number
  updatedAt: number
  candidates: ExternalCandidate[]
}

export interface CandidateInput {
  ip: string
  port?: number
  source: string
  /** 允许显式传入异类型以便校验拒绝；缺省视为 entry_ip */
  candidateType?: string
  lightCheck?: LightCheck | null
}

export interface UpsertResult {
  added: number
  updated: number
  rejected: number
  reasons: Record<string, number>
}

/** 30 天没有被任何来源重新发现 → 标记 expired（不物理删除） */
export const POOL_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000
/** 池容量上限，超出按 lastSeen 淘汰最旧的；disabled 不参与淘汰 */
export const POOL_MAX_CANDIDATES = 5000

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 25

// ------------------------------------------------------------------
// 路径
// ------------------------------------------------------------------

/** 配置目录。与 `menu/store.ts` 的 configDir() 保持同一套覆盖规则。 */
export function poolDir(): string {
  const override = process.env.CFPILOT_CONFIG_DIR?.trim()
  return override ? override : join(homedir(), '.cfpilot')
}

export function poolPath(): string {
  return join(poolDir(), POOL_FILENAME)
}

export function poolLockPath(): string {
  return poolPath() + '.lock'
}

// ------------------------------------------------------------------
// 合法性与 CF 段判定（复用扫描器已有的官方段表，不重复造轮子）
// ------------------------------------------------------------------

/**
 * 合法域名：至少两段 label，每段以字母数字开头结尾（中间允许连字符），
 * 只含字母 / 数字 / 连字符 / 点（空白、控制字符、冒号、方括号等一律拒绝）。
 * 域名必含 `.`，不会与 IPv6 字面量混淆。
 *
 * 纯数字点分串一律不算域名：它意图是 IPv4 字面量，若 isIP 没认（段越界），
 * 就是非法 IP，不能伪装成域名入池、让后续探测去连一个不存在的地址。
 */
function isDomainHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  if (/^[\d.]+$/.test(host)) return false
  return labels.every((label) =>
    label.length > 0 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )
}

/**
 * 生成候选唯一键。
 *
 * IPv4 → `ip:port`，IPv6 → `[ip]:port`（避免 IPv6 自带冒号造成歧义），
 * 域名 → `域名:port`。域名与 IPv4 共用 `host:port` 形态，但域名必含 `.`
 * 且至少一段含字母，不会与合法 IP 撞键。
 * 非法 IP / 非法域名 / 非法端口返回 null。
 */
export function normalizeCandidateKey(ip: string, port: number): string | null {
  const clean = ip.trim()
  const family = isIP(clean)
  if (family !== 4 && family !== 6 && !isDomainHost(clean)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return family === 6 ? `[${clean}]:${port}` : `${clean}:${port}`
}

const V4_NETS: ParsedCidr[] = BUILTIN_IPV4_CIDRS.map(parseCidr).filter(
  (v): v is ParsedCidr => v !== null && v.family === 4
)
const V6_NETS: ParsedCidr[] = BUILTIN_IPV6_CIDRS.map(parseCidr).filter(
  (v): v is ParsedCidr => v !== null && v.family === 6
)

/**
 * 判断 IP 是否落在 Cloudflare 官方段内。
 *
 * ⚠️ 口径用扫描器的官方 15 段 + IPv6 聚合段（CLI 与 Go 两表逐项一致），
 * **不含** worker-core `isCloudflareIpv4` 的补充段（DNS / IANA 保留地址）——
 * 那些本来就不该作为入口候选。这里复用 `parseCidr` 把 IP 转成 bigint，
 * 不另写一套地址转换。
 */
export function isCloudflareEntryIp(ip: string): boolean {
  const family = isIP(ip.trim())
  if (family !== 4 && family !== 6) return false
  const bits = family === 4 ? 32 : 128
  // parseCidr 接受 `IP/32` / `IP/128`，返回的 base 就是该 IP 的整数值
  const parsed = parseCidr(`${ip.trim()}/${bits}`)
  if (!parsed || parsed.family !== family) return false
  const allOnes = (1n << BigInt(bits)) - 1n
  const nets = family === 4 ? V4_NETS : V6_NETS
  for (const net of nets) {
    const hostBits = bits - net.prefix
    const mask = (allOnes << BigInt(hostBits)) & allOnes
    if ((parsed.base & mask) === net.base) return true
  }
  return false
}

// ------------------------------------------------------------------
// 读写
// ------------------------------------------------------------------

export function emptyPool(): ExternalPool {
  return { schema: POOL_SCHEMA, updatedAt: 0, candidates: [] }
}

/** 原始文本（文件不存在 = 空串，绝不因为「读」就产生写入） */
export function readPoolRaw(): string {
  try {
    return readFileSync(poolPath(), 'utf8')
  } catch {
    return ''
  }
}

function isValidCandidate(value: unknown): value is ExternalCandidate {
  if (!value || typeof value !== 'object') return false
  const c = value as Partial<ExternalCandidate>
  if (
    typeof c.key !== 'string' || !c.key ||
    typeof c.ip !== 'string' || !c.ip ||
    !Number.isInteger(c.port) || (c.port ?? 0) < 1 || (c.port ?? 0) > 65535 ||
    (c.ipVersion !== 0 && c.ipVersion !== 4 && c.ipVersion !== 6) ||
    c.candidateType !== ENTRY_IP ||
    !Array.isArray(c.sources) || !c.sources.every((s) => typeof s === 'string') ||
    typeof c.firstSeen !== 'number' || !Number.isFinite(c.firstSeen) || c.firstSeen < 0 ||
    typeof c.lastSeen !== 'number' || !Number.isFinite(c.lastSeen) || c.lastSeen < 0 ||
    typeof c.status !== 'string' || !c.status ||
    !isValidOptionalNumber(c.failCount) || !isValidOptionalNumber(c.successCount)
  ) return false
  // 可选字段：null 合法；若是对象，字段类型必须能被 Go 的 struct 解析，
  // 否则两端行为会分叉（Go 会丢整条、TS 却保留）。
  if (c.lightCheck !== null && c.lightCheck !== undefined && !isValidLightCheck(c.lightCheck)) return false
  if (c.fullTest !== null && c.fullTest !== undefined && !isValidFullTest(c.fullTest)) return false
  return true
}

function isValidOptionalNumber(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v))
}

function isValidLightCheck(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const x = v as Partial<LightCheck>
  return (
    typeof x.tcpOk === 'boolean' &&
    typeof x.tlsOk === 'boolean' &&
    typeof x.at === 'number' &&
    (x.tlsMs === undefined || typeof x.tlsMs === 'number')
  )
}

function isValidFullTest(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const x = v as Partial<FullTest>
  return (
    (x.at === null || x.at === undefined || typeof x.at === 'number') &&
    (x.wsOk === null || x.wsOk === undefined || typeof x.wsOk === 'boolean') &&
    (x.speedMBps === null || x.speedMBps === undefined || typeof x.speedMBps === 'number') &&
    (x.colo === null || x.colo === undefined || typeof x.colo === 'string')
  )
}

/**
 * 规范化单条候选：丢弃未知字段、补齐缺省值、**固定字段顺序**。
 *
 * 跨语言契约的关键：Go 侧 json.Unmarshal 天然会丢未知字段并把缺失的
 * 数值字段填 0，然后按 struct 顺序重新编码。若 TS 这里直接沿用
 * `JSON.parse` 出来的原对象，未知字段会被原样保留、字段顺序也可能不同，
 * 于是「Go 写的池 → TS 读一遍再存」就会莫名其妙改文件内容。
 */
function normalizeCandidate(value: unknown): ExternalCandidate | null {
  if (!isValidCandidate(value)) return null
  const c = value as ExternalCandidate
  const lightCheck: LightCheck | null = c.lightCheck
    ? {
        tcpOk: c.lightCheck.tcpOk,
        tlsOk: c.lightCheck.tlsOk,
        // tlsMs 是可选字段：位置必须排在 at 之前，与 Go struct 一致
        ...(typeof c.lightCheck.tlsMs === 'number' ? { tlsMs: c.lightCheck.tlsMs } : {}),
        at: c.lightCheck.at,
      }
    : null
  const fullTest: FullTest | null = c.fullTest
    ? {
        at: typeof c.fullTest.at === 'number' ? c.fullTest.at : null,
        wsOk: typeof c.fullTest.wsOk === 'boolean' ? c.fullTest.wsOk : null,
        speedMBps: typeof c.fullTest.speedMBps === 'number' ? c.fullTest.speedMBps : null,
        colo: typeof c.fullTest.colo === 'string' ? c.fullTest.colo : null,
      }
    : null
  return {
    key: c.key,
    ip: c.ip,
    port: c.port,
    ipVersion: c.ipVersion,
    candidateType: ENTRY_IP,
    sources: [...c.sources],
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
    lightCheck,
    fullTest,
    status: c.status,
    failCount: c.failCount ?? 0,
    successCount: c.successCount ?? 0,
  }
}

/** 解析池文本；损坏时保留备份并返回空池（下次真正写入时才落盘） */
export function parsePool(raw: string): ExternalPool {
  if (!raw.trim()) return emptyPool()
  try {
    const obj = JSON.parse(raw) as Partial<ExternalPool>
    if (obj.schema !== POOL_SCHEMA) throw new Error(`schema ${String(obj.schema)} 不兼容`)
    const list = Array.isArray(obj.candidates) ? obj.candidates : []
    return {
      schema: POOL_SCHEMA,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
      // candidateType 隔离：异类型 / 结构损坏的条目直接丢弃，不进池
      candidates: list
        .map(normalizeCandidate)
        .filter((c): c is ExternalCandidate => c !== null),
    }
  } catch {
    const backup = `${poolPath()}.corrupt-${Date.now()}`
    try {
      if (existsSync(poolPath())) renameSync(poolPath(), backup)
    } catch {
      /* 备份失败不阻断：返回空池即可 */
    }
    return emptyPool()
  }
}

export function serializePool(pool: ExternalPool): string {
  return `${JSON.stringify(pool, null, 2)}\n`
}

/** 原子写：同目录临时文件 + rename，避免写一半损坏 */
export function writePoolAtomic(text: string): void {
  const dir = poolDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${POOL_FILENAME}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, poolPath())
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 已清理 */
    }
    throw err
  }
}

// ------------------------------------------------------------------
// 跨语言文件锁（Go 侧用 O_EXCL 实现同一语义）
// ------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 抢锁；锁文件超过 30s 视为陈旧可清理，总等待 5s 后报错 */
export async function acquirePoolLock(): Promise<void> {
  mkdirSync(poolDir(), { recursive: true, mode: 0o700 })
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(poolLockPath(), 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      try {
        const st = statSync(poolLockPath())
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(poolLockPath())
          continue
        }
      } catch {
        // 锁刚好被对方释放，下一轮重抢
        continue
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error('本地候选池正被另一个进程占用（锁超时）')
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
}

export function releasePoolLock(): void {
  try {
    unlinkSync(poolLockPath())
  } catch {
    /* 已释放 */
  }
}

/**
 * `~/.cfpilot` 共享目录的**全局锁**。
 *
 * Phase 2 起这个目录下不止池一个文件：还有数据源配置与采集记录。
 * 它们全部复用同一把 `external-candidates.json.lock`：
 *   1. CLI 与 Go 两端只需维护一套 O_EXCL 锁语义；
 *   2. 绝不会出现「A 持池锁等配置锁、B 持配置锁等池锁」的交叉死锁；
 *   3. 一次同步里「读配置 → 拉清单 → 写池 → 写记录」天然是原子的。
 * 代价是配置写入也要等池操作，但这些操作都是毫秒级的本地磁盘 I/O。
 */
export async function withConfigDirLock<T>(fn: () => T | Promise<T>): Promise<T> {
  await acquirePoolLock()
  try {
    return await fn()
  } finally {
    releasePoolLock()
  }
}

/**
 * 读-改-写的唯一入口：持锁加载 → 回调修改 → 内容有变化才原子落盘。
 *
 * 「内容未变不写」既是省 I/O，也避免两个进程交替刷新 updatedAt 造成无意义写。
 */
export async function withPool<T>(fn: (pool: ExternalPool) => T | Promise<T>): Promise<T> {
  return withConfigDirLock(async () => {
    const before = readPoolRaw()
    const pool = parsePool(before)
    const result = await fn(pool)
    const after = serializePool(pool)
    if (after !== before) writePoolAtomic(after)
    return result
  })
}

// ------------------------------------------------------------------
// 合并、状态与淘汰
// ------------------------------------------------------------------

function bumpReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1
}

/**
 * 把一批新发现的候选并入池。
 *
 * 状态规则（对齐任务书 8.3）：
 * - 新增 → pending；`active` 只能由 Phase 4 的完整优选写入，本层不自动置 active
 * - 已存在 → 合并 sources、刷新 lastSeen；`disabled` 不被刷新覆盖
 * - `expired` / `failed` 被重新发现 → 回到 pending，允许再次验证
 */
export function upsertCandidates(
  pool: ExternalPool,
  inputs: readonly CandidateInput[],
  now = Date.now(),
  maxCandidates = POOL_MAX_CANDIDATES
): UpsertResult {
  const byKey = new Map<string, ExternalCandidate>()
  for (const c of pool.candidates) byKey.set(c.key, c)
  const result: UpsertResult = { added: 0, updated: 0, rejected: 0, reasons: {} }

  for (const input of inputs) {
    const port = input.port ?? 443
    if (input.candidateType !== undefined && input.candidateType !== ENTRY_IP) {
      result.rejected++
      bumpReason(result.reasons, 'candidateType')
      continue
    }
    const key = normalizeCandidateKey(input.ip, port)
    if (!key) {
      result.rejected++
      bumpReason(result.reasons, 'invalidIp')
      continue
    }
    const clean = input.ip.trim()
    const family = isIP(clean)
    const domain = family === 0 && isDomainHost(clean)
    // 域名不是 IP：跳过官方段校验，是否可达由后续探测决定；IP 必须落在官方段内
    if (!domain && !isCloudflareEntryIp(clean)) {
      result.rejected++
      bumpReason(result.reasons, 'notCloudflare')
      continue
    }
    const ipVersion: 0 | 4 | 6 = domain ? 0 : (family === 6 ? 6 : 4)
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.sources.includes(input.source)) existing.sources.push(input.source)
      existing.lastSeen = now
      if (existing.status === 'disabled') {
        // 用户手动禁用，自动刷新不能覆盖
      } else if (existing.status === 'expired' || existing.status === 'failed') {
        existing.status = 'pending'
      }
      if (input.lightCheck) existing.lightCheck = input.lightCheck
      result.updated++
      continue
    }
    const created: ExternalCandidate = {
      key,
      ip: clean,
      port,
      ipVersion,
      candidateType: ENTRY_IP,
      sources: [input.source],
      firstSeen: now,
      lastSeen: now,
      lightCheck: input.lightCheck ?? null,
      fullTest: null,
      status: 'pending',
      failCount: 0,
      successCount: 0,
    }
    byKey.set(key, created)
    pool.candidates.push(created)
    result.added++
  }

  // 过期只标记、不物理删除；disabled 不参与
  for (const c of pool.candidates) {
    if (c.status !== 'disabled' && now - c.lastSeen > POOL_EXPIRE_MS) c.status = 'expired'
  }

  // 容量淘汰：按 lastSeen 从旧到新删，disabled 保留
  if (pool.candidates.length > maxCandidates) {
    const disposable = pool.candidates
      .filter((c) => c.status !== 'disabled')
      .sort((a, b) => a.lastSeen - b.lastSeen)
    const overflow = pool.candidates.length - maxCandidates
    const drop = new Set(disposable.slice(0, overflow).map((c) => c.key))
    if (drop.size > 0) {
      pool.candidates = pool.candidates.filter((c) => !drop.has(c.key))
      bumpReason(result.reasons, 'evicted')
    }
  }

  pool.updatedAt = now
  return result
}
