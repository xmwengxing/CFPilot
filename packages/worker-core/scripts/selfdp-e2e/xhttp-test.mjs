// 测 XHTTP 入站：POST + VLESS 头 + 负载
import { WebSocket } from 'ws'
const URL = process.argv[2], UUID = process.argv[3], TARGET = process.argv[4], PORT = Number(process.argv[5])
function uuidToBytes(u){const c=u.replace(/-/g,'');const o=new Uint8Array(16);for(let i=0;i<16;i++)o[i]=parseInt(c.slice(i*2,i*2+2),16);return o}
function concat(...p){const t=p.reduce((s,x)=>s+x.byteLength,0);const o=new Uint8Array(t);let i=0;for(const x of p){o.set(x,i);i+=x.byteLength}return o}
// 目标是 IP 就用 addressType=1，域名用 type=2
const isIp=/^\d+\.\d+\.\d+\.\d+$/.test(TARGET)
const n=Buffer.from(TARGET)
const addr=isIp
  ? Buffer.concat([Buffer.from([1]), Buffer.from(TARGET.split('.').map(Number))])
  : Buffer.concat([Buffer.from([2,n.length]),n])
const hdr=concat(new Uint8Array([0]),uuidToBytes(UUID),new Uint8Array([0]),new Uint8Array([1]),new Uint8Array([(PORT>>8)&0xff,PORT&0xff]),addr)
const body=concat(hdr,Buffer.from(`GET /echo?via=xhttp HTTP/1.1\r\nHost: ${TARGET}\r\nConnection: close\r\n\r\n`))
const r = await fetch(URL, { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body })
console.log('状态:', r.status)
console.log('响应头:', JSON.stringify(Object.fromEntries(r.headers)))
// SSE 是流式的，必须流式读取
const reader = r.body.getReader()
const dec = new TextDecoder()
let text = ''
const t = setTimeout(() => { try { reader.cancel() } catch {} }, 12000)
try {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
    if (text.length > 1200) break
  }
} catch {}
clearTimeout(t)
console.log('响应体长度:', text.length)
console.log('前 600 字符:\n' + text.slice(0, 600))
