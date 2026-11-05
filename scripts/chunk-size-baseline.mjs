#!/usr/bin/env node
/**
 * 数据块大小基准（只发请求，不改配置、不改内核）。
 *
 * ## 测什么
 *
 * 1. 下行：拉定长 4 MiB，统计**实际收到的 WS 帧大小分布**。
 *    Worker 的下行块来自上游 `readable.read()`，客户端无法控制，
 *    因此这里只观测（P50 / P95 + 16/32/64 KB 分桶），不据此调参。
 * 2. 上行：把固定 1 MiB 的 HTTP 请求体按 16 / 32 / 64 KB 切成 WS 帧发送，
 *    比较不同帧大小下的上行发送耗时与吞吐。工作量固定，改前改后可比。
 *
 * ## 参数
 *
 *   --instance <json>  实例信息文件（含 data.subdomain / uuid / wsPath）
 *   --out <file>       结果 JSON，默认 tmp/chunk-size-baseline.json
 *   --runs <n>         每个帧大小的轮数，默认 2
 *
 * 未指定 --instance 时从环境变量 CFPILOT_BASE / CFPILOT_WS_PATH / CFPILOT_UUID 读。
 */
import { readFileSync, writeFileSync } from 'node:fs'

function uuidBytes(text) {
  const hex = String(text).replace(/[^0-9a-fA-F]/g, '')
  const b = new Uint8Array(16)
  for (let i = 0; i < 16; i++) b[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return b
}

function encodeAddress(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split('.').map(Number)
    const a = new Uint8Array(5); a[0] = 1; a.set(p, 1); return a
  }
  const n = new TextEncoder().encode(host)
  const a = new Uint8Array(2 + n.length); a[0] = 2; a[1] = n.length; a.set(n, 2); return a
}

function hello(uuid, host, port) {
  const addr = encodeAddress(host)
  const b = new Uint8Array(21 + addr.length)
  b.set(uuidBytes(uuid), 1); b[18] = 1
  b[19] = (port >> 8) & 0xff; b[20] = port & 0xff
  b.set(addr, 21)
  return b
}

function parseArgs(argv) {
  const out = { instance: '', out: 'tmp/chunk-size-baseline.json', runs: 2 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--instance') out.instance = argv[++i] || ''
    else if (argv[i] === '--out') out.out = argv[++i] || out.out
    else if (argv[i] === '--runs') out.runs = Number(argv[++i]) || 2
  }
  return out
}

function loadParams(args) {
  if (args.instance) {
    const o = JSON.parse(readFileSync(args.instance, 'utf8'))
    return {
      base: String(o.data.subdomain).replace(/^https?:\/\//, '').replace(/\/$/, ''),
      wsPath: String(o.wsPath),
      uuid: String(o.uuid),
    }
  }
  const { CFPILOT_BASE, CFPILOT_WS_PATH, CFPILOT_UUID } = process.env
  if (CFPILOT_BASE && CFPILOT_WS_PATH && CFPILOT_UUID) {
    return {
      base: CFPILOT_BASE.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      wsPath: CFPILOT_WS_PATH,
      uuid: CFPILOT_UUID,
    }
  }
  return null
}

/** 打开隧道并等协议响应头 */
function openTunnel(wsUrl, uuid, host, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      reject(new Error('握手超时'))
    }, 10000)
    ws.addEventListener('open', () => ws.send(hello(uuid, host, port)))
    ws.addEventListener('message', (ev) => {
      if (settled) return
      if (new Uint8Array(ev.data).byteLength < 2) return
      settled = true
      clearTimeout(timer)
      resolve(ws)
    })
    ws.addEventListener('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('WS 失败')) } })
    ws.addEventListener('close', (ev) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`握手关闭 ${ev.code}`)) } })
  })
}

/** 下行：记录每一帧的大小 */
async function downlinkFrames(params, bytes = 4 * 1024 * 1024) {
  const ws = await openTunnel(`wss://${params.base}${params.wsPath}`, params.uuid, 'cachefly.cachefly.net', 80)
  const sizes = []
  return await new Promise((resolve) => {
    let received = 0
    let headSeen = false
    let headerBytes = 0
    let firstAt = 0
    let lastAt = 0
    let done = false
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      const sorted = [...sizes].sort((a, b) => a - b)
      const p = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0)
      resolve({
        received, frames: sizes.length, frameP50: p(0.5), frameP95: p(0.95),
        buckets: {
          under16K: sizes.filter((s) => s < 16 * 1024).length,
          '16to32K': sizes.filter((s) => s >= 16 * 1024 && s < 32 * 1024).length,
          '32to64K': sizes.filter((s) => s >= 32 * 1024 && s < 64 * 1024).length,
          '64Kplus': sizes.filter((s) => s >= 64 * 1024).length,
        },
        seconds: Number(((lastAt - firstAt) / 1000).toFixed(3)),
        mbps: lastAt > firstAt ? Number(((received - headerBytes) / 1024 / 1024 / ((lastAt - firstAt) / 1000)).toFixed(2)) : 0,
        ...extra,
      })
    }
    const timer = setTimeout(() => finish({ wait: 'timeout' }), 30000)
    ws.addEventListener('message', (ev) => {
      const c = new Uint8Array(ev.data)
      if (!headSeen) {
        const sep = new TextDecoder().decode(c).indexOf('\r\n\r\n')
        if (sep < 0) return
        headSeen = true
        headerBytes = sep + 4
      }
      sizes.push(c.byteLength)
      const now = Date.now()
      if (firstAt === 0) firstAt = now
      lastAt = now
      received += c.byteLength
      if (received - headerBytes >= bytes) finish({ stopped: 'reached-bytes' })
    })
    ws.addEventListener('close', (ev) => finish({ closeCode: ev.code }))
    ws.addEventListener('error', () => finish({ wait: 'ws-error' }))
    ws.send(new TextEncoder().encode(
      `GET /5mb.test HTTP/1.1\r\nHost: cachefly.cachefly.net\r\nConnection: close\r\n` +
      `Range: bytes=0-${bytes - 1}\r\nUser-Agent: cfpilot-chunk-baseline\r\n\r\n`
    ))
  })
}

/** 上行：固定 1 MiB 请求体，按 frameSize 切帧发送 */
async function uplinkFrames(params, frameSize, total = 1024 * 1024) {
  const ws = await openTunnel(`wss://${params.base}${params.wsPath}`, params.uuid, 'www.gstatic.com', 80)
  const head = new TextEncoder().encode(
    `POST / HTTP/1.1\r\nHost: www.gstatic.com\r\nConnection: close\r\n` +
    `Content-Length: ${total}\r\nUser-Agent: cfpilot-chunk-baseline\r\n\r\n`
  )
  const body = new Uint8Array(total).fill(0x61)
  const all = new Uint8Array(head.byteLength + body.byteLength)
  all.set(head, 0); all.set(body, head.byteLength)
  const frames = []
  for (let i = 0; i < all.byteLength; i += frameSize) frames.push(all.subarray(i, i + frameSize))

  return await new Promise((resolve) => {
    let done = false
    let firstResponseMs = null
    const t0 = Date.now()
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      // ⚠️ 口径：`ws.send()` 在客户端只是把帧放进本地队列，
      // 无法据此推算真实上行吞吐（那需要服务端回显确认）。
      // 这里只记录「按该帧大小把固定工作量全部入队的耗时」用于横向比较。
      resolve({ frameSize, frames: frames.length, enqueuedMs, firstResponseMs, ...extra })
    }
    const timer = setTimeout(() => finish({ wait: 'timeout' }), 30000)
    ws.addEventListener('message', () => { if (firstResponseMs === null) firstResponseMs = Date.now() - t0 })
    ws.addEventListener('close', (ev) => finish({ closeCode: ev.code }))
    ws.addEventListener('error', () => finish({ wait: 'ws-error' }))
    for (const f of frames) {
      if (ws.readyState !== 1) break
      ws.send(f)
    }
    const enqueuedMs = Date.now() - t0
    setTimeout(() => finish({ stopped: 'sent-all' }), 1000)
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const params = loadParams(args)
  if (!params) {
    process.stderr.write('缺少实例参数：--instance <json> 或 CFPILOT_BASE / CFPILOT_WS_PATH / CFPILOT_UUID\n')
    process.exit(2)
  }
  const report = { at: new Date().toISOString(), base: params.base, downlink: null, uplink: [] }
  process.stderr.write('下行帧分布 …\n')
  report.downlink = await downlinkFrames(params)
  for (const size of [16 * 1024, 32 * 1024, 64 * 1024]) {
    const runs = []
    for (let i = 0; i < args.runs; i++) {
      process.stderr.write(`上行帧 ${size / 1024} KB 第 ${i + 1} 轮 …\n`)
      runs.push(await uplinkFrames(params, size))
    }
    const vals = runs.map((r) => r.enqueuedMs).sort((a, b) => a - b)
    report.uplink.push({
      frameSize: size,
      runs,
      medianEnqueuedMs: vals.length ? vals[Math.floor(vals.length / 2)] : null,
    })
  }
  writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((err) => {
  process.stderr.write(`失败：${err && err.message ? err.message : String(err)}\n`)
  process.exit(1)
})
