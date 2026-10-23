/**
 * 用真实 VLESS 会话测试数据面出站（走 ws 库，能通过 Cloudflare 边缘）。
 *
 * 用法：node socks-real.mjs <wsUrl> <uuid> <targetHost> <targetPort> [rounds]
 *
 * 判定：收到目标站的 HTTP 200 且 body 含预期标记 → 出站成功。
 */
import { WebSocket } from 'ws'

const WS_URL = process.argv[2]
const UUID = process.argv[3]
const TARGET = process.argv[4]
const PORT = Number(process.argv[5])
const ROUNDS = Number(process.argv[6] ?? 3)

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

function buildHeader(host, port) {
  // 地址类型：1=IPv4，2=域名，4=IPv6
  let addr
  if (host.includes(':')) {
    const groups = host.split(':').filter(Boolean)
    const parts = new Uint8Array(16)
    for (let i = 0; i < 8; i++) {
      const g = groups[i] ? parseInt(groups[i].slice(0, 4), 16) || 0 : 0
      parts[i * 2] = (g >> 8) & 0xff
      parts[i * 2 + 1] = g & 0xff
    }
    addr = concat(new Uint8Array([4]), parts)
  } else {
    const n = new TextEncoder().encode(host)
    addr = new Uint8Array(2 + n.length)
    addr[0] = 2
    addr[1] = n.length
    addr.set(n, 2)
  }
  return concat(
    new Uint8Array([0x00]), // 版本
    uuidToBytes(UUID),
    new Uint8Array([0x00]), // Addons 长度
    new Uint8Array([0x01]), // 命令 = TCP
    new Uint8Array([(port >> 8) & 0xff, port & 0xff]),
    addr
  )
}

let ok = 0
for (let i = 0; i < ROUNDS; i++) {
  await new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { perMessageDeflate: false })
    let buf = Buffer.alloc(0)
    let gotHeader = false
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      resolve()
    }, 25000)
    ws.on('open', () => {
      // ⚠️ 必须带 Host 头：缺 Host 时目标站可能完全不响应
      const req = `GET /get?via=e2e HTTP/1.1\r\nHost: ${TARGET}\r\nUser-Agent: CFPilot-E2E\r\nConnection: close\r\n\r\n`
      ws.send(Buffer.concat([buildHeader(TARGET, PORT), Buffer.from(req, 'binary')]))
    })
    ws.on('message', (d) => {
      const b = Buffer.isBuffer(d) ? d : Buffer.from(d)
      if (!gotHeader) {
        gotHeader = true
        buf = b.subarray(2)
      } else {
        buf = Buffer.concat([buf, b])
      }
      const txt = buf.toString('utf8')
      if (txt.includes('HTTP/1.1 200')) {
        ok++
        console.log(`  ✅ 第${i + 1}次: 收到目标站响应 ${buf.length} 字节`)
        clearTimeout(timer)
        try {
          ws.close()
        } catch {}
        resolve()
      }
    })
    ws.on('error', (e) => {
      console.log(`  ❌ 第${i + 1}次 error: ${e.message.slice(0, 70)}`)
      clearTimeout(timer)
      resolve()
    })
    ws.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
console.log(`\n出站成功 ${ok}/${ROUNDS}`)
process.exit(ok === ROUNDS ? 0 : 1)
