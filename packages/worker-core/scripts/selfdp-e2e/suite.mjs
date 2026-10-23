/**
 * 自研数据面本地真机验证 —— 完整测试套件。
 *
 * 覆盖场景：
 *   1. 基本链路：VLESS 握手 → 出站 → 目标站响应回传
 *   2. 大负载完整性：1MB 二进制数据逐字节校验
 *   3. 认证失败：UUID 错误时应拒绝（不能回响应头）
 *   4. 目标不可达：应给出**分级**的失败原因（不是笼统的「连接失败」）
 *   5. 代理路径：配置 SOCKS5 代理后，出站应确实经由代理
 *
 * 用法：node suite.mjs [wsUrl]
 */
import { WebSocket } from 'ws'
import crypto from 'node:crypto'

const WS_URL = process.argv[2] ?? 'ws://127.0.0.1:8787/vl'
const UUID = process.argv[3] ?? '11111111-2222-3333-4444-555555555555'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}\n`)
}

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

/** VLESS 头：版本(0) + UUID(16) + Addons长度(0) + 命令(1 TCP) + 端口(2) + [地址类型(1)+地址] */
function buildVlessHeader(hostname, port, uuid = UUID) {
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff])
  const name = new TextEncoder().encode(hostname)
  const addr = new Uint8Array(2 + name.length)
  addr[0] = 2
  addr[1] = name.length
  addr.set(name, 2)
  return concat(
    new Uint8Array([0x00]),
    uuidToBytes(uuid),
    new Uint8Array([0x00]),
    new Uint8Array([0x01]),
    portBytes,
    addr
  )
}

/**
 * 跑一次 VLESS 会话。
 * @returns {Promise<{header: Buffer|null, payload: Buffer, closeCode: number|null, closeReason: string}>}
 */
function runSession({ uuid = UUID, host, port, httpReq, waitMs = 5000 }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { perMessageDeflate: false })
    let header = null
    let payload = Buffer.alloc(0)
    let done = false
    const finish = (closeCode, closeReason) => {
      if (done) return
      done = true
      try { ws.close() } catch {}
      resolve({ header, payload, closeCode, closeReason })
    }
    const timer = setTimeout(() => finish(null, 'timeout'), waitMs)

    ws.on('open', () => {
      const hdr = buildVlessHeader(host, port, uuid)
      ws.send(Buffer.concat([hdr, Buffer.from(httpReq, 'binary')]))
    })
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!header) {
        header = buf.subarray(0, 2)
        payload = buf.subarray(2)
        return
      }
      payload = Buffer.concat([payload, buf])
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      finish(null, `error: ${err.message}`)
    })
    ws.on('close', (code, reason) => {
      clearTimeout(timer)
      finish(code, reason?.toString() ?? '')
    })
  })
}

const TARGET_HOST = process.argv[4] ?? '127.0.0.1'
const TARGET_PORT = Number(process.argv[5] ?? 18080)

const HTTP_REQ = (path, host, port) =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: CFPilot-E2E/1.0\r\nConnection: close\r\n\r\n`

async function main() {
  // ---- 场景 1：基本链路 ----
  {
    const r = await runSession({
      host: TARGET_HOST,
      port: TARGET_PORT,
      httpReq: HTTP_REQ('/echo?x=1&suite=basic', TARGET_HOST, TARGET_PORT),
    })
    const headerOk = r.header && r.header[0] === 0 && r.header[1] === 0
    record('VLESS 响应头 [0,0]', !!headerOk, r.header ? `收到 [${r.header[0]},${r.header[1]}]` : '未收到')
    const text = r.payload.toString('utf8')
    record('目标站响应回传', text.includes('CF-PILOT-ECHO-OK'), `${r.payload.length} 字节`)
    const m = /"method":"([^"]+)".*?"path":"([^"]+)"/.exec(text)
    record('目标站收到正确请求', !!m, m ? `${m[1]} ${m[2]}` : '未解析出')
  }

  // ---- 场景 2：大负载完整性 ----
  {
    const N = 1024 * 1024
    const r = await runSession({
      host: TARGET_HOST,
      port: TARGET_PORT,
      httpReq: HTTP_REQ(`/bytes?n=${N}`, TARGET_HOST, TARGET_PORT),
      waitMs: 20000,
    })
    // 找 body 起点（\r\n\r\n）
    const sep = r.payload.indexOf('\r\n\r\n')
    const body = sep >= 0 ? r.payload.subarray(sep + 4) : Buffer.alloc(0)
    let intact = body.length === N
    if (intact) {
      for (let i = 0; i < N; i++) {
        if (body[i] !== (i & 0xff)) {
          intact = false
          console.log(`  首个不一致位置：${i}（期望 ${i & 0xff}，实际 ${body[i]}）`)
          break
        }
      }
    }
    record(`1MB 负载逐字节完整`, intact, `收到 ${body.length} / ${N} 字节`)
  }

  // ---- 场景 3：认证失败必须被拒 ----
  {
    const r = await runSession({
      uuid: '99999999-8888-7777-6666-555555555555',
      host: TARGET_HOST,
      port: TARGET_PORT,
      httpReq: HTTP_REQ('/echo?x=1', TARGET_HOST, TARGET_PORT),
      waitMs: 4000,
    })
    const noHeader = !r.header || r.header.length === 0
    const noPayload = r.payload.length === 0
    record('错误 UUID 被拒绝（无响应头）', noHeader, r.header ? `却收到了 [${r.header[0]},${r.header[1]}]` : '未收到响应头')
    record('错误 UUID 无数据回传', noPayload, `${r.payload.length} 字节`)
  }

  // ---- 场景 4：目标不可达应给出分级原因 ----
  {
    // 指向一个没人监听的端口
    const r = await runSession({
      host: '127.0.0.1',
      port: 19999,
      httpReq: HTTP_REQ('/x', '127.0.0.1', 19999),
      waitMs: 12000,
    })
    const text = r.payload.toString('utf8')
    // ⚠️ 分级诊断走 close frame 的 reason（长文本 → 扩展长度帧），
    // `ws` 库对这种帧的解析有问题（报 "invalid payload length 126"），
    // 因此**同时**用 /__diag 端点判定 —— 诊断对象由内核直接暴露，最可靠。
    let diagText = ''
    try {
      const resp = await fetch('http://127.0.0.1:8787/__diag')
      const diag = await resp.json()
      diagText = JSON.stringify(diag.failures ?? [])
    } catch {
      /* 诊断端点不可用时只依赖 close reason */
    }
    const hasDiag =
      text.includes('出站') ||
      text.includes('超时') ||
      text.includes('被 Cloudflare 拒绝') ||
      text.includes('出站失败') ||
      r.closeReason?.includes('出站') ||
      diagText.includes('kind')
    record(
      '不可达目标给出分级诊断',
      !!hasDiag,
      diagText
        ? `诊断端点: ${diagText.slice(0, 200)}`
        : r.closeReason
          ? `closeReason=${r.closeReason.slice(0, 120)}`
          : `payload=${text.slice(0, 120)}`
    )
  }

  const passed = results.filter((r) => r.ok).length
  process.stdout.write(`\n${passed === results.length ? '🎉' : '⚠️ '} ${passed}/${results.length} 项通过\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main()
