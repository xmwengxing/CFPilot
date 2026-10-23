import { WebSocket } from 'ws'
import { buildClientHello } from './clienthello.mjs'
function uuidToBytes(u){const c=u.replace(/-/g,'');const o=new Uint8Array(16);for(let i=0;i<16;i++)o[i]=parseInt(c.slice(i*2,i*2+2),16);return o}
function concat(...p){const t=p.reduce((s,x)=>s+x.byteLength,0);const o=new Uint8Array(t);let i=0;for(const x of p){o.set(x,i);i+=x.byteLength}return o}
const URL=process.argv[2],UUID=process.argv[3],HOST=process.argv[4],PORT=Number(process.argv[5])
// 地址类型：1=IPv4，2=域名，4=IPv6
let a
if (HOST.includes(':')) {
  // IPv6 字面量（VLESS 地址类型 4）：16 字节，每组 2 字节大端
  const groups = HOST.split(':').filter(Boolean)
  const parts = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ? (parseInt(groups[i].slice(0, 4), 16) || 0) : 0
    parts[i*2] = (g >> 8) & 0xff
    parts[i*2+1] = g & 0xff
  }
  a = concat(new Uint8Array([4]), parts)
} else {
  const n = new TextEncoder().encode(HOST)
  a = new Uint8Array(2 + n.length)
  a[0] = 2
  a[1] = n.length
  a.set(n, 2)
}
const hdr=concat(new Uint8Array([0]),uuidToBytes(UUID),new Uint8Array([0]),new Uint8Array([1]),new Uint8Array([(PORT>>8)&0xff,PORT&0xff]),a)
const ws=new WebSocket(URL,{perMessageDeflate:false}); let msgs=0
ws.on('open',()=>ws.send(Buffer.concat([
    hdr,
    // ⚠️ 必须带 Host 头：真实客户端都会带。
    // 缺 Host 时目标站可能直接不响应（实测：baidu 无响应、httpbin 宽容）。
    Buffer.from(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: CFPilot-E2E\r\nConnection: close\r\n\r\n`),
  ])))
ws.on('message',(d)=>{msgs++;const b=Buffer.isBuffer(d)?d:Buffer.from(d);console.log(`  消息${msgs}: ${b.length} 字节 ${b.subarray(0,12).toString('hex')}`)})
ws.on('error',e=>console.log('  error:',e.message.slice(0,60)))
ws.on('close',(c,r)=>console.log(`  close ${c} ${(r?.toString?.()||'').slice(0,80)}`))
setTimeout(()=>{console.log(`  共 ${msgs} 条消息`);process.exit(0)},15000)
