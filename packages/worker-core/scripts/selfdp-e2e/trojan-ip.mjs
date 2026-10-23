// 用「优选 IP + SNI 域名」连接（用户订阅节点的真实形态）
import tls from 'node:tls'
import crypto from 'node:crypto'
import { trojanPasswordHash } from './trojan-proto.mjs'

const IP = process.argv[2], SNI = process.argv[3], PATHNAME = process.argv[4]
const PASSWORD = process.argv[5], TARGET = process.argv[6], PORT = Number(process.argv[7])

function buildHandshake(password, host, port) {
  const hash = Buffer.from(trojanPasswordHash(password), 'utf8')
  const name = Buffer.from(host)
  const addr = Buffer.concat([Buffer.from([0x01,0x03,name.length]), name, Buffer.from([(port>>8)&0xff, port&0xff])])
  return Buffer.concat([hash, Buffer.from('\r\n'), addr, Buffer.from('\r\n')])
}
function frame(p) {
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(p.map((b,i)=>b^mask[i%4]))
  const L = masked.length
  let h
  if (L < 126) h = Buffer.from([0x82, 0x80|L])
  else { h = Buffer.alloc(4); h[0]=0x82; h[1]=0x80|126; h.writeUInt16BE(L,2) }
  return Buffer.concat([h, mask, masked])
}
const sock = tls.connect({host: IP, port: 443, servername: SNI, rejectUnauthorized: false}, () => {
  const key = crypto.randomBytes(16).toString('base64')
  sock.write(`GET ${PATHNAME} HTTP/1.1\r\nHost: ${SNI}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`)
})
let buf = Buffer.alloc(0), hs = false
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  if (!hs) {
    const i = buf.indexOf('\r\n\r\n'); if (i<0) return
    hs = true
    const st = buf.subarray(0,i).toString().split('\r\n')[0]
    console.log('握手:', st)
    if (!st.includes('101')) { sock.destroy(); process.exit(0) }
    buf = buf.subarray(i+4)
    sock.write(frame(buildHandshake(PASSWORD, TARGET, PORT)))
    setTimeout(() => {
      console.log('收到字节数:', buf.length)
      let off=0
      while (off+2<=buf.length) {
        const b0=buf[off],b1=buf[off+1]; const op=b0&0x0f; let L=b1&0x7f, hl=2
        if (L===126){L=buf.readUInt16BE(off+2);hl=4} else if(L===127){L=Number(buf.readBigUInt64BE(off+2));hl=10}
        const data=buf.subarray(off+hl,off+hl+L)
        console.log(`帧 opcode=${op} len=${L} 数据=${JSON.stringify(data.toString('utf8').slice(0,120))}`)
        off+=hl+L
      }
      sock.destroy(); process.exit(0)
    }, 8000)
  }
})
sock.on('error', e => { console.log('错误:', e.message); process.exit(0) })
