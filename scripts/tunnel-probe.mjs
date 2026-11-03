#!/usr/bin/env node
/**
 * 隧道复核与吞吐基线。
 *
 * ## 它只做一件事
 *
 * 向**已部署的数据面**发请求，回答两个问题：
 *   1. Worker 的 `connect()` 到底还支不支持 IPv6 目标？（决定要不要做出站双栈）
 *   2. 走隧道的下行吞吐是多少？（改动前采基线、改动后复测，判有没有回归）
 *
 * ## 为什么必须打真机
 *
 * 本地 workerd 与生产运行时**行为不一致**（对私有 IP、证书、地址族的处理都不同），
 * 本地测出的结论不能用来推翻生产结论 —— 这条已经踩过（见 AGENTS 里
 * 「本地 workerd 拒绝连私有 IP」与真机结论相反的记录）。
 *
 * ## 边界
 *
 * - **只发请求**：不改任何配置、不部署任何东西、不写任何存储；
 * - 凭据从环境变量读（`CFPILOT_WS` / `CFPILOT_UUID`），
 *   未设置时回退到仓库外的临时文件（`%TEMP%/cfpilot-tunnel.json`），**不入库**；
 * - 协议：VLESS over WebSocket（与订阅下发的 `vless-ws` 形态一致）。
 *
 * ## 用法
 *
 *   CFPILOT_WS=wss://<数据面>/<wsPath> CFPILOT_UUID=<uuid> \
 *     node scripts/tunnel-probe.mjs --target 1.2.3.4:443
 *
 *   ... node scripts/tunnel-probe.mjs --target 2606:4700::1:443
 *
 *   ... node scripts/tunnel-probe.mjs --get example.com:80 /10MB.zip --runs 3
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 读隧道参数：环境变量优先，其次仓库外的临时文件。 */
function loadTunnelParams() {
  const wsUrl = process.env.CFPILOT_WS
  const uuid = process.env.CFPILOT_UUID
  if (wsUrl && uuid) return { wsUrl, uuid }

  const fallback = join(tmpdir(), 'cfpilot-tunnel.json')
  try {
    const raw = JSON.parse(readFileSync(fallback, 'utf8'))
    if (raw.wsPath && raw.base && raw.uuid) {
      return { wsUrl: `wss://${String(raw.base).replace(/^https?:\/\//, '')}${raw.wsPath}`, uuid: String(raw.uuid) }
    }
  } catch {
    /* 没有回退文件就继续报缺参 */
  }
  return { wsUrl: '', uuid: '' }
}

/** 把 UUID 文本转成 16 字节。 */
function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) throw new Error(`UUID 应为 32 位十六进制，实际 ${hex.length} 位`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 判断地址形态并给出 ATYP 与地址字节。 */
function encodeAddress(address) {
  if (address.includes(':')) {
    // IPv6 字面量（可能带方括号）
    const bare = address.replace(/^\[|\]$/g, '')
    const groups = expandIpv6(bare)
    if (!groups) throw new Error(`不是合法的 IPv6 地址：${address}`)
    const out = new Uint8Array(17)
    out[0] = 0x03
    for (let i = 0; i < 8; i++) {
      out[1 + i * 2] = (groups[i] >> 8) & 0xff
      out[2 + i * 2] = groups[i] & 0xff
    }
    return out
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split('.').map(Number)
    const out = new Uint8Array(5)
    out[0] = 0x01
    out.set(parts, 1)
    return out
  }
  const name = new TextEncoder().encode(address)
  const out = new Uint8Array(2 + name.length)
  out[0] = 0x02
  out[1] = name.length
  out.set(name, 2)
  return out
}

/** IPv6 文本 → 8 个 16 位分组（支持 `::` 压缩与内嵌 IPv4）。 */
function expandIpv6(text) {
  let s = text.toLowerCase()
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const parts = tail.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n > 255)) return null
    s = `${s.slice(0, lastColon + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const idx = s.indexOf('::')
  let head
  let rest
  if (idx >= 0) {
    if (s.indexOf('::', idx + 1) >= 0) return null
    head = s.slice(0, idx) ? s.slice(0, idx).split(':') : []
    rest = s.slice(idx + 2) ? s.slice(idx + 2).split(':') : []
    const missing = 8 - head.length - rest.length
    if (missing < 0) return null
    head = [...head, ...Array(missing).fill('0'), ...rest]
  } else {
    head = s.split(':')
  }
  if (head.length !== 8) return null
  const groups = head.map((g) => Number.parseInt(g || '0', 16))
  return groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** 组一次 VLESS 客户端问候（TCP 命令）。 */
function buildVlessHello(uuid, host, port) {
  const addr = encodeAddress(host)
  const out = new Uint8Array(21 + addr.length)
  out[0] = 0x00
  out.set(uuidToBytes(uuid), 1)
  out[17] = 0x00 // addons 长度
  out[18] = 0x01 // CONNECT
  out[19] = (port >> 8) & 0xff
  out[20] = port & 0xff
  out.set(addr, 21)
  return out
}

/** 拆 `host:port`（IPv6 支持 `[::1]:443` 与裸地址）。 */
function splitTarget(target) {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(target)
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) }
  const idx = target.lastIndexOf(':')
  if (idx < 0) throw new Error(`目标格式应为 host:port，收到：${target}`)
  const host = target.slice(0, idx)
  const port = Number(target.slice(idx + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`目标格式应为 host:port，收到：${target}`)
  }
  return { host, port }
}

/** 建一条 VLESS-WS 隧道，握手通过后 resolve。 */
function openTunnel({ wsUrl, uuid, host, port, handshakeTimeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
      reject(new Error(`握手超时（${handshakeTimeoutMs}ms 未收到协议响应头）`))
    }, handshakeTimeoutMs)

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
      reject(err)
    }

    ws.addEventListener('open', () => {
      const t0 = Date.now()
      ws.send(buildVlessHello(uuid, host, port))
      ws.addEventListener('message', (ev) => {
        if (settled) return
        const bytes = new Uint8Array(ev.data)
        // 响应头：版本(1) + Addons 长度(1) + Addons
        if (bytes.length < 2) return
        settled = true
        clearTimeout(timer)
        resolve({ ws, helloMs: Date.now() - t0, response: Array.from(bytes.slice(0, Math.min(bytes.length, 8))) })
      })
    })
    ws.addEventListener('error', () => fail(new Error('WebSocket 连接失败')))
    ws.addEventListener('close', (ev) => fail(new Error(`握手阶段关闭：code=${ev.code} reason=${ev.reason || '(空)'}`)))
  })
}

/**
 * 模式一：建隧道后发一个明文 GET，观察出站结果。
 *
 * ⚠️ **协议响应头不能当出站成功的判据** —— 按 AGENTS §10，`[0,0]` 是
 * 认证通过后**立即**回的，那时出站还没开始。真正的出站结果只能看：
 *   - 运行时拒绝该地址族 → Worker 会**快速**带原因关闭（1011）
 *   - 连上了但对端不应答 → 一直开着直到超时
 * 这两者的时间差与关闭原因，就是复核 §20 的判据。
 */
async function runTarget(params, target) {
  const { host, port } = splitTarget(target)
  const started = Date.now()
  try {
    const { ws, helloMs, response } = await openTunnel({ ...params, host, port })
    ws.send(
      new TextEncoder().encode(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: cfpilot-tunnel-probe\r\n\r\n`
      )
    )
    const outcome = await waitForOutcome(ws, 6000)
    return {
      target,
      family: host.includes(':') ? 'v6' : 'v4',
      ok: outcome.firstByte !== null,
      helloMs,
      totalMs: Date.now() - started,
      responseHeader: response,
      ...outcome,
    }
  } catch (err) {
    return {
      target,
      family: host.includes(':') ? 'v6' : 'v4',
      ok: false,
      helloMs: null,
      totalMs: Date.now() - started,
      error: String(err && err.message ? err.message : err),
    }
  }
}

/** 等首字节或关闭：区分「拿到数据」与「被拒绝/超时」。 */
function waitForOutcome(ws, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let firstByte = null
    let received = 0
    /** 首包前若干字节 —— 用来确认数据确实来自目标，而不是握手残留 */
    let preview = ''
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ firstByte, received, preview, ...extra })
    }
    const timer = setTimeout(() => finish({ wait: 'timeout', closeCode: null, closeReason: '' }), timeoutMs)
    ws.addEventListener('message', (ev) => {
      const chunk = new Uint8Array(ev.data)
      if (firstByte === null) {
        firstByte = Date.now()
        preview = new TextDecoder('utf-8', { fatal: false }).decode(chunk.slice(0, 120))
      }
      received += chunk.byteLength
    })
    ws.addEventListener('close', (ev) => finish({ closeCode: ev.code, closeReason: ev.reason || '' }))
  })
}

/** 模式二：建隧道后发裸 HTTP/1.1 GET，测稳态下行（多轮取中位数）。 */
async function runDownload(params, target, path, runs, bytes) {
  const { host, port } = splitTarget(target)
  const results = []
  for (let i = 0; i < runs; i++) {
    try {
      const { ws, helloMs } = await openTunnel({ ...params, host, port })
      const r = await measureDownlink(ws, host, path, 30000, bytes)
      results.push({ run: i + 1, helloMs, ...r })
    } catch (err) {
      // 单轮失败不作废整批：中位数本来就该剔掉抖动
      results.push({ run: i + 1, error: String(err && err.message ? err.message : err), bodyBytes: 0, seconds: 0, mbps: 0 })
    }
  }
  const steady = results.map((r) => r.mbps).filter((v) => v > 0).sort((a, b) => a - b)
  const median = steady.length === 0 ? 0 : steady[Math.floor(steady.length / 2)]
  return { target, path, bytes, runs: results, medianMBps: Number(median.toFixed(3)), okRuns: steady.length }
}

/**
 * 定长下行：带 `Range: bytes=0-N` 请求，收到 N 字节或连接结束即停。
 *
 * 定长很重要：不同大小的工作量没法横向比（改前改后必须跑同一份活）。
 */
function measureDownlink(ws, host, path, timeoutMs, bytes) {
  return new Promise((resolve) => {
    const want = bytes
    const req =
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n` +
      `Range: bytes=0-${want - 1}\r\n` +
      `User-Agent: cfpilot-tunnel-probe\r\n\r\n`
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
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
      const span = firstAt > 0 ? (lastAt - firstAt) / 1000 : 0
      const body = headSeen ? Math.max(0, received - headerBytes) : 0
      resolve({
        received,
        bodyBytes: body,
        seconds: Number(span.toFixed(3)),
        mbps: span > 0 ? body / 1024 / 1024 / span : 0,
        ...extra,
      })
    }
    const timer = setTimeout(() => finish({ wait: 'timeout' }), timeoutMs)
    ws.addEventListener('message', (ev) => {
      const chunk = new Uint8Array(ev.data)
      if (!headSeen) {
        const text = new TextDecoder().decode(chunk)
        const sep = text.indexOf('\r\n\r\n')
        if (sep < 0) return
        headSeen = true
        headerBytes = sep + 4
      }
      const now = Date.now()
      if (firstAt === 0) firstAt = now
      lastAt = now
      received += chunk.byteLength
      if (received - headerBytes >= want) finish({ stopped: 'reached-bytes' })
    })
    ws.addEventListener('close', (ev) => finish({ closeCode: ev.code }))
    ws.addEventListener('error', () => finish({ error: 'ws-error' }))
    ws.send(new TextEncoder().encode(req))
  })
}

function parseArgs(argv) {
  const out = { runs: 3, target: '', path: '/', get: '', bytes: 4 * 1024 * 1024 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') out.target = argv[++i] ?? ''
    else if (a === '--get') out.get = argv[++i] ?? ''
    else if (a === '--path') out.path = argv[++i] ?? '/'
    else if (a === '--runs') out.runs = Number(argv[++i] ?? 3)
    else if (a === '--bytes') out.bytes = Number(argv[++i] ?? 0) || 4 * 1024 * 1024
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const HELP = `
隧道复核与吞吐基线（只发请求，不改配置）

用法：
  node scripts/tunnel-probe.mjs --target <host:port> [--json]
  node scripts/tunnel-probe.mjs --get <host:port> [--path /x] [--bytes 4194304] [--runs 3]

参数：
  --target <host:port>   建隧道后发一次明文 GET，报告响应头耗时 / 关闭码 / 首包内容
  --get <host:port>      建隧道后按 Range 拉定长下行，测稳态吞吐（多轮取中位数）
  --path <p>             --get 的请求路径，默认 /
  --bytes <n>            --get 的字节数，默认 4 MiB（固定工作量，保证改前改后可比）
  --runs <n>             --get 的轮数，默认 3
  --json                 输出机器可读 JSON

环境：
  CFPILOT_WS     wss://<数据面域名><wsPath>
  CFPILOT_UUID   VLESS UUID（32 位十六进制）
  两者未设置时回退到 %TEMP%/cfpilot-tunnel.json
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (!args.target && !args.get)) {
    process.stdout.write(HELP)
    return
  }
  const params = loadTunnelParams()
  if (!params.wsUrl || !params.uuid) {
    process.stderr.write('缺少隧道参数：请设置 CFPILOT_WS 与 CFPILOT_UUID\n')
    process.exit(2)
  }

  let result
  if (args.target) {
    result = await runTarget(params, args.target)
  } else {
    result = await runDownload(params, args.get, args.path, args.runs, args.bytes)
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (args.target && !result.ok) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`失败：${err && err.message ? err.message : String(err)}\n`)
  process.exit(1)
})
