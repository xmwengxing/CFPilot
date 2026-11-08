/**
 * Phase 4 · 从本地池分层取样 + 完整优选结果回写。
 *
 * ## 为什么取样要分层
 *
 * 池是长期积累的，一个外部清单很可能一次塞进来几百个同 /24 的 IP。
 * 按 `lastSeen` 直接取前 200 个，等于把整轮测速预算全烧在同一个网段、
 * 同一个来源上 —— 这正是 `pickWithDiversity` 在结果侧要解决的问题，
 * 取样侧必须先做一遍，否则结果侧根本没得挑。
 *
 * 分层维度：地址族配额 → /24（v4）或 /48（v6）轮转 → 来源轮转 →
 * 历史成功次数 / 最近发现时间排序。全程确定性，便于回归测试。
 *
 * ## 端口约定
 *
 * 现有 `runScan` 的候选是**纯 IP**（`normalizeCandidateList` 会走 `readIpFile`
 * 丢掉端口），端口由统一的 `--port` 决定。所以取样只取端口等于
 * `--port` 的候选，非该端口的条目直接跳过并在 note 里说明，不静默错配。
 */
import { parseCidr } from '../scan/ip-ranges'
import type { ScanSummary } from '../scan/scan'
import {
  withPool,
  type ExternalCandidate,
  type ExternalPool,
} from './pool'

export const POOL_SAMPLE_LIMIT = 200

export interface PoolSampleOptions {
  limit?: number
  port?: number
  now?: number
  /** 是否允许 lightCheck 尚未跑过的候选（默认 true） */
  includeUnchecked?: boolean
}

export interface PoolSample {
  candidates: string[]
  /** 与 candidates 一一对应的池 key，供结果回写 */
  keys: string[]
  family: 'v4' | 'v6' | 'both'
  counts: { v4: number; v6: number }
  totalEligible: number
  note: string
}

/** IPv4 → /24，IPv6 → /48；解析失败时用地址原文兜底。 */
export function networkBucket(ip: string): string {
  if (ip.includes(':')) {
    const parsed = parseCidr(`${ip}/48`)
    if (parsed && parsed.family === 6) {
      return [112n, 96n, 80n].map((s) => ((parsed.base >> s) & 65535n).toString(16)).join(':')
    }
    return ip
  }
  const parts = ip.split('.')
  return parts.length === 4 ? parts.slice(0, 3).join('.') : ip
}

function eligible(pool: ExternalPool, port: number, includeUnchecked: boolean): ExternalCandidate[] {
  return pool.candidates.filter((c) => {
    if (c.port !== port || c.status === 'disabled' || c.status === 'expired') return false
    if (c.lightCheck === null) return includeUnchecked
    return c.lightCheck.tcpOk && c.lightCheck.tlsOk
  })
}

/** 桶内排序：历史成功多的、最近发现的优先。桶间轮转保证分散度。 */
function roundRobin(items: readonly ExternalCandidate[], quota: number): ExternalCandidate[] {
  const buckets = new Map<string, ExternalCandidate[]>()
  for (const c of items) {
    const key = networkBucket(c.ip)
    const list = buckets.get(key)
    if (list) list.push(c)
    else buckets.set(key, [c])
  }
  for (const list of buckets.values()) {
    list.sort((a, b) =>
      b.successCount - a.successCount || b.lastSeen - a.lastSeen || a.key.localeCompare(b.key)
    )
  }
  // 桶顺序按「首个来源名」稳定，再按桶键排序，保证同一份池每次取样一致
  const keys = [...buckets.keys()].sort()
  const out: ExternalCandidate[] = []
  for (let round = 0; out.length < quota; round++) {
    let progressed = false
    for (const key of keys) {
      if (out.length >= quota) break
      const c = buckets.get(key)![round]
      if (c) {
        out.push(c)
        progressed = true
      }
    }
    if (!progressed) break
  }
  return out
}

/**
 * 从池中分层取样（纯函数，不读写磁盘）。
 *
 * 调用方用 `parsePool(readPoolRaw())` 载入；这里刻意不自己读文件，
 * 免得「只取样」的动作意外触发损坏文件备份之类的副作用。
 */
export function sampleFromPool(pool: ExternalPool, options: PoolSampleOptions = {}): PoolSample {
  const limit = Math.max(1, options.limit ?? POOL_SAMPLE_LIMIT)
  const port = options.port ?? 443
  const candidates = eligible(pool, port, options.includeUnchecked !== false)
  const v4 = candidates.filter((c) => c.ipVersion === 4)
  const v6 = candidates.filter((c) => c.ipVersion === 6)

  let v4Quota = Math.ceil(limit / 2)
  let v6Quota = limit - v4Quota
  // 一族不够时把配额让给另一族，不浪费预算
  if (v4.length < v4Quota) {
    v6Quota += v4Quota - v4.length
    v4Quota = v4.length
  }
  if (v6.length < v6Quota) {
    v4Quota += v6Quota - v6.length
    v6Quota = v6.length
  }
  const picked = [
    ...roundRobin(v4, v4Quota),
    ...roundRobin(v6, v6Quota),
  ].slice(0, limit)

  return {
    candidates: picked.map((c) => c.ip),
    keys: picked.map((c) => c.key),
    family: v4.length > 0 && v6.length > 0 ? 'both' : v6.length > 0 ? 'v6' : 'v4',
    counts: {
      v4: picked.filter((c) => c.ipVersion === 4).length,
      v6: picked.filter((c) => c.ipVersion === 6).length,
    },
    totalEligible: candidates.length,
    note: `本地池分层取样：端口 ${port}，可取样 ${candidates.length} 条（v4 ${v4.length} / v6 ${v6.length}），本次取 ${picked.length} 条`,
  }
}

/**
 * 完整优选结束后回写池状态（**只在 --from-pool 时调用**）。
 *
 * - 进 top N 的候选 → `active` + `fullTest` + `successCount++`
 * - 其余被取样但没进 top N 的 → `failed` + `failCount++`（下次仍可重试）
 *
 * 这里不碰 KV：回填仍在 `command.ts` 的既有 `postResults` 路径完成。
 */
export async function applyFullTestResults(
  keys: readonly string[],
  port: number,
  summary: ScanSummary,
  now = Date.now()
): Promise<{ active: number; failed: number }> {
  const winners = new Map<string, { speedMBps: number; colo: string }>()
  for (const entry of summary.entries) {
    const key = entry.ip.includes(':') ? `[${entry.ip}]:${port}` : `${entry.ip}:${port}`
    winners.set(key, {
      speedMBps: entry.peakMBps || entry.speed,
      colo: entry.colo,
    })
  }
  let active = 0
  let failed = 0
  await withPool((pool) => {
    for (const key of keys) {
      const c = pool.candidates.find((x) => x.key === key)
      if (!c || c.status === 'disabled') continue
      const win = winners.get(key)
      if (win) {
        c.status = 'active'
        c.fullTest = { at: now, wsOk: true, speedMBps: win.speedMBps, colo: win.colo }
        c.successCount += 1
        active++
      } else {
        c.status = 'failed'
        c.fullTest = { at: now, wsOk: false, speedMBps: null, colo: null }
        c.failCount += 1
        failed++
      }
    }
    pool.updatedAt = now
  })
  return { active, failed }
}
