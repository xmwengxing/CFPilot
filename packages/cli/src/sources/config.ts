/**
 * 外部 IP 数据源配置（CLI / 桌面版共用一份本地文件）。
 *
 * 与 `external-candidates.json` 同目录、同一把目录锁：
 * 一次「读配置 → 拉清单 → 写池 → 写采集记录」是原子的，且两端看到的完全一致。
 *
 * ## 序列化契约
 *
 * 与池文件一样：2 空格缩进、结尾换行、字段顺序固定。Go 侧
 * `internal/scan/sources.go` 的 struct 字段顺序必须与这里的 interface 一致，
 * 否则「内容未变不写」会在两端来回刷新时失效。
 *
 * ## 配置文件不存在时才播种内置清单
 *
 * 首次使用（配置文件不存在 / 为空）时，用随版本内置的来源清单播种，
 * 让用户一进来就有可挑选的源。播种只发生在这一步：保存过一次之后
 * 一律以用户文件为准，因此用户删掉的内置条目不会被回灌。
 * 内置条目默认停用（外部链接会失效），需用户显式启用；`github-raw`
 * 类型的源会自动获得镜像回退。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BUILTIN_SOURCES_JSON } from './builtin.generated'
import {
  poolDir,
  poolLockPath,
  withConfigDirLock,
} from './pool'

/** schema 2：新增 API 型数据源（query / maxResults）；v1 文件自动迁移，不备份丢弃。 */
export const SOURCES_SCHEMA = 2
export const SOURCES_SCHEMA_V1 = 1
export const SOURCES_FILENAME = 'external-sources.json'
/** 采集记录保留条数，避免配置文件无限膨胀 */
export const MAX_SYNC_RUNS = 50

/** list = GET 一份清单文本；api = 走 Provider 适配器。当前只注册 ripe-stat。 */
export type SourceType = 'github-raw' | 'custom-url' | 'ripe-stat'

/** 字段顺序即落盘顺序，勿调整（新字段一律追加在末尾，保证 v1 → v2 只做补齐）。 */
export interface SourceConfig {
  id: string
  name: string
  type: SourceType
  url: string
  mirrors: string[]
  enabled: boolean
  intervalHours: number
  etag: string
  lastModified: string
  lastSyncAt: number
  lastError: string
  failCount: number
  /** API 源的查询串：RIPEstat 用 ASN（如 AS13335） */
  query: string
  /** 单次同步最多入池的候选数 */
  maxResults: number
}

/** 一次采集的结果，供桌面版「采集记录」表格展示。 */
export interface SyncRun {
  at: number
  sourceId: string
  ok: boolean
  added: number
  updated: number
  rejected: number
  error: string
  durationMs: number
  notModified: boolean
}

export interface SourcesFile {
  schema: number
  updatedAt: number
  sources: SourceConfig[]
  runs: SyncRun[]
}

export function sourcesPath(): string {
  return join(poolDir(), SOURCES_FILENAME)
}

/** 目录锁路径（与池共用，见 pool.ts 的 withConfigDirLock 注释）。 */
export function sourcesLockPath(): string {
  return poolLockPath()
}

/**
 * 配置文件不存在 / 为空时的初始内容：播种随版本内置的来源清单。
 *
 * 只在「没有用户文件」这一步生效。写盘之后 `parseSources` 一律以用户文件
 * 为准（正常路径返回文件里的 sources，损坏降级见 `blankSources`），
 * 所以用户删掉的内置条目不会再被补回来。
 */
export function emptySources(): SourcesFile {
  return {
    schema: SOURCES_SCHEMA,
    updatedAt: 0,
    sources: JSON.parse(BUILTIN_SOURCES_JSON) as SourceConfig[],
    runs: [],
  }
}

/** 损坏 / 不兼容 schema 降级用的真正空配置，绝不播种（避免回灌用户删掉的条目）。 */
function blankSources(): SourcesFile {
  return { schema: SOURCES_SCHEMA, updatedAt: 0, sources: [], runs: [] }
}

export function readSourcesRaw(): string {
  try {
    return readFileSync(sourcesPath(), 'utf8')
  } catch {
    return ''
  }
}

const SOURCE_TYPES: readonly SourceType[] = ['github-raw', 'custom-url', 'ripe-stat']

/**
 * v1 条目没有 query / maxResults，迁移时由 normalizeSource 补齐，
 * 所以这里对这两个字段宽松；其余字段仍然严格。
 */
function validSource(v: unknown): v is SourceConfig {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<SourceConfig>
  return (
    typeof s.id === 'string' && s.id.length > 0 &&
    typeof s.name === 'string' &&
    SOURCE_TYPES.includes(s.type as SourceType) &&
    typeof s.url === 'string' &&
    Array.isArray(s.mirrors) && s.mirrors.every((m) => typeof m === 'string') &&
    typeof s.enabled === 'boolean' &&
    typeof s.intervalHours === 'number' &&
    typeof s.etag === 'string' &&
    typeof s.lastModified === 'string' &&
    typeof s.lastSyncAt === 'number' &&
    typeof s.lastError === 'string' &&
    typeof s.failCount === 'number'
  )
}

function validRun(v: unknown): v is SyncRun {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<SyncRun>
  return (
    typeof r.at === 'number' &&
    typeof r.sourceId === 'string' &&
    typeof r.ok === 'boolean' &&
    typeof r.added === 'number' &&
    typeof r.updated === 'number' &&
    typeof r.rejected === 'number' &&
    typeof r.error === 'string' &&
    typeof r.durationMs === 'number' &&
    typeof r.notModified === 'boolean'
  )
}

/** 规范化：丢未知字段、固定字段顺序、补齐 v1 缺字段，与 Go struct 编码逐字节对齐。 */
export function normalizeSource(v: SourceConfig): SourceConfig {
  return {
    id: v.id,
    name: v.name,
    type: v.type,
    url: v.url,
    mirrors: [...v.mirrors],
    enabled: v.enabled,
    intervalHours: v.intervalHours,
    etag: v.etag,
    lastModified: v.lastModified,
    lastSyncAt: v.lastSyncAt,
    lastError: v.lastError,
    failCount: v.failCount,
    query: typeof v.query === 'string' ? v.query : '',
    maxResults: typeof v.maxResults === 'number' && v.maxResults > 0 ? v.maxResults : 200,
  }
}

function normalizeRun(v: SyncRun): SyncRun {
  return {
    at: v.at,
    sourceId: v.sourceId,
    ok: v.ok,
    added: v.added,
    updated: v.updated,
    rejected: v.rejected,
    error: v.error,
    durationMs: v.durationMs,
    notModified: v.notModified,
  }
}

/**
 * 解析；空文本（文件不存在 / 为空）→ 播种内置清单；
 * schema 1 自动迁移到 2（只补两个字段，不丢数据），
 * 其它不兼容版本 / JSON 损坏 → 备份 + 真正的空配置（不阻断启动、不回灌）。
 */
export function parseSources(raw: string): SourcesFile {
  if (!raw.trim()) return emptySources()
  try {
    const obj = JSON.parse(raw) as Partial<SourcesFile>
    if (obj.schema !== SOURCES_SCHEMA && obj.schema !== SOURCES_SCHEMA_V1) {
      throw new Error(`schema ${String(obj.schema)} 不兼容`)
    }
    return {
      schema: SOURCES_SCHEMA,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
      sources: (Array.isArray(obj.sources) ? obj.sources : [])
        .filter(validSource)
        .map(normalizeSource),
      runs: (Array.isArray(obj.runs) ? obj.runs : [])
        .filter(validRun)
        .map(normalizeRun)
        .slice(-MAX_SYNC_RUNS),
    }
  } catch {
    const backup = `${sourcesPath()}.corrupt-${Date.now()}`
    try {
      if (existsSync(sourcesPath())) renameSync(sourcesPath(), backup)
    } catch {
      /* 备份失败不阻断 */
    }
    return blankSources()
  }
}

export function serializeSources(file: SourcesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export function writeSourcesAtomic(text: string): void {
  const dir = poolDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${SOURCES_FILENAME}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, sourcesPath())
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件已清理 */
    }
    throw err
  }
}

/**
 * 配置读改写的唯一入口。与 `withPool` 共用目录锁，内容未变不写。
 *
 * 一次同步通常同时改池和配置，用同一个 `withConfigDirLock` 包住两者即可：
 * 不要在两个独立的 withXxx 回调里分别改，否则中间会被别的进程插进来。
 */
export async function withSources<T>(fn: (file: SourcesFile) => T | Promise<T>): Promise<T> {
  return withConfigDirLock(async () => {
    const before = readSourcesRaw()
    const file = parseSources(before)
    const result = await fn(file)
    const after = serializeSources(file)
    if (after !== before) writeSourcesAtomic(after)
    return result
  })
}

/** 纯读，不产生任何文件。 */
export function loadSources(): SourcesFile {
  return parseSources(readSourcesRaw())
}

/** 生成合法的新数据源对象（不落盘）。 */
export function makeSource(input: {
  id: string
  name?: string
  type: SourceType
  /** API 型源不需要 url（endpoint 由 Provider 固定），list 型必填 */
  url?: string
  mirrors?: string[]
  enabled?: boolean
  intervalHours?: number
  query?: string
  maxResults?: number
}): SourceConfig {
  return {
    id: input.id,
    name: input.name ?? input.id,
    type: input.type,
    url: input.url ?? '',
    mirrors: input.mirrors ?? [],
    enabled: input.enabled ?? true,
    intervalHours: input.intervalHours ?? (input.type === 'github-raw' ? 12 : 24),
    etag: '',
    lastModified: '',
    lastSyncAt: 0,
    lastError: '',
    failCount: 0,
    query: input.query ?? '',
    maxResults: input.maxResults ?? 200,
  }
}

/** 追加采集记录并保留最近 MAX_SYNC_RUNS 条。 */
export function appendRun(file: SourcesFile, run: SyncRun): void {
  file.runs.push(run)
  if (file.runs.length > MAX_SYNC_RUNS) {
    file.runs = file.runs.slice(-MAX_SYNC_RUNS)
  }
  file.updatedAt = run.at
}
