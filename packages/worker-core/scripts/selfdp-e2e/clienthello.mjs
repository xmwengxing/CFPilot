/**
 * 构造一个**最小但合法**的 TLS ClientHello。
 *
 * ## 为什么不用 Node 的 tls 模块去抓
 *
 * Node 的 TLS 握手在 OpenSSL（C++ 层）完成，握手包不经过 JS 的
 * `socket.write()`，无法拦截。
 *
 * ## 为什么要真实 ClientHello
 *
 * vendor（CFNext）只看客户端首包的头两个字节判断是不是 TLS：
 * `22 03` = TLS handshake record。
 * 只有首包是 TLS，vendor 才启用它的优选候选路径。
 * 而**手写的简化版会被目标站直接 RST**（连回包都没有），
 * 那样测不出两个实现的真实差异。
 *
 * 本文件按 RFC 8446 §5.1 手工拼一个最小 ClientHello：
 * 无扩展、无会话恢复、单一密码套件。目标站会正常回 ServerHello，
 * 哪怕后续握手失败，也至少回了 TLS Alert —— 足以证明链路通。
 */
import crypto from 'node:crypto'

export function buildClientHello(serverName) {
  const random = crypto.randomBytes(32)

  // --- 扩展 ---
  const exts = []
  if (serverName) {
    // server_name 扩展 (0x0000)
    const name = Buffer.from(serverName, 'utf8')
    const entry = Buffer.concat([
      Buffer.from([0x00]), // type = host_name
      Buffer.from([0x00, name.length]), // length
      name,
    ])
    const body = Buffer.concat([Buffer.from([0x00, 0x00]), Buffer.from([0x00, entry.length]), entry])
    exts.push(body)
  }
  // supported_versions (0x002b) → TLS 1.2 / 1.3
  exts.push(
    Buffer.concat([
      Buffer.from([0x00, 0x2b]),
      Buffer.from([0x00, 0x05, 0x04, 0x03, 0x04, 0x03, 0x03]),
    ])
  )
  // ec_point_formats (0x000b) → uncompressed
  exts.push(Buffer.concat([Buffer.from([0x00, 0x0b, 0x00, 0x02, 0x01, 0x00])]))
  const extensions = Buffer.concat(exts)
  const extensionsBuf = Buffer.concat([
    Buffer.from([(extensions.length >> 8) & 0xff, extensions.length & 0xff]),
    extensions,
  ])

  // --- body ---
  const cipherSuites = Buffer.from([0x13, 0x01, 0x13, 0x02, 0x13, 0x03, 0xc0, 0x2f])
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // legacy_version = TLS 1.2
    random,
    Buffer.from([0x00]), // session_id length
    Buffer.from([(cipherSuites.length >> 8) & 0xff, cipherSuites.length & 0xff]),
    cipherSuites,
    Buffer.from([0x01, 0x00]), // compression_methods = null
    extensionsBuf,
  ])

  // --- handshake ---
  const handshake = Buffer.concat([
    Buffer.from([0x01]), // client_hello
    Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ])

  // --- record ---
  return Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01]), // handshake record, TLS 1.0
    Buffer.from([(handshake.length >> 8) & 0xff, handshake.length & 0xff]),
    handshake,
  ])
}
