/**
 * 用真实 Trojan 协议握手测试数据面（走 ws 库，能通过 Cloudflare 边缘）。
 *
 * 握手格式：SHA224(password) 的 hex(56 字节) + CRLF + [CMD][SOCKS5 addr] + CRLF
 *
 * 用法：node trojan-e2e.mjs <wsUrl> <password> <targetHost> <targetPort>
 */
import { WebSocket } from 'ws'
// Trojan 口令哈希 = SHA224(password) 的 hex。
// Node 的 crypto 不支持 SHA-224，项目用纯 TS 实现（src/protocols/sha224.ts），
// 这里通过构建产物引用（`npm run e2e:build` 生成）。
import { trojanPasswordHash } from './trojan-proto.mjs'

const WS_URL = process.argv[2]
const PASSWORD = process.argv[3]
const TARGET = process.argv[4]
const PORT = Number(process.argv[5])

function buildTrojanHandshake(password, host, port) {
  // ⚠️ Trojan 用的是 56 个 ASCII 十六进制字符，不是 28 字节二进制
  const hash = Buffer.from(trojanPasswordHash(password), 'utf8')
  const name = Buffer.from(host)
  const addr = Buffer.concat([
    Buffer.from([0x01, 0x03, name.length]), // CMD=TCP, ATYP=domain
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ])
  return Buffer.concat([hash, Buffer.from('\r\n'), addr, Buffer.from('\r\n')])
}

const ws = new WebSocket(WS_URL, { perMessageDeflate: false })
let got = 0

ws.on('open', () => {
  const hs = buildTrojanHandshake(PASSWORD, TARGET, PORT)
  ws.send(hs)
  console.log(`已发送 Trojan 握手 ${hs.length} 字节`)
  // 握手后再发一个明文 HTTP 请求（模拟客户端自己的 TLS 层）
  setTimeout(() => {
    ws.send(Buffer.from(`GET /get?via=trojan HTTP/1.1\r\nHost: ${TARGET}\r\nConnection: close\r\n\r\n`))
  }, 120)
})

ws.on('message', (d) => {
  got++
  const b = Buffer.isBuffer(d) ? d : Buffer.from(d)
  console.log(`消息${got}: ${b.length} 字节  ${b.subarray(0, 24).toString('hex')}`)
  const t = b.toString('utf8')
  if (t.includes('HTTP/1.1 200')) {
    console.log('✅ 收到目标站 HTTP 响应')
    console.log('   ' + t.split('\r\n').slice(0, 3).join(' | '))
  }
})

ws.on('error', (e) => console.log('error:', e.message.slice(0, 100)))
ws.on('close', (c, r) => {
  console.log(`close ${c}  共 ${got} 条消息  reason=${(r?.toString?.() || '').slice(0, 200)}`)
})
setTimeout(() => {
  console.log(`结束：共 ${got} 条消息`)
  process.exit(0)
}, 12000)
