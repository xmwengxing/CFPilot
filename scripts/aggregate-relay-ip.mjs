#!/usr/bin/env node
/**
 * 把多轮 `scan --json` 的结果聚合成一份**实测清单**。
 *
 * ## 为什么要多轮
 *
 * 单轮的「通 / 不通」会被抖动污染：同一个 IP 这轮超时、下轮正常是常态
 * （本轮三轮的 WS101 通过数就是 192 / 195 / 202）。只跑一轮会把
 * 「暂时抖」误判成「不可用」，也会把「碰巧赶上」当成稳定。
 *
 * 所以每个 IP 记的是**通过轮数占比**（Success %）与多轮的延迟分布，
 * 而不是一个绝对结论。
 *
 * ## 输入 / 输出
 *
 *   输入  docs/relay-ip-round*.json   （`scan --json` 的产物）
 *         docs/relay-ip-candidates.csv（候选池，提供顺序与基础信息）
 *   输出  docs/relay-ip-measured.csv   （已在 .gitignore：网络快照不入库）
 *
 * 用法：
 *   node scripts/aggregate-relay-ip.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const candidateFile = join(root, 'docs', 'relay-ip-candidates.csv')
const outDir = join(root, 'docs')
const outFile = join(outDir, 'relay-ip-measured.csv')

if (!existsSync(candidateFile)) {
  console.error(`找不到候选池：${candidateFile}`)
  process.exit(1)
}

/** 简易 CSV 解析（能处理带引号与内嵌逗号的字段） */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function csvField(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 中位数；空数组返回 '' */
function median(values) {
  if (values.length === 0) return ''
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const v = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  return Number(v.toFixed(1))
}

function percentile(values, p) {
  if (values.length === 0) return ''
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[idx].toFixed(1))
}

// ---- 读候选池（保持原始顺序与元信息）----
// 候选池里预留的**测量列**要排除掉：它们是空的占位，
// 不排会和下面真正算出来的列重名（CSV 里同名列会让读取方直接报错）。
const MEASURED_COLUMNS = new Set([
  'Connect ms',
  'TLS ms',
  'WS101',
  'Success %',
  'P50 ms',
  'P95 ms',
  'Colos',
  'Tested at',
  'Rounds',
])
const candRows = parseCsv(readFileSync(candidateFile, 'utf8')).filter((r) => r.length > 1)
const header = candRows[0]
const ipCol = header.findIndex((h) => h === 'Proxy IP')
// 输出沿用候选池的原始列序，只把「测量列」换成真正算出来的那些
const keepColumns = header.map((name, index) => ({ name, index })).filter((c) => !MEASURED_COLUMNS.has(c.name))
const candidates = candRows.slice(1).map((r) => ({
  ip: (r[ipCol] ?? '').trim(),
  row: r,
}))
const candidateIps = new Set(candidates.map((c) => c.ip))

// ---- 读所有轮次 ----
const rounds = readdirSync(outDir)
  .filter((f) => /^relay-ip-round\d*\.json$/.test(f))
  .sort()
  .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(outDir, f), 'utf8')) }))

if (rounds.length === 0) {
  console.error('没有找到 docs/relay-ip-round*.json，先跑几轮 scan --json')
  process.exit(1)
}

/** ip → 每轮的观测 */
const observed = new Map()
for (const { data } of rounds) {
  const seen = new Set()
  for (const e of data.entries ?? []) {
    if (!candidateIps.has(e.ip)) continue
    seen.add(e.ip)
    const list = observed.get(e.ip) ?? []
    list.push({ tlsMs: e.tlsMs ?? 0, tcpMs: e.tcpMs ?? e.latency ?? 0, colo: e.colo || '' })
    observed.set(e.ip, list)
  }
  // 本轮没通过的 IP 也算「观测过但失败」—— Success% 的分母是轮数
  for (const ip of candidateIps) {
    if (!seen.has(ip)) {
      const list = observed.get(ip) ?? []
      list.push({ failed: true })
      observed.set(ip, list)
    }
  }
}

// ---- 聚合输出 ----
const roundCount = rounds.length
const outHeader = [
  ...keepColumns.map((c) => c.name),
  'Success %',
  'Rounds',
  'Connect ms',
  'TLS ms',
  'P50 ms',
  'P95 ms',
  'Colos',
  'Tested at',
]
const testedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

const lines = [outHeader.map(csvField).join(',')]
for (const cand of candidates) {
  const obs = observed.get(cand.ip) ?? []
  const passed = obs.filter((o) => !o.failed)
  const successPct = obs.length === 0 ? '' : Math.round((passed.length / obs.length) * 100)
  const tls = passed.map((o) => o.tlsMs).filter((v) => v > 0)
  const tcp = passed.map((o) => o.tcpMs).filter((v) => v > 0)
  const colos = [...new Set(passed.map((o) => o.colo).filter(Boolean))].sort().join('|')
  // 原样保留候选池的列（Proxy IP 取自解析结果，其余取原始单元格）
  const kept = keepColumns.map((c) => (c.name === 'Proxy IP' ? cand.ip : (cand.row[c.index] ?? '')))
  lines.push(
    [
      ...kept,
      successPct,
      `${passed.length}/${obs.length}`,
      median(tcp),
      median(tls),
      percentile(tls, 50),
      percentile(tls, 95),
      colos,
      testedAt,
    ].map(csvField).join(',')
  )
}

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')

// ---- 汇总 ----
const all = [...observed.values()]
const alwaysOk = all.filter((o) => o.length > 0 && o.every((x) => !x.failed)).length
const neverOk = all.filter((o) => o.length > 0 && o.every((x) => x.failed)).length
const flaky = all.length - alwaysOk - neverOk
console.log(`轮次：${rounds.length}（${rounds.map((r) => r.file).join(', ')}）`)
console.log(`候选：${candidates.length}`)
console.log(`  三轮全通：${alwaysOk}`)
console.log(`  三轮全挂：${neverOk}`)
console.log(`  有抖动  ：${flaky}`)
console.log(`输出：${outFile}`)
