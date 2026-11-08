/**
 * 采集编排：把一个/多个外部源同步进本地候选池。
 *
 * ## 锁的边界（很重要）
 *
 * 网络请求**一律在目录锁外**做完，再统一进一次 `withConfigDirLock` 提交：
 * 一个 15s 超时的源不能占着锁让桌面版 / 其它 CLI 进程干等。
 * 提交阶段同时改池文件与数据源配置，因此不能嵌套 `withPool` / `withSources`
 * （它们各自会抢同一把锁，嵌套即死锁）—— 这里直接调底层读写函数，一把锁走完。
 *
 * ## 单源失败隔离
 *
 * 任一源超时 / 404 / 解析失败只记进 `lastError` 与采集记录，
 * 绝不清空已有池、也绝不影响其它源。
 */
import {
  appendRun,
  loadSources,
  parseSources,
  readSourcesRaw,
  serializeSources,
  writeSourcesAtomic,
  type SourceConfig,
  type SyncRun,
} from './config'
import {
  fetchSourceText,
  sanitizeUrl,
  type SourceFetchOptions,
  type SourceFetchResult,
} from './fetch'
import { parseSourcePayload, toCandidateInputs } from './normalizer'
import { PROVIDERS, isApiSource, runProvider, type ProviderId } from './providers'
import {
  parsePool,
  readPoolRaw,
  serializePool,
  upsertCandidates,
  withConfigDirLock,
  writePoolAtomic,
  type CandidateInput,
} from './pool'

export type SourceFetcher = (
  source: SourceConfig,
  opts: SourceFetchOptions
) => Promise<SourceFetchResult>

/** Phase 3 注入点：对即将入池的候选做 TCP/TLS 轻量校验并补 `lightCheck`。 */
export type LightCheckHook = (inputs: CandidateInput[]) => Promise<CandidateInput[]>

export interface SyncOptions extends SourceFetchOptions {
  /** 只同步指定 id；不传则同步全部 enabled 的源 */
  sourceIds?: readonly string[]
  now?: number
  /** 测试注入：替换 list 型源的网络拉取 */
  fetcher?: SourceFetcher
  /** 测试注入：替换 Provider（api 型源）的网络层 */
  providerFetch?: typeof fetch
  /** Phase 3 注入：轻量校验（锁外执行） */
  lightCheck?: LightCheckHook
}

export interface SourceSyncOutcome {
  sourceId: string
  ok: boolean
  added: number
  updated: number
  rejected: number
  reasons: Record<string, number>
  notModified: boolean
  error: string
  durationMs: number
  url: string
}

export interface SyncReport {
  at: number
  outcomes: SourceSyncOutcome[]
  /** 提交后池里的候选总数 */
  poolCandidates: number
}

interface Fetched {
  source: SourceConfig
  outcome: SourceSyncOutcome
  inputs: CandidateInput[]
  etag: string
  lastModified: string
}

function failure(source: SourceConfig, error: string, startedAt: number): Fetched {
  return {
    source,
    inputs: [],
    etag: source.etag,
    lastModified: source.lastModified,
    outcome: {
      sourceId: source.id,
      ok: false,
      added: 0,
      updated: 0,
      rejected: 0,
      reasons: {},
      notModified: false,
      error: error.slice(0, 300),
      durationMs: Date.now() - startedAt,
      // API 型源没有 url，别把空串渲染成 <invalid-url>
      url: source.url ? sanitizeUrl(source.url) : '',
    },
  }
}

/**
 * 同步全部（或指定）数据源。
 *
 * 返回每个源各自的结果；本函数**不会因为单个源失败而抛错**，
 * 只有底层目录锁 / 磁盘写入失败才会抛。
 */
export async function syncSources(options: SyncOptions = {}): Promise<SyncReport> {
  const now = options.now ?? Date.now()
  const configured = loadSources()
  const wanted = new Set(options.sourceIds ?? [])
  const targets = configured.sources.filter(
    (s) => s.enabled && (wanted.size === 0 || wanted.has(s.id))
  )

  // ---- 阶段一：拉取（锁外）----
  // list 源保持原来的并发路径；api 源走 Provider 串行节流，
  // 否则按频率限流的上游 API 会被 Promise.all 直接打出 429。
  const fetcher = options.fetcher ?? fetchSourceText
  const fetched: Fetched[] = []
  const listTargets = targets.filter((s) => !isApiSource(s))
  const apiTargets = targets.filter(isApiSource)

  const listResults = await Promise.all(
    listTargets.map(async (source): Promise<Fetched> => {
      const startedAt = Date.now()
      try {
        const res = await fetcher(source, {
          timeoutMs: options.timeoutMs,
          maxBytes: options.maxBytes,
          allowHttp: options.allowHttp,
        })
        const outcome: SourceSyncOutcome = {
          sourceId: source.id,
          ok: true,
          added: 0,
          updated: 0,
          rejected: 0,
          reasons: {},
          notModified: res.notModified,
          error: '',
          durationMs: Date.now() - startedAt,
          url: res.url,
        }
        if (res.notModified) {
          return { source, outcome, inputs: [], etag: res.etag, lastModified: res.lastModified }
        }
        const parsed = parseSourcePayload(res.text)
        let inputs = toCandidateInputs(parsed, source.id)
        if (options.lightCheck && inputs.length > 0) inputs = await options.lightCheck(inputs)
        return { source, outcome, inputs, etag: res.etag, lastModified: res.lastModified }
      } catch (err) {
        return failure(source, err instanceof Error ? err.message : String(err), startedAt)
      }
    })
  )
  fetched.push(...listResults)

  if (apiTargets.length > 0) {
    let lastAt = 0
    let lastType = ''
    for (const source of apiTargets) {
      // 同一 Provider 的两次请求之间按 minIntervalMs 节流（避免触发上游限流）
      const spec = PROVIDERS[source.type as ProviderId]
      if (spec && lastType === source.type) {
        const wait = spec.minIntervalMs - (Date.now() - lastAt)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
      lastType = source.type
      lastAt = Date.now()
      const startedAt = Date.now()
      try {
        const result = await runProvider({
          source,
          timeoutMs: options.timeoutMs,
          maxBytes: options.maxBytes,
          fetchImpl: options.providerFetch,
        })
        let inputs = toCandidateInputs(result.candidates, source.id)
        if (options.lightCheck && inputs.length > 0) inputs = await options.lightCheck(inputs)
        fetched.push({
          source,
          outcome: {
            sourceId: source.id,
            ok: true,
            added: 0,
            updated: 0,
            rejected: 0,
            reasons: {},
            notModified: false,
            error: '',
            durationMs: Date.now() - startedAt,
            // note 已经脱敏（不含 dork / key），可安全展示
            url: result.note,
          },
          inputs,
          etag: '',
          lastModified: '',
        })
      } catch (err) {
        fetched.push(failure(source, err instanceof Error ? err.message : String(err), startedAt))
      }
    }
  }

  // ---- 阶段二：一次持锁，同时提交池 + 配置 + 采集记录 ----
  let poolCandidates = 0
  await withConfigDirLock(async () => {
    const poolBefore = readPoolRaw()
    const pool = parsePool(poolBefore)
    const cfgBefore = readSourcesRaw()
    const cfg = parseSources(cfgBefore)

    for (const item of fetched) {
      const current = cfg.sources.find((s) => s.id === item.source.id)
      const outcome = item.outcome
      if (current) {
        current.lastSyncAt = now
        if (outcome.ok) {
          current.etag = item.etag
          current.lastModified = item.lastModified
          current.failCount = 0
          current.lastError = ''
        } else {
          current.failCount += 1
          current.lastError = outcome.error
        }
      }
      if (outcome.ok && !outcome.notModified && item.inputs.length > 0) {
        const r = upsertCandidates(pool, item.inputs, now)
        outcome.added = r.added
        outcome.updated = r.updated
        outcome.rejected = r.rejected
        outcome.reasons = r.reasons
      }
      const run: SyncRun = {
        at: now,
        sourceId: outcome.sourceId,
        ok: outcome.ok,
        added: outcome.added,
        updated: outcome.updated,
        rejected: outcome.rejected,
        error: outcome.error,
        durationMs: outcome.durationMs,
        notModified: outcome.notModified,
      }
      appendRun(cfg, run)
    }

    const poolAfter = serializePool(pool)
    if (poolAfter !== poolBefore) writePoolAtomic(poolAfter)
    const cfgAfter = serializeSources(cfg)
    if (cfgAfter !== cfgBefore) writeSourcesAtomic(cfgAfter)
    poolCandidates = pool.candidates.length
  })

  return { at: now, outcomes: fetched.map((f) => f.outcome), poolCandidates }
}

/** 测试连接：只拉 + 解析，不写池、不改配置、不记采集记录。 */
export async function testSource(
  source: SourceConfig,
  options: SyncOptions = {}
): Promise<SourceSyncOutcome> {
  const startedAt = Date.now()
  const baseOutcome = (ok: boolean, added: number, url: string, error: string): SourceSyncOutcome => ({
    sourceId: source.id,
    ok,
    added,
    updated: 0,
    rejected: 0,
    reasons: {},
    notModified: false,
    error,
    durationMs: Date.now() - startedAt,
    url,
  })
  // API 型源走 Provider，不能拿空 url 去跑清单拉取
  if (isApiSource(source)) {
    try {
      const result = await runProvider({
        source,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        fetchImpl: options.providerFetch,
      })
      return baseOutcome(true, result.candidates.length, result.note, '')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return baseOutcome(false, 0, '', msg.slice(0, 300))
    }
  }
  const fetcher = options.fetcher ?? fetchSourceText
  try {
    const res = await fetcher(source, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      allowHttp: options.allowHttp,
    })
    const parsed = res.notModified ? [] : parseSourcePayload(res.text)
    return {
      sourceId: source.id,
      ok: true,
      added: parsed.length,
      updated: 0,
      rejected: 0,
      reasons: {},
      notModified: res.notModified,
      error: '',
      durationMs: Date.now() - startedAt,
      url: res.url,
    }
  } catch (err) {
    return {
      sourceId: source.id,
      ok: false,
      added: 0,
      updated: 0,
      rejected: 0,
      reasons: {},
      notModified: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      durationMs: Date.now() - startedAt,
      url: sanitizeUrl(source.url),
    }
  }
}
