/**
 * `cfpilot source` 子命令：外部 IP 数据源的增删查、测试连接与手动同步。
 *
 * 设计成完全非交互，供系统计划任务（`source sync`）直接调用；
 * 桌面版提供同一份配置的可视化管理（Phase 5），两端读写同一个文件。
 */
import { flagBool, flagList, flagNumber, flagString, type ParsedArgs } from '../shared/args'
import {
  loadSources,
  makeSource,
  parseSources,
  readSourcesRaw,
  serializeSources,
  writeSourcesAtomic,
  type SourceConfig,
  type SourceType,
  type SourcesFile,
} from './config'
import { SOURCE_TIMEOUT_MS, sanitizeUrl, validateSourceUrl } from './fetch'
import { PROVIDERS, type ProviderId } from './providers'
import { syncSources, testSource, type SyncOptions, type SyncReport } from './manager'
import {
  parsePool,
  readPoolRaw,
  serializePool,
  withConfigDirLock,
  writePoolAtomic,
} from './pool'

const HELP = `
cfpilot source <动作> [选项]      外部 IP 数据源管理（本地池，不写 KV）

动作:
  list                        列出数据源与最近采集记录
  add <id>                    新增数据源（默认启用）
  remove <id>                 删除数据源并清理来源关联
  test <id>                   测试连接（只拉不写池）
  sync [id...]                同步到 ~/.cfpilot/external-candidates.json

来源类型（--type）:
  github-raw / custom-url     GET 一份清单文本（需 --url）
  ripe-stat                   RIPEstat AS 宣告前缀，零 Key（默认 AS13335）

选项:
  --type <类型>                    来源类型（默认 custom-url）
  --url <链接>                    清单 URL（list 型必填，API 型不用）
  --query <串>                    API 型查询：ripe-stat 用 ASN（缺省 AS13335）
  --max-results <n>               API 型单次最多入池候选（默认 200）
  --name <名称>                    显示名称（默认同 id）
  --mirror <链接>                  镜像 URL，可重复（仅 list 型）
  --interval-hours <小时>           建议同步间隔
  --disabled                       新增后保持禁用
  --allow-http                     允许 http（仅本地自建测试源，生产请用 HTTPS）
  --timeout-ms <毫秒>              单源超时（默认 ${SOURCE_TIMEOUT_MS}）
  --light                          同步后对新增候选做 TCP/TLS 轻量校验
  --json                          以 JSON 输出
  -h, --help                       显示本帮助

示例:
  cfpilot source add ripe --type ripe-stat --query AS13335 --max-results 200
  cfpilot source sync ripe --json

⚠️ 同步只写本地磁盘：不触发 WS 校验、不测速、不回填订阅。
   要更新订阅请用 cfpilot scan --from-pool（完整优选 + 回填）。
`

function out(text: string): void {
  process.stdout.write(`${text}\n`)
}

function fail(text: string): never {
  process.stderr.write(`✗ ${text}\n`)
  process.exit(1)
}

function parseType(raw: string): SourceType {
  if (raw === 'github-raw' || raw === 'custom-url' || raw === 'ripe-stat') return raw
  return fail(`--type 只接受 github-raw / custom-url / ripe-stat，收到「${raw}」`)
}

function isApiType(type: SourceType): type is ProviderId {
  return type === 'ripe-stat'
}

function printList(file: SourcesFile, asJson: boolean): void {
  if (asJson) {
    out(JSON.stringify(file, null, 2))
    return
  }
  if (file.sources.length === 0) {
    out('还没有数据源。用 `cfpilot source add <id> --url <链接>` 添加。')
    return
  }
  out('外部 IP 数据源：')
  for (const s of file.sources) {
    const status = s.enabled ? '启用' : '禁用'
    const last = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '从未'
    out(`  [${status}] ${s.id}  ${s.type}  ${sanitizeUrl(s.url)}`)
    out(`         间隔 ${s.intervalHours}h · 上次 ${last} · 失败 ${s.failCount}${s.lastError ? ` · ${s.lastError}` : ''}`)
  }
  if (file.runs.length > 0) {
    out('\n最近采集记录：')
    for (const r of file.runs.slice(-5).reverse()) {
      const tag = r.ok ? (r.notModified ? '未变更' : `+${r.added}/~${r.updated}/×${r.rejected}`) : `失败：${r.error}`
      out(`  ${new Date(r.at).toLocaleString()}  ${r.sourceId}  ${tag}  ${r.durationMs}ms`)
    }
  }
}

function printSync(report: SyncReport, asJson: boolean): void {
  if (asJson) {
    out(JSON.stringify(report, null, 2))
    return
  }
  for (const r of report.outcomes) {
    if (!r.ok) {
      out(`  ✗ ${r.sourceId}：${r.error}`)
    } else if (r.notModified) {
      out(`  = ${r.sourceId}：未变更（304）`)
    } else {
      out(`  ✓ ${r.sourceId}：新增 ${r.added} · 刷新 ${r.updated} · 拒绝 ${r.rejected}`)
    }
  }
  out(`本地候选池现有 ${report.poolCandidates} 条（未写 KV、未回填订阅）`)
}

/** 删除数据源：只删配置与来源关联；仍被其它来源引用 / 用户禁用的候选保留。 */
async function removeSource(id: string): Promise<{ removedCandidates: number; keptCandidates: number }> {
  return withConfigDirLock(async () => {
    const cfgBefore = readSourcesRaw()
    const cfg = parseSources(cfgBefore)
    const before = cfg.sources.length
    cfg.sources = cfg.sources.filter((s) => s.id !== id)
    if (cfg.sources.length === before) throw new Error(`数据源不存在：${id}`)
    cfg.runs = cfg.runs.filter((r) => r.sourceId !== id)
    cfg.updatedAt = Date.now()

    const poolBefore = readPoolRaw()
    const pool = parsePool(poolBefore)
    let removed = 0
    pool.candidates = pool.candidates.filter((c) => {
      if (!c.sources.includes(id)) return true
      c.sources = c.sources.filter((s) => s !== id)
      // 仍被其它来源引用，或用户显式禁用过 → 保留
      if (c.sources.length > 0 || c.status === 'disabled') return true
      removed++
      return false
    })

    const cfgAfter = serializeSources(cfg)
    if (cfgAfter !== cfgBefore) writeSourcesAtomic(cfgAfter)
    const poolAfter = serializePool(pool)
    if (poolAfter !== poolBefore) writePoolAtomic(poolAfter)
    return { removedCandidates: removed, keptCandidates: pool.candidates.length }
  })
}

export async function runSourceCommand(args: ParsedArgs): Promise<void> {
  const action = (args.positionals[0] ?? 'list').toLowerCase()
  const asJson = flagBool(args, 'json')
  if (flagBool(args, 'h') || flagBool(args, 'help') || action === 'help') {
    out(HELP)
    return
  }

  switch (action) {
    case 'list': {
      printList(loadSources(), asJson)
      return
    }

    case 'add': {
      const id = (args.positionals[1] ?? '').trim()
      if (!id) fail('用法：cfpilot source add <id> --type <类型> [--url <链接> | --query <串>]')
      const type = parseType(flagString(args, 'type') || 'custom-url')
      const url = flagString(args, 'url').trim()
      if (!isApiType(type) && !url) fail('list 型数据源缺少 --url')
      if (isApiType(type) && url) fail('API 型数据源不需要 --url，请用 --query')
      if (url) {
        try {
          validateSourceUrl(url)
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      }
      const spec = isApiType(type) ? PROVIDERS[type] : undefined
      const query = flagString(args, 'query').trim() || (spec ? spec.defaultQuery : '')
      if (type === 'ripe-stat' && !/^AS\d{1,10}$/i.test(query)) {
        fail(`ripe-stat 的 --query 必须是 ASN（如 AS13335），收到「${query}」`)
      }
      const source: SourceConfig = makeSource({
        id,
        name: flagString(args, 'name') || id,
        type,
        url,
        mirrors: flagList(args, 'mirror'),
        enabled: !flagBool(args, 'disabled'),
        intervalHours: flagNumber(args, 'interval-hours', 0) || undefined,
        query,
        maxResults: flagNumber(args, 'max-results', spec?.defaultMaxResults ?? 200),
      })
      await withConfigDirLock(async () => {
        const before = readSourcesRaw()
        const file = parseSources(before)
        if (file.sources.some((s) => s.id === id)) fail(`数据源已存在：${id}`)
        file.sources.push(source)
        file.updatedAt = Date.now()
        const after = serializeSources(file)
        if (after !== before) writeSourcesAtomic(after)
      })
      out(asJson ? JSON.stringify(source, null, 2) : `✓ 已添加数据源 ${id}（${source.type}）`)
      return
    }

    case 'remove': {
      const id = (args.positionals[1] ?? '').trim()
      if (!id) fail('用法：cfpilot source remove <id>')
      const r = await removeSource(id)
      out(asJson
        ? JSON.stringify({ id, ...r }, null, 2)
        : `✓ 已删除数据源 ${id}；清理无来源候选 ${r.removedCandidates} 条，池内保留 ${r.keptCandidates} 条`)
      return
    }

    case 'test': {
      const id = (args.positionals[1] ?? '').trim()
      if (!id) fail('用法：cfpilot source test <id>')
      const source = loadSources().sources.find((s) => s.id === id)
      if (!source) fail(`数据源不存在：${id}`)
      // 测试连接不带条件头，否则第二次永远返回 304、看不到实际清单条数
      const probe: SourceConfig = { ...source, etag: '', lastModified: '' }
      const r = await testSource(probe, {
        allowHttp: flagBool(args, 'allow-http'),
        timeoutMs: flagNumber(args, 'timeout-ms', SOURCE_TIMEOUT_MS),
      })
      if (asJson) {
        out(JSON.stringify(r, null, 2))
      } else if (r.ok) {
        out(`✓ ${source.id} 可用：解析出 ${r.added} 条候选（${r.durationMs}ms）\n  来自 ${r.url}`)
      } else {
        out(`✗ ${source.id} 不可用：${r.error}`)
      }
      if (!r.ok) process.exitCode = 1
      return
    }

    case 'sync': {
      const ids = args.positionals.slice(1).filter(Boolean)
      const options: SyncOptions = {
        sourceIds: ids,
        allowHttp: flagBool(args, 'allow-http'),
        timeoutMs: flagNumber(args, 'timeout-ms', SOURCE_TIMEOUT_MS),
      }
      // Phase 3 的 --light：注入轻量校验钩子，锁外执行
      if (flagBool(args, 'light')) {
        const { lightCheckCandidates } = await import('./light')
        options.lightCheck = lightCheckCandidates
      }
      const report = await syncSources(options)
      printSync(report, asJson)
      if (report.outcomes.some((r) => !r.ok)) process.exitCode = 1
      return
    }

    default:
      fail(`未知动作：${action}\n${HELP}`)
  }
}
