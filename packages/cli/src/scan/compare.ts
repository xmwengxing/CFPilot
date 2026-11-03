/**
 * cfpilot scan compare —— 双栈对照报告。
 *
 * ## 它回答什么问题
 *
 * 「我这条线路上，IPv6 到底值不值得用？」——
 * 这个问题**只能靠同目标、同环境、同参数跑两轮**来回答，
 * 拿 v4 的某次结果跟 v6 的另一次结果比是没意义的（网络时刻在变）。
 *
 * ## 口径
 *
 * - 两轮各自用**相同的 `--sample`** 生成候选（`--family v4` / `--family v6`），
 *   预算相等才有可比性；不是「auto 拆一半」——那样两族样本量差一倍，
 *   通过率会被采样规模污染。
 * - 除地址族外**所有参数完全相同**（路径、超时、并发、测速设置）。
 * - 输出的是**分族各自的**指标，不做混排（AGENTS：不同地址族成绩不能直接比较）。
 *
 * ## 输出
 *
 * 一张对照表 + 一行结论；`--json` 给机器可读的完整数据（含失败分布）。
 */
import {
  flagBool,
  flagList,
  flagNumber,
  flagString,
  type ParsedArgs,
} from '../shared/args'
import { NAME, VERSION } from '../shared/version'
import { SCAN_COMPARE_HELP } from './help'
import { resolveCandidatePlan, type CandidatePlan } from './candidates'
import { normalizeCountryFilter } from './countries'
import { normalizeWsPath } from './command'
import { runScan, type ScanEvent, type ScanSummary } from './scan'
import { DEFAULT_SPEED_URL } from './speed-url'

/** 单侧（一个地址族）的对照数据。 */
interface CompareSide {
  family: 'v4' | 'v6'
  /** 生成的候选数（0 = 该族没有可用网段 / 环境不通） */
  candidates: number
  summary: ScanSummary | null
  /** IPv6 环境预检结论（仅 v6 侧有） */
  ipv6Note: string
  error?: string
}

/** 取中位数；空数组返回 0。 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** 通过率：`n / total`，total 为 0 时返回 0。 */
function rate(n: number, total: number): number {
  return total > 0 ? n / total : 0
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** 机房分布：`SIN×3 LAX×2`（按数量降序，最多 6 个）。 */
function coloBreakdown(entries: ScanSummary['entries']): string {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const colo = e.colo || 'UNK'
    counts.set(colo, (counts.get(colo) ?? 0) + 1)
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (ordered.length === 0) return '—'
  return ordered.map(([colo, n]) => `${colo}×${n}`).join(' ')
}

/** 由两轮结果给出一句结论（只在两轮都有数据时给）。 */
function verdict(v4: CompareSide, v6: CompareSide): string {
  const s4 = v4.summary
  const s6 = v6.summary
  if (!s4 || !s6 || s4.entries.length === 0 || s6.entries.length === 0) {
    return '有一侧没有产出可用节点，无法给出结论'
  }
  const ws4 = rate(s4.stats.wsOk, s4.stats.candidates)
  const ws6 = rate(s6.stats.wsOk, s6.stats.candidates)
  const speed4 = median(s4.entries.map((e) => e.speed).filter((s) => s > 0))
  const speed6 = median(s6.entries.map((e) => e.speed).filter((s) => s > 0))

  const parts: string[] = []
  const diff = Math.abs(ws4 - ws6)
  if (diff < 0.05) {
    parts.push('两族可用率接近（相差不到 5 个百分点）')
  } else {
    parts.push(`可用率 ${ws4 > ws6 ? 'IPv4' : 'IPv6'} 更高（${pct(Math.max(ws4, ws6))} vs ${pct(Math.min(ws4, ws6))}）`)
  }
  if (speed4 > 0 && speed6 > 0) {
    const faster = speed4 > speed6 ? 'IPv4' : 'IPv6'
    const ratio = (Math.max(speed4, speed6) / Math.min(speed4, speed6)).toFixed(1)
    parts.push(`稳态吞吐 ${faster} 约快 ${ratio}×（${Math.max(speed4, speed6).toFixed(2)} vs ${Math.min(speed4, speed6).toFixed(2)} MB/s）`)
  }
  parts.push('入口质量只代表「本机 → Cloudflare 边缘」这条链路，不代表出口 IP 信誉')
  return parts.join('；')
}

/** 单侧指标行渲染。 */
function sideColumn(side: CompareSide): {
  candidates: string
  tcp: string
  tls: string
  ws: string
  entries: string
  tlsMedian: string
  speedMedian: string
  colos: string
  elapsed: string
} {
  const s = side.summary
  if (!s) {
    const empty = '—'
    return {
      candidates: String(side.candidates), tcp: empty, tls: empty, ws: empty,
      entries: empty, tlsMedian: empty, speedMedian: empty, colos: empty, elapsed: empty,
    }
  }
  const n = s.stats.candidates
  const speeds = s.entries.map((e) => e.speed).filter((v) => v > 0)
  return {
    candidates: String(s.stats.candidates),
    tcp: `${s.stats.tcpOk} (${pct(rate(s.stats.tcpOk, n))})`,
    tls: `${s.stats.tlsOk} (${pct(rate(s.stats.tlsOk, n))})`,
    ws: `${s.stats.wsOk} (${pct(rate(s.stats.wsOk, n))})`,
    entries: String(s.entries.length),
    tlsMedian: s.entries.length > 0 ? String(median(s.entries.map((e) => e.tlsMs))) : '—',
    speedMedian: speeds.length > 0 ? median(speeds).toFixed(2) : '—',
    colos: coloBreakdown(s.entries),
    elapsed: (s.stats.elapsedMs / 1000).toFixed(1),
  }
}

export async function runCompareCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(SCAN_COMPARE_HELP)
    return
  }

  const host = flagString(args, 'host')
  if (!host) {
    process.stderr.write('缺少 --host 参数（你的 Worker 数据面域名）\n')
    process.stderr.write('提示：cfpilot scan compare --host "你的域名"\n')
    process.exit(1)
  }

  const port = flagNumber(args, 'port', 443)
  const wsPath = normalizeWsPath(flagString(args, 'path'), '/__edge_probe')
  const probePath = normalizeWsPath(flagString(args, 'probe-path'), '/__edge_probe')
  const sample = flagNumber(args, 'sample', 3000)
  const top = flagNumber(args, 'top', 8)
  const noSpeed = flagBool(args, 'no-speed')
  const quiet = flagBool(args, 'quiet')
  const asJson = flagBool(args, 'json')
  const countries = normalizeCountryFilter(flagList(args, 'countries'))

  // 两轮共用的参数：除地址族外完全一致（见文件头「口径」）
  const common = {
    host,
    port,
    countries,
    wsPath,
    probePath,
    skipSpeed: noSpeed,
    verifyPayload: true,
    concurrency: flagNumber(args, 'concurrency', 300),
    retries: flagNumber(args, 'retries', 2),
    tcpTimeoutMs: flagNumber(args, 'timeout', 1200),
    tlsConcurrency: flagNumber(args, 'tls-concurrency', 64),
    tlsTimeoutMs: flagNumber(args, 'tls-timeout', 2000),
    probeLimit: flagNumber(args, 'probe-limit', 120),
    probeTimeoutMs: flagNumber(args, 'probe-timeout', 3000),
    speedLimit: flagNumber(args, 'speed-limit', 30),
    speedConcurrency: flagNumber(args, 'speed-concurrency', 1),
    speedConnections: Math.min(8, Math.max(1, flagNumber(args, 'speed-conns', 8))),
    speedDurationMs: Math.min(10000, Math.max(2000, flagNumber(args, 'speed-duration', 6000))),
    speedBytes: flagNumber(args, 'speed-bytes', 5 * 1024 * 1024),
    speedUrl: flagString(args, 'speed-url', DEFAULT_SPEED_URL),
    speedRepeat: flagNumber(args, 'speed-repeat', 1),
    verifyWsPath: args.flags['no-verify-ws-path'] === undefined,
    top,
    onProgress: (event: ScanEvent): void => printProgress(event, quiet),
  } as Parameters<typeof runScan>[0]

  if (!quiet) {
    process.stdout.write(`\n${NAME} v${VERSION} —— 双栈对照\n`)
    process.stdout.write(`目标：${host}:${port} · WS 路径 ${wsPath}\n`)
    process.stdout.write(`每族采样：${sample} · 两轮参数完全相同（只差地址族）\n\n`)
  }

  const sides: CompareSide[] = []
  for (const family of ['v4', 'v6'] as const) {
    const label = family === 'v4' ? 'IPv4' : 'IPv6'
    if (!quiet) process.stdout.write(`── 第 ${sides.length + 1}/2 轮：${label} ──\n`)

    const plan: CandidatePlan = await resolveCandidatePlan({
      sample,
      family,
      extraHosts: [host],
      neutral: flagBool(args, 'neutral-sampling'),
      seed: args.flags['seed'] !== undefined ? flagNumber(args, 'seed', 24301) : undefined,
    })

    if (plan.candidates.length === 0) {
      if (!quiet) {
        process.stdout.write(`  ${label} 没有可用候选：${plan.note}\n`)
        if (plan.ipv6Env) {
          process.stdout.write(`  ${plan.ipv6Env.message}\n`)
          for (const advice of plan.ipv6Env.advice ?? []) process.stdout.write(`   · ${advice}\n`)
        }
      }
      sides.push({
        family,
        candidates: 0,
        summary: null,
        ipv6Note: plan.note,
        error: plan.ipv6Env?.status && plan.ipv6Env.status !== 'ok' ? plan.ipv6Env.message : plan.note,
      })
      continue
    }

    const summary = await runScan({ ...common, candidates: plan.candidates })
    sides.push({
      family,
      candidates: plan.candidates.length,
      summary,
      ipv6Note: plan.note,
    })
    if (!quiet) process.stdout.write('\n')
  }

  const v4 = sides[0]!
  const v6 = sides[1]!

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tool: 'cfpilot',
          version: VERSION,
          command: 'scan compare',
          params: { host, port, wsPath, probePath, sample, top, skipSpeed: noSpeed, countries },
          v4: serializeSide(v4),
          v6: serializeSide(v6),
          verdict: verdict(v4, v6),
        },
        null,
        2
      )}\n`
    )
    return
  }

  printTable(v4, v6)
  process.stdout.write(`\n结论：${verdict(v4, v6)}\n`)
}

/** JSON 输出用：把 ScanSummary 压成对照需要的字段（不带 observations，太大）。 */
function serializeSide(side: CompareSide): Record<string, unknown> {
  const s = side.summary
  if (!s) {
    return { family: side.family, candidates: side.candidates, note: side.ipv6Note, error: side.error ?? null }
  }
  const speeds = s.entries.map((e) => e.speed).filter((v) => v > 0)
  return {
    family: side.family,
    candidates: s.stats.candidates,
    tcpOk: s.stats.tcpOk,
    tlsOk: s.stats.tlsOk,
    wsOk: s.stats.wsOk,
    verified: s.stats.verified,
    entries: s.entries.length,
    tlsMedianMs: s.entries.length > 0 ? median(s.entries.map((e) => e.tlsMs)) : 0,
    speedMedianMBps: speeds.length > 0 ? median(speeds) : 0,
    colos: Object.fromEntries(
      [...s.entries.reduce((m, e) => m.set(e.colo || 'UNK', (m.get(e.colo || 'UNK') ?? 0) + 1), new Map<string, number>())]
    ),
    elapsedMs: s.stats.elapsedMs,
    failures: s.stats.failures ?? {},
    note: side.ipv6Note,
  }
}

/** 打印对照表（定宽列，中文表头按 2 字符宽度对齐）。 */
function printTable(v4: CompareSide, v6: CompareSide): void {
  const a = sideColumn(v4)
  const b = sideColumn(v6)
  const rows: Array<[string, string, string]> = [
    ['候选数', a.candidates, b.candidates],
    ['TCP 通过', a.tcp, b.tcp],
    ['TLS 通过', a.tls, b.tls],
    ['WS101 通过', a.ws, b.ws],
    ['可用节点', a.entries, b.entries],
    ['TLS 中位数(ms)', a.tlsMedian, b.tlsMedian],
    ['稳态吞吐中位数(MB/s)', a.speedMedian, b.speedMedian],
    ['机房分布', a.colos, b.colos],
    ['耗时(s)', a.elapsed, b.elapsed],
  ]

  const w0 = Math.max(18, ...rows.map((r) => displayWidth(r[0])))
  const w1 = Math.max(14, ...rows.map((r) => displayWidth(r[1])))
  const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

  process.stdout.write(`${pad('指标', w0)}  ${pad('IPv4', w1)}  IPv6\n`)
  process.stdout.write(`${'─'.repeat(w0)}  ${'─'.repeat(w1)}  ${'─'.repeat(4)}\n`)
  for (const [name, left, right] of rows) {
    process.stdout.write(`${pad(name, w0)}  ${pad(left, w1)}  ${right}\n`)
  }
  if (v4.error) process.stdout.write(`\nIPv4 侧提示：${v4.error}\n`)
  if (v6.error) process.stdout.write(`IPv6 侧提示：${v6.error}\n`)
}

/** 显示宽度：中文/全角按 2 计，保证表格列对齐。 */
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  }
  return width
}

/** 扫描进度：quiet 时不输出；否则只打阶段行，避免刷屏。 */
function printProgress(event: ScanEvent, quiet: boolean): void {
  if (quiet) return
  if (event.type === 'stage') {
    process.stdout.write(`  ▶ ${event.name}（共 ${event.total} 个候选）\n`)
  } else if (event.type === 'done') {
    process.stdout.write(`  ✓ 通过全部校验 ${event.count} 条\n`)
  } else if (event.type === 'error') {
    process.stderr.write(`  ✗ ${event.message}\n`)
  }
}
