/**
 * vendor vs self 同环境对照实验。
 *
 * ## 设计要点
 *
 * **交替采样**（A→B→A→B…）而不是「先测完 A 再测完 B」——
 * 后者会把「时段差异」（Cloudflare 边缘拦截的放行窗口、网络抖动）
 * 误判成「实现差异」。交替能让两者共享同一时间窗口。
 *
 * **两个目标站**：
 *   - 非 CF 网段（`neverssl.com` → `34.223.124.45`）：正常可达
 *   - 全 CF 网段（`example.com` → `172.66.147.243` / `104.20.23.154`）：必然被拒
 *     这一项专门检验「选路降权」的价值。
 *
 * 用法：node compare.mjs <round>
 */
import { WebSocket } from 'ws'
import { buildClientHello } from './clienthello.mjs'

const ROUNDS = Number(process.argv[2] ?? 6)

const INSTANCES = [
  {
    name: 'vendor',
    host: 'pbk0t4uc97.pages.dev',
    path: '/uta3b4jm7x',
    uuid: '1d2f5226-3493-4783-9c0f-fefb2483728e',
  },
  {
    name: 'self',
    host: process.env.SELF_HOST ?? 'qx9qfd88-96ca.pages.dev',
    path: process.env.SELF_PATH ?? '/hn1uk8ipax',
    uuid: process.env.SELF_UUID ?? 'a2a0104a-f1b7-4397-bc1a-3fb1ccabdd27',
  },
]

const MODE = process.argv[3] ?? 'plain'   // plain | tls

/** 真实 VLESS 客户端首包是 TLS ClientHello（22 03 ...）——vendor 用它判断是否 TLS */
function firstPacket(mode, host) {
  if (mode === 'tls') {
    // 真实 TLS ClientHello（手工构造，见 clienthello.mjs）。
    // 手写简化版会被目标站直接 RST，连回包都收不到，测不出真实差异。
    return buildClientHello(host)
  }
  return Buffer.from(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
}

// TLS 模式走 443（真实场景：客户端访问 HTTPS 站点，TLS 由客户端与目标站完成）
const TLS_PORT = 443
const TARGETS =
  MODE === 'tls'
    ? [
        // github.com → 20.205.243.166（微软，非 CF 网段）
        { name: '非CF网段', host: 'github.com', port: TLS_PORT },
        // example.com → 104.20.23.154 / 172.66.147.243（全 CF 网段）
        { name: '全CF网段', host: 'example.com', port: TLS_PORT },
      ]
    : [
        { name: '非CF网段', host: 'neverssl.com', port: 80 },
        { name: '全CF网段', host: 'example.com', port: 80 },
      ]

function uuidToBytes(u) {
  const c = u.replace(/-/g, '')
  const o = new Uint8Array(16)
  for (let i = 0; i < 16; i++) o[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16)
  return o
}

function concat(...p) {
  const t = p.reduce((s, x) => s + x.byteLength, 0)
  const o = new Uint8Array(t)
  let i = 0
  for (const x of p) {
    o.set(x, i)
    i += x.byteLength
  }
  return o
}

function buildHeader(host, port, uuid) {
  const n = new TextEncoder().encode(host)
  const addr = new Uint8Array(2 + n.length)
  addr[0] = 2
  addr[1] = n.length
  addr.set(n, 2)
  return concat(
    new Uint8Array([0x00]),
    uuidToBytes(uuid),
    new Uint8Array([0x00]),
    new Uint8Array([0x01]),
    new Uint8Array([(port >> 8) & 0xff, port & 0xff]),
    addr
  )
}

/** 单次会话：返回 upgrade / vlessHeader / httpResponse 三个布尔量 */
function once(inst, target, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const url = `wss://${inst.host}${inst.path}`
    let ws
    try {
      ws = new WebSocket(url, { perMessageDeflate: false })
    } catch {
      resolve({ upgrade: false, vless: false, http: false })
      return
    }
    const res = { upgrade: false, vless: false, http: false }
    let gotPayload = false
    let payloadBytes = 0
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      resolve(res)
    }, timeoutMs)
    ws.on('open', () => {
      res.upgrade = true
      const payload = Buffer.concat([
        buildHeader(target.host, target.port, inst.uuid),
        firstPacket(MODE, target.host),
      ])
      ws.send(payload)
    })
    ws.on('message', (d) => {
      const b = Buffer.isBuffer(d) ? d : Buffer.from(d)
      payloadBytes += b.length
      if (!gotPayload) {
        gotPayload = true
        if (b.length >= 2 && b[0] === 0 && b[1] === 0) res.vless = true
        if (b.toString('utf8').includes('HTTP/1.1')) res.http = true
        return
      }
      if (b.toString('utf8').includes('HTTP/1.1')) res.http = true
      // 「有回传数据」= 收到超过 2 字节（响应头本身）的载荷。
      // TLS 首包模式下看不到 HTTP 响应，但服务端回传了 TLS 握手响应
      //（ServerHello 或 Alert）就足以证明出站 TCP 链路已通且数据在流动。
      res.hasData = payloadBytes > 2
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(res)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      resolve(res)
    })
  })
}

async function main() {
  const tally = {}
  for (const inst of INSTANCES) {
    for (const target of TARGETS) {
      tally[`${inst.name}|${target.name}`] = { upgrade: 0, vless: 0, http: 0, data: 0, total: 0 }
    }
  }

  process.stdout.write(`对照实验：每实例每目标 ${ROUNDS} 轮，交替采样（首包模式：${MODE}）\n\n`)
  for (let r = 0; r < ROUNDS; r++) {
    for (const inst of INSTANCES) {
      for (const target of TARGETS) {
        const res = await once(inst, target)
        const k = `${inst.name}|${target.name}`
        tally[k].total++
        if (res.upgrade) tally[k].upgrade++
        if (res.vless) tally[k].vless++
        if (res.http) tally[k].http++
        if (res.hasData) tally[k].data++
      }
    }
    process.stdout.write(`第 ${r + 1}/${ROUNDS} 轮完成\n`)
  }

  console.log('\n===== 对照结果 =====')
  for (const target of TARGETS) {
    console.log(`\n目标：${target.name}（${target.host}:${target.port}）`)
    for (const inst of INSTANCES) {
      const t = tally[`${inst.name}|${target.name}`]
      const pct = (n) => (t.total ? Math.round((n / t.total) * 100) : 0)
      console.log(
        `  ${inst.name.padEnd(7)} WS升级 ${pct(t.upgrade)}% (${t.upgrade}/${t.total})` +
          `  VLESS[0,0] ${pct(t.vless)}% (${t.vless}/${t.total})` +
          `  真实HTTP ${pct(t.http)}% (${t.http}/${t.total})` +
          `  有回传数据 ${pct(t.data)}% (${t.data}/${t.total})`
      )
    }
  }
  console.log('\n(说明：真实 HTTP 的分母含 CF 网段目标 —— 那一列全 0 是预期行为)')
}

main()
