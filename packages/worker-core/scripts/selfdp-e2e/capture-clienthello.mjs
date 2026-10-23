/**
 * 抓取一个**真实的 TLS ClientHello** 字节序列。
 *
 * ## 为什么需要
 *
 * vendor（CFNext）用客户端首包的头两个字节判断「是不是 TLS」：
 *
 * ```js
 * function jt(t){ return !t||t.byteLength<3 ? "unknown" : 22===t[0]&&3===t[1] ? "tls" : "nontls" }
 * ```
 *
 * `22 03` = TLS handshake record。只有客户端首包是 TLS 时，
 * vendor 才启用它的优选候选路径（走 `proxyip.*.cmliussss.net`）。
 *
 * 所以要对照「真实客户端场景」，必须发一个**合法**的 ClientHello ——
 * 手写的简化版会被目标站直接 RST，连回包都收不到，测不出真实表现。
 *
 * 用法：node capture-clienthello.mjs <host> <port> > clienthello.bin
 */
import tls from 'node:tls'
import net from 'node:net'

const HOST = process.argv[2] ?? 'neverssl.com'
const PORT = Number(process.argv[3] ?? 443)

// 拦截底层 socket 的第一次写入 —— 那就是 ClientHello
let captured = null
const origWrite = net.Socket.prototype.write
net.Socket.prototype.write = function (chunk, ...rest) {
  if (captured === null && chunk && chunk.length > 40) {
    captured = Buffer.from(chunk)
    // 立刻断开，避免真的完成握手
    setImmediate(() => {
      try {
        this.destroy()
      } catch {}
    })
  }
  return origWrite.call(this, chunk, ...rest)
}

const sock = tls.connect(
  { host: HOST, port: PORT, servername: HOST, rejectUnauthorized: false },
  () => {}
)

sock.on('error', () => {})

setTimeout(() => {
  net.Socket.prototype.write = origWrite
  if (!captured) {
    process.stderr.write('未捕获到 ClientHello\n')
    process.exit(1)
  }
  process.stderr.write(
    `已捕获 ClientHello：${captured.length} 字节，头两字节 0x${captured[0].toString(16)} 0x${captured[1].toString(16)}\n`
  )
  process.stdout.write(captured)
  process.exit(0)
}, 2500)
