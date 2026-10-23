import { WebSocket } from 'ws'
import { buildClientHello } from './clienthello.mjs'
function uuidToBytes(u){const c=u.replace(/-/g,'');const o=new Uint8Array(16);for(let i=0;i<16;i++)o[i]=parseInt(c.slice(i*2,i*2+2),16);return o}
function concat(...p){const t=p.reduce((s,x)=>s+x.byteLength,0);const o=new Uint8Array(t);let i=0;for(const x of p){o.set(x,i);i+=x.byteLength}return o}
function hdr(host,port){const n=new TextEncoder().encode(host);const a=new Uint8Array(2+n.length);a[0]=2;a[1]=n.length;a.set(n,2);
  return concat(new Uint8Array([0]),uuidToBytes('11111111-2222-3333-4444-555555555555'),new Uint8Array([0]),new Uint8Array([1]),new Uint8Array([(port>>8)&0xff,port&0xff]),a)}
const HOST = process.argv[2], PORT = Number(process.argv[3])
const ws = new WebSocket('ws://127.0.0.1:8787/vl', {perMessageDeflate:false})
let total = 0
ws.on('open', () => {
  const payload = Buffer.concat([hdr(HOST, PORT), buildClientHello(HOST)])
  ws.send(payload)
})
ws.on('message', (d) => { const b=Buffer.isBuffer(d)?d:Buffer.from(d); total+=b.length
  console.log('收到', b.length, '字节:', b.subarray(0,20).toString('hex')) })
ws.on('error', e => console.log('错误:', e.message))
ws.on('close', (c,r) => console.log('close', c, r?.toString?.().slice(0,200)))
setTimeout(async () => {
  console.log('总回传字节:', total)
  try {
    const r = await fetch('http://127.0.0.1:8787/__diag')
    const j = await r.json()
    console.log('诊断:', JSON.stringify(j.failures, null, 1))
  } catch(e) { console.log('诊断端点失败', e.message) }
  process.exit(0)
}, 12000)
