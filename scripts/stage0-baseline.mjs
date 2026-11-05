#!/usr/bin/env node
/**
 * 数据面基线测量（阶段 0）。
 *
 * ## 边界
 *
 * - **只发请求**：不改产品代码、不改配置、不部署、不写任何云端存储；
 * - 凭据从环境变量读（`CFPILOT_BASE` / `CFPILOT_WS_PATH` / `CFPILOT_UUID`），
 *   未设置时回退到仓库外的临时文件，与既有隧道脚本共用同一份参数；
 * - 结果默认写 `tmp/stage0-baseline.json`（该目录不入库）。
 *
 * ## 为什么需要固定工作量
 *
 * 改前改后必须跑同一份活才能比较：下行用 `Range: bytes=0-N` 定长，
 * 超时与并发数全部固定，多轮取中位数而不是最好成绩。
 *
 * ## 用法
 *
 *   node scripts/stage0-baseline.mjs                # 全量（约 2~3 分钟）
 *   node scripts/stage0-baseline.mjs --quick        # 跳过采样与长连接
 *   node scripts/stage0-baseline.mjs --out a.json   # 指定输出
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HELP = `
数据面基线测量（只读）

用法：
  node scripts/stage0-baseline.mjs [--quick] [--out <file>] [--no-diag]

参数：
  --quick        跳过 EOF 采样与长连接场景，只跑连通性 / 网段 / 下行
  --out <file>   结果 JSON 路径，默认 tmp/stage0-baseline.json
  --no-diag      不读 /__diag（实例不可达或不想带令牌时用）

环境：
  CFPILOT_BASE       数据面域名（可带 https://）
  CFPILOT_WS_PATH    WS 路径，例如 /abcdef
  CFPILOT_UUID       VLESS UUID（32 位十六进制，可带连字符）
  三者未设置时回退到 %TEMP%/cfpilot-tunnel.json 的 base / wsPath / uuid。
`

/** 读隧道参数：环境变量优先，其次仓库外的临时文件。 */
function loadParams() {
  const base = process.env.CFPILOT_BASE
  const wsPath = process.env.CFPILOT_WS_PATH
  const uuid = process.env.CFPILOT_UUID
  if (base && wsPath && uuid) return { base: cleanBase(base), wsPath, uuid }

  const fallback = join(tmpdir(), 'cfpilot-tunnel.json')
  try {
    const raw = JSON.parse(readFileSync(fallback, 'utf8'))
    if (raw.base && raw.wsPath && raw.uuid) {
      return { base: cleanBase(raw.base), wsPath: String(raw.wsPath), uuid: String(raw.uuid) }
    }
  } catch {
    /* 没有回退文件就继续报缺参 */
  }
  return null
}

function cleanBase(value) {
  return String(value).replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) throw new Error(`UUID 应为 32 位十六进制，实际 ${hex.length} 位`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 目标地址编码：IPv4 字面量用 ATYP=1，其余按域名用 ATYP=2（带 1 字节长度前缀）。 */
function encodeAddress(address) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split('.').map(Number)
    if (parts.some((n) => !Number.isInteger(n) || n > 255)) throw new Error(`非法 IPv4：${address}`)
    const out = new Uint8Array(5)
    out[0] = 0x01
    out.set(parts, 1)
    return out
  }
  const name = new TextEncoder().encode(address)
  if (name.length > 255) throw new Error('域名过长')
  const out = new Uint8Array(2 + name.length)
  out[0] = 0x02
  out[1] = name.length
  out.set(name, 2)
  return out
}

function buildVlessHello(uuid, host, port) {
  const addr = encodeAddress(host)
  const out = new Uint8Array(21 + addr.length)
  out[0] = 0x00
  out.set(uuidToBytes(uuid), 1)
  out[17] = 0x00
  out[18] = 0x01
  out[19] = (port >> 8) & 0xff
  out[20] = port & 0xff
  out.set(addr, 21)
  return out
}

function splitTarget(target) {
  const idx = target.lastIndexOf(':')
  if (idx < 0) throw new Error(`目标格式应为 host:port，收到：${target}`)
  const host = target.slice(0, idx)
  const port = Number(target.slice(idx + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`目标格式应为 host:port，收到：${target}`)
  }
  return { host, port }
}

/**
 * 建一条隧道并等协议响应头。
 *
 * ⚠️ 响应头只代表「认证通过、入站已建立」，不代表出站成功 —— 出站结果必须
 * 继续看首字节 / 关闭码，这里的 helloMs 只作为拨号耗时的近似上界。
 */
function openTunnel({ wsUrl, uuid, host, port, sendHello = true, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    let settled = false
    const t0 = Date.now()
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* 已关闭 */ }
      reject(new Error(`握手超时（${timeoutMs}ms）`))
    }, timeoutMs)

    ws.addEventListener('open', () => {
      if (!sendHello) {
        settled = true
        clearTimeout(timer)
        resolve({ ws, helloMs: null })
        return
      }
      ws.send(buildVlessHello(uuid, host, port))
      ws.addEventListener('message', (ev) => {
        if (settled) return
        const bytes = new Uint8Array(ev.data)
        if (bytes.length < 2) return
        settled = true
        clearTimeout(timer)
        resolve({ ws, helloMs: Date.now() - t0 })
      })
    })
    ws.addEventListener('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败'))
    })
    ws.addEventListener('close', (ev) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`握手阶段关闭：code=${ev.code} reason=${ev.reason || '(空)'}`))
    })
  })
}

/** 等首字节 / 关闭 / 超时，统计收到字节与关闭原因。 */
function waitOutcome(ws, timeoutMs, onChunk) {
  return new Promise((resolve) => {
    let done = false
    let ttfbMs = null
    let received = 0
    let peakQueued = 0
    let queued = 0
    const started = Date.now()
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ttfbMs, received, peakQueued, totalMs: Date.now() - started, ...extra })
    }
    const timer = setTimeout(() => finish({ wait: 'timeout', closeCode: null, closeReason: '' }), timeoutMs)
    ws.addEventListener('message', (ev) => {
      const chunk = new Uint8Array(ev.data)
      if (ttfbMs === null) ttfbMs = Date.now() - started
      received += chunk.byteLength
      queued += chunk.byteLength
      if (queued > peakQueued) peakQueued = queued
      // 消费者按固定速率「处理」；这里只记账，不改变 Worker 侧行为
      if (onChunk) onChunk(chunk, () => { queued = Math.max(0, queued - chunk.byteLength) })
      else queued = 0
      if (Date.now() - started > timeoutMs) finish({ wait: 'timeout' })
    })
    ws.addEventListener('close', (ev) => finish({ closeCode: ev.code, closeReason: ev.reason || '' }))
    ws.addEventListener('error', () => finish({ wait: 'ws-error', closeCode: null, closeReason: '' }))
  })
}

const HTTP_GET = (host, extra = '') =>
  `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: cfpilot-stage0\r\n${extra}\r\n`

async function runTarget(params, target, timeoutMs = 7000) {
  const { host, port } = splitTarget(target)
  try {
    const { ws, helloMs } = await openTunnel({ ...params, wsUrl: params.wsUrl, host, port })
    ws.send(new TextEncoder().encode(HTTP_GET(host)))
    const out = await waitOutcome(ws, timeoutMs)
    try { ws.close() } catch { /* 已关闭 */ }
    return { target, helloMs, ok: out.ttfbMs !== null, ...out }
  } catch (err) {
    return { target, ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/** 定长下行：Range 请求，收到 N 字节或连接结束即停。 */
async function runDownload(params, target, path, bytes, timeoutMs = 30000) {
  const { host, port } = splitTarget(target)
  try {
    const { ws, helloMs } = await openTunnel({ ...params, host, port })
    const result = await new Promise((resolve) => {
      let received = 0
      let headerBytes = 0
      let headSeen = false
      let firstAt = 0
      let lastAt = 0
      let done = false
      const finish = (extra) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { ws.close() } catch { /* 已关闭 */ }
        const span = firstAt > 0 ? (lastAt - firstAt) / 1000 : 0
        const body = headSeen ? Math.max(0, received - headerBytes) : 0
        resolve({
          helloMs, received, bodyBytes: body, seconds: Number(span.toFixed(3)),
          mbps: span > 0 ? body / 1024 / 1024 / span : 0, ...extra,
        })
      }
      const timer = setTimeout(() => finish({ wait: 'timeout' }), timeoutMs)
      ws.addEventListener('message', (ev) => {
        const chunk = new Uint8Array(ev.data)
        if (!headSeen) {
          const sep = new TextDecoder().decode(chunk).indexOf('\r\n\r\n')
          if (sep < 0) return
          headSeen = true
          headerBytes = sep + 4
        }
        const now = Date.now()
        if (firstAt === 0) firstAt = now
        lastAt = now
        received += chunk.byteLength
        if (received - headerBytes >= bytes) finish({ stopped: 'reached-bytes' })
      })
      ws.addEventListener('close', (ev) => finish({ closeCode: ev.code }))
      ws.addEventListener('error', () => finish({ wait: 'ws-error' }))
      const req =
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n` +
        `Range: bytes=0-${bytes - 1}\r\nUser-Agent: cfpilot-stage0\r\n\r\n`
      ws.send(new TextEncoder().encode(req))
    })
    return { target, path, bytes, ...result }
  } catch (err) {
    return { target, path, bytes, bodyBytes: 0, mbps: 0, error: String(err && err.message ? err.message : err) }
  }
}

/**
 * 零字节首包场景：连上 WS 后一个字节都不发，看运行时多久关闭。
 * 这条用来界定「握手超时」现状 —— 若长时间不关，就是阶段 2 要补的缺口。
 */
async function runEmptySession(params, holdMs = 12000) {
  try {
    const { ws } = await openTunnel({
      ...params, host: 'invalid.invalid', port: 80, sendHello: false, timeoutMs: 8000,
    })
    const out = await waitOutcome(ws, holdMs)
    try { ws.close() } catch { /* 已关闭 */ }
    return { holdMs, received: out.received, totalMs: out.totalMs, closeCode: out.closeCode, closeReason: out.closeReason, wait: out.wait }
  } catch (err) {
    return { holdMs, error: String(err && err.message ? err.message : err) }
  }
}

/** 读 /__diag：只统计条数与失败类型分布，不输出目标域名。 */
async function collectDiag(params) {
  try {
    const res = await fetch(`https://${params.base}/__diag`, {
      headers: { 'x-cfpilot-token': params.uuid },
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.json()
    const recent = Array.isArray(body.recent) ? body.recent : []
    const kinds = {}
    for (const item of recent) {
      const failures = Array.isArray(item.failures) ? item.failures : []
      for (const f of failures) {
        const k = String(f && f.kind ? f.kind : 'unknown')
        kinds[k] = (kinds[k] || 0) + 1
      }
    }
    return {
      httpStatus: res.status,
      build: body.build || '',
      recentCount: recent.length,
      xhttpCount: Array.isArray(body.xhttp) ? body.xhttp.length : 0,
      failureKinds: kinds,
    }
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) }
  }
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Number(sorted[idx].toFixed(1))
}

function parseArgs(argv) {
  const out = { quick: false, diag: true, out: 'tmp/stage0-baseline.json' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quick') out.quick = true
    else if (a === '--no-diag') out.diag = false
    else if (a === '--out') out.out = argv[++i] || out.out
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

/** 判定表内 / 缺失官方段 / 已知必拒段，用来对照「是否触发反代」的行为差异。 */
const RANGE_TARGETS = [
  { label: 'in-table', target: '104.16.0.1:443' },
  { label: 'missing-173', target: '173.245.48.1:443' },
  { label: 'missing-190', target: '190.93.240.1:443' },
  { label: 'loopback-cf-dns', target: '1.1.1.1:443' },
]

/**
 * 定长下行档位。
 *
 * ⚠️ 两个端点不能混用：`/1mb.test` 只有 1 MiB，对它请求 4 MiB 时服务端
 * 只回 1 MiB 就关闭，测出来的「大文件」其实是小文件。`/5mb.test` 才够 4 MiB。
 */
const DOWNLOAD_CASES = [
  { label: 'small-1MiB', path: '/1mb.test', bytes: 1 * 1024 * 1024 },
  { label: 'large-4MiB', path: '/5mb.test', bytes: 4 * 1024 * 1024 },
]

/** EOF 早退采样：只看「0 下行但很快 done」的比例，不记目标内容。 */
const EOF_SAMPLE_TARGETS = [
  'neverssl.com:80',
  'example.com:80',
  'www.gstatic.com:80',
  'cachefly.cachefly.net:80',
  'github.com:443',
  'www.youtube.com:443',
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(HELP); return }
  const raw = loadParams()
  if (!raw) {
    process.stderr.write('缺少隧道参数：请设置 CFPILOT_BASE / CFPILOT_WS_PATH / CFPILOT_UUID\n')
    process.exit(2)
  }
  const params = { ...raw, wsUrl: `wss://${raw.base}${raw.wsPath}` }
  const started = Date.now()
  const report = { at: new Date().toISOString(), base: raw.base, quick: args.quick, scenarios: {} }

  process.stderr.write('[1/5] 连通性 …\n')
  report.scenarios.connectivity = await runTarget(params, 'www.gstatic.com:80')

  process.stderr.write('[2/5] 网段对照 …\n')
  report.scenarios.ranges = []
  for (const item of RANGE_TARGETS) {
    const r = await runTarget(params, item.target)
    report.scenarios.ranges.push({ label: item.label, ...r })
  }

  process.stderr.write('[3/5] EOF 早退采样 …\n')
  if (args.quick) {
    report.scenarios.eofSample = { skipped: 'quick' }
  } else {
    const samples = []
    for (const t of EOF_SAMPLE_TARGETS) samples.push(await runTarget(params, t))
    const zeroDownDone = samples.filter((s) => s.ok === false && s.received === 0 && s.closeCode === 1000).length
    report.scenarios.eofSample = {
      total: samples.length,
      zeroDownDone,
      ratio: Number((zeroDownDone / samples.length).toFixed(2)),
      ttfbP50: percentile(samples.map((s) => s.ttfbMs).filter((v) => v !== null), 50),
      ttfbP95: percentile(samples.map((s) => s.ttfbMs).filter((v) => v !== null), 95),
      closeCodes: samples.reduce((acc, s) => { const k = String(s.closeCode ?? 'none'); acc[k] = (acc[k] || 0) + 1; return acc }, {}),
      samples: samples.map((s) => ({
        target: s.target, ok: s.ok, helloMs: s.helloMs ?? null, ttfbMs: s.ttfbMs ?? null,
        received: s.received ?? 0, closeCode: s.closeCode ?? null, wait: s.wait ?? null, error: s.error ?? null,
      })),
    }
  }

  process.stderr.write('[4/5] 定长下行 …\n')
  // 单轮抖动可达一个数量级（实测 1 MiB 两轮为 4.8 / 40 MB/s），
  // 全量必须每档多轮取中位数，否则改前改后的差异会被噪声淹没。
  const rounds = args.quick ? 1 : 3
  const downloads = []
  for (const c of DOWNLOAD_CASES) {
    for (let i = 0; i < rounds; i++) {
      const r = await runDownload(params, 'cachefly.cachefly.net:80', c.path, c.bytes)
      downloads.push({ label: c.label, ...r })
    }
  }
  const mbps = downloads.map((d) => d.mbps).filter((v) => v > 0)
  const byCase = {}
  for (const c of DOWNLOAD_CASES) {
    const values = downloads.filter((d) => d.label === c.label).map((d) => d.mbps).filter((v) => v > 0)
    byCase[c.label] = { runs: values.length, medianMBps: percentile(values, 50), bodyBytes: downloads.find((d) => d.label === c.label)?.bodyBytes ?? 0 }
  }
  report.scenarios.download = {
    runs: downloads, byCase,
    medianMBps: percentile(mbps, 50),
    p95MBps: percentile(mbps, 95),
  }

  process.stderr.write('[5/5] 长连接与诊断 …\n')
  report.scenarios.emptySession = args.quick
    ? { skipped: 'quick' }
    : await runEmptySession(params)
  report.scenarios.diag = args.diag ? await collectDiag(params) : { skipped: 'no-diag' }

  report.elapsedMs = Date.now() - started
  writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(`${JSON.stringify(summarize(report), null, 2)}\n`)
  process.stderr.write(`\n完整结果：${args.out}\n`)
}

/** 终端摘要：只给决策需要的数字，完整明细在 JSON 里。 */
function summarize(r) {
  const s = r.scenarios
  return {
    at: r.at,
    build: s.diag && s.diag.build ? s.diag.build : 'unknown',
    elapsedMs: r.elapsedMs,
    connectivity: {
      ok: s.connectivity.ok,
      helloMs: s.connectivity.helloMs ?? null,
      ttfbMs: s.connectivity.ttfbMs ?? null,
      received: s.connectivity.received ?? 0,
    },
    ranges: s.ranges.map((x) => ({
      label: x.label, ok: x.ok, received: x.received ?? 0,
      closeCode: x.closeCode ?? null, reason: (x.closeReason || x.error || '').slice(0, 80),
    })),
    eof: s.eofSample.skipped ? s.eofSample : {
      total: s.eofSample.total, zeroDownDone: s.eofSample.zeroDownDone,
      ratio: s.eofSample.ratio, ttfbP50: s.eofSample.ttfbP50, ttfbP95: s.eofSample.ttfbP95,
    },
    download: { medianMBps: s.download.medianMBps, p95MBps: s.download.p95MBps, runs: s.download.runs.length, byCase: s.download.byCase },
    emptySession: s.emptySession,
    diag: s.diag,
  }
}

main().catch((err) => {
  process.stderr.write(`失败：${err && err.message ? err.message : String(err)}\n`)
  process.exit(1)
})
