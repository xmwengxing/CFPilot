/**
 * 自研数据面本地真机验证客户端。
 *
 * 完整走一遍真实链路：
 *   1. WebSocket 升级到自研数据面入口
 *   2. 发送 VLESS 握手头（UUID 认证 + 目标地址）
 *   3. 期望收到协议响应头 [0,0]（版本=0 加盐长度=0）
 *   4. 发送明文 HTTP 请求（目标是本地回显服务器）
 *   5. 校验回传的是目标站的真实响应
 *
 * 用法：node client.mjs [wsUrl] [targetHost] [targetPort] [httpPath]
 */
import { WebSocket } from 'ws'

const WS_URL = process.argv[2] ?? 'ws://127.0.0.1:8787/vl'
const TARGET_HOST = process.argv[3] ?? '127.0.0.1'
const TARGET_PORT = Number(process.argv[4] ?? 18080)
const HTTP_PATH = process.argv[5] ?? '/echo?x=1&from=vless'
const UUID = '11111111-2222-3333-4444-555555555555'

function uuidToBytes(uuid) {
  const clean = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

/** 构造 VLESS 请求头：版本(0) + UUID(16) + Addons长度(0) + 命令(1 TCP) + 端口(2) + 地址类型+地址 */
function buildVlessHeader(hostname, port) {
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff])
  // 地址类型 2 = 域名
  // ⚠️ 布局：[类型(1)] + [长度(1)] + [域名内容]
  //    长度字节不能被域名首字符覆盖（曾因此把 '1' 的 ASCII 0x31 当成长度，解析全错）
  const name = new TextEncoder().encode(hostname)
  const addr = new Uint8Array(2 + name.length)
  addr[0] = 2
  addr[1] = name.length
  addr.set(name, 2)
  return concat(
    new Uint8Array([0x00]),
    uuidToBytes(UUID),
    new Uint8Array([0x00]), // Addons 长度
    new Uint8Array([0x01]), // 命令 = TCP
    portBytes,
    addr
  )
}

const results = { ok: false, steps: [] }
function step(name, ok, detail = '') {
  results.steps.push({ name, ok, detail })
  process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}\n`)
}

const ws = new WebSocket(WS_URL, { perMessageDeflate: false })
let headerDone = false
let payload = Buffer.alloc(0)
const timeout = setTimeout(() => {
  step('整体超时', false, '60 秒内未完成')
  try { ws.close() } catch {}
  finish()
}, 60000)

function finish() {
  clearTimeout(timeout)
  const ok = results.ok
  process.stdout.write(`\n${ok ? '🎉' : '⚠️ '} 结果：${ok ? '通过' : '未通过'}\n`)
  process.exit(ok ? 0 : 1)
}

ws.on('open', () => {
  step('WebSocket 升级成功', true, WS_URL)
  const header = buildVlessHeader(TARGET_HOST, TARGET_PORT)
  const httpReq = `GET ${HTTP_PATH} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\nUser-Agent: CFPilot-SelfDP-E2E/1.0\r\nConnection: close\r\n\r\n`

  // ⚠️ 两个要点（均为本地 workerd 实测结论）：
  // ① 必须发**二进制**帧：文本帧（opcode 1）不会进入服务端 message 事件的二进制分支，
  //    服务端收不到任何字节（实测：文本帧 → 0 字节回传）。
  // ② VLESS 头与首包负载**合并成一个帧**发送。
  //    分两帧发会让 ws 库报 "Invalid WebSocket frame: invalid payload length 126"，
  //    但服务端其实已正确回传（原始 TCP 客户端可正常收到 [0,0] + 目标站响应）。
  //    真实客户端（Xray / mihomo）会把整个请求头 + 首包一次性发出，故按此模拟。
  const payload = Buffer.concat([header, Buffer.from(httpReq, 'binary')])
  step('发送 VLESS 握手头 + 首包', true, `${payload.length} 字节 → ${TARGET_HOST}:${TARGET_PORT}`)
  ws.send(payload)
})

ws.on('message', (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)

  if (!headerDone) {
    // 期望前两字节是 [0,0]
    if (buf.length < 2) {
      step('协议响应头不完整', false, `只收到 ${buf.length} 字节`)
      return
    }
    const version = buf[0]
    const addonsLen = buf[1]
    const ok = version === 0 && addonsLen === 0
    headerDone = true
    step('收到 VLESS 协议响应头', ok, `[${version},${addonsLen}]（期望 [0,0]）`)
    if (!ok) {
      try { ws.close() } catch {}
      return finish()
    }
    payload = buf.subarray(2)
  } else {
    payload = Buffer.concat([payload, buf])
  }

  // 判断是否拿到了完整的 HTTP 响应
  const text = payload.toString('utf8')
  if (text.includes('CF-PILOT-ECHO-OK')) {
    step('收到目标站真实响应', true, `共 ${payload.length} 字节`)
    step('响应含回显标记', true, 'CF-PILOT-ECHO-OK')
    try {
      const jsonStart = text.indexOf('{')
      if (jsonStart >= 0) {
        const body = JSON.parse(text.slice(jsonStart))
        step('目标站看到的请求', true, `${body.method} ${body.path} ${JSON.stringify(body.query)}`)
      }
    } catch {}
    results.ok = true
    try { ws.close() } catch {}
    return finish()
  }
})

ws.on('error', (err) => {
  step('WebSocket 错误', false, err.message)
  finish()
})

ws.on('close', (code, reason) => {
  if (!results.ok) {
    step('连接关闭', false, `code=${code} reason=${reason?.toString?.() ?? ''}`)
    process.stdout.write(`已收到字节数：${payload.length}\n`)
    if (payload.length > 0) {
      process.stdout.write(`原始内容(前 400)：\n${payload.subarray(0, 400).toString('utf8')}\n`)
    }
    finish()
  }
})
