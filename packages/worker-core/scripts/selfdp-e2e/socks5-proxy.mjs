/**
 * 最小 SOCKS5 代理（无认证），用于验证自研数据面的代理落地路径。
 *
 * 只实现 CONNECT：收到 CONNECT 请求后连到目标，转发双向数据。
 * 记录连接次数，便于断言「出站确实经由代理」。
 */
import net from 'node:net'

const PORT = Number(process.env.SOCKS_PORT || 11080)
let connectCount = 0
const targets = []

const server = net.createServer((client) => {
  let stage = 'greeting'
  let targetHost = ''
  let targetPort = 0
  let upstream = null
  let buf = Buffer.alloc(0)

  client.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])

    if (stage === 'greeting') {
      if (buf.length < 2) return
      const nmethods = buf[1]
      if (buf.length < 2 + nmethods) return
      const methods = buf.subarray(2, 2 + nmethods)
      buf = buf.subarray(2 + nmethods)
      if (!methods.includes(0x00)) {
        client.end(Buffer.from([0x05, 0xff]))
        return
      }
      client.write(Buffer.from([0x05, 0x00]))
      stage = 'request'
    }

    if (stage === 'request' && buf.length >= 4) {
      const ver = buf[0]
      const cmd = buf[1]
      const atyp = buf[3]
      // 需要读满：4 字节头 + 地址 + 2 字节端口
      let addrLen = 0
      if (atyp === 0x01) addrLen = 4
      else if (atyp === 0x03) {
        if (buf.length < 5) return
        addrLen = buf[4]
      } else if (atyp === 0x04) addrLen = 16
      else {
        client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }
      const need = 4 + addrLen + 2
      if (buf.length < need) return

      if (atyp === 0x01) {
        targetHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
        targetPort = buf.readUInt16BE(8)
      } else if (atyp === 0x03) {
        const len = buf[4]
        targetHost = buf.subarray(5, 5 + len).toString('utf8')
        targetPort = buf.readUInt16BE(5 + len)
      } else {
        targetHost = buf.subarray(4, 20).toString('hex')
        targetPort = buf.readUInt16BE(20)
      }
      // 只消费掉本次请求的字节，剩下的（可能已带首包）留给 tunnel 阶段
      buf = buf.subarray(need)

      if (ver !== 0x05 || cmd !== 0x01) {
        client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }

      connectCount++
      targets.push(`${targetHost}:${targetPort}`)
      process.stdout.write(`[socks5] CONNECT #${connectCount} → ${targetHost}:${targetPort}\n`)

      upstream = net.connect(targetPort, targetHost, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        stage = 'tunnel'
        process.stdout.write(`[socks5] 隧道建立，待转发 ${buf.length} 字节\n`)
        if (buf.length > 0) upstream.write(buf)
        buf = Buffer.alloc(0)
      })
      upstream.on('data', (d) => {
        process.stdout.write(`[socks5] 隧道 ← 目标 ${d.length} 字节\n`)
        client.write(d)
      })
      upstream.on('error', () => client.end())
    }

    if (stage === 'tunnel' && upstream && buf.length > 0) {
      process.stdout.write(`[socks5] 隧道数据 → 目标 ${buf.length} 字节\n`)
      upstream.write(buf)
      buf = Buffer.alloc(0)
    }
  })

  client.on('close', () => upstream?.destroy())
  client.on('error', () => upstream?.destroy())
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[socks5] 代理已启动: 127.0.0.1:${PORT}\n`)
})

// 计数端点：便于脚本断言「出站确实经过代理」
process.on('SIGTERM', () => process.exit(0))
process.stdout.write(`[socks5] 累计 CONNECT 次数初始为 ${connectCount}\n`)
