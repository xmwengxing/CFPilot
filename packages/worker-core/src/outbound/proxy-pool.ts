/**
 * 出站代理池解析（纯字符串处理，不依赖 `cloudflare:sockets`）
 *
 * 单独成模块的原因：`dial.ts` 里引用了 `cloudflare:sockets`，而 Worker 的启动图越小越稳。
 * 把「解析配置」和「真正拨号」拆开后，路由层与配置层不再把 sockets 拖进启动图，
 * sockets 只在真正建立连接时才被动态加载。
 */

export type ProxyKind = 'direct' | 'socks5' | 'http' | 'https'

export interface ProxyEndpoint {
  host: string
  port: number
  kind: ProxyKind
  username?: string
  password?: string
  /**
   * TLS 握手用的 SNI / 主机名校验名（仅 `kind: 'https'` 有意义）。
   *
   * 为什么要单独一个字段：代理地址常写成 IP，但**证书是给域名签的**。
   * Cloudflare 边缘做 TLS 握手时会校验证书链**并**校验主机名，
   * 用 IP 连接必然失败（自签证书更是直接被拒：
   * 「remote error: tls: unknown certificate authority」）。
   *
   * 解析来源：URL 的 host 部分若是域名就用它；
   * 显式写法见 `parseProxyEntry` 的 `#sni=` 后缀。
   */
  serverName?: string
}

/**
 * 解析单条代理条目：支持 `socks5://host:port`、`http://host:port`、`https://host:port`、`host:port`。
 *
 * `defaultKind` 决定**没有协议前缀**的裸 `host:port` 怎么解释：
 *   - 用于 PROXYIP 配置时应传 'direct'（BPB / edgetunnel 的 ProxyIP 语义是
 *     「连到这个地址并复用其 SNI 落到目标」，不是 SOCKS5 握手）
 *   - 用于 SOCKS5 配置时应传 'socks5'
 *
 * `https://` 与 `http://` 的区别：代理服务器本身走 TLS
 * （需 `connect({secureTransport:'on'})`），而不是明文 CONNECT。
 * 这是 edgetunnel 支持、CFNext（vendor）不支持的类型。
 */
export function parseProxyEntry(entry: string, defaultKind: ProxyKind = 'direct'): ProxyEndpoint | null {
  const text = entry.trim()
  if (!text) return null
  let kind = defaultKind
  let rest = text
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(text)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    rest = text.slice(schemeMatch[0].length)
    if (scheme === 'socks5' || scheme === 'socks' || scheme === 'socks5h') kind = 'socks5'
    else if (scheme === 'https') kind = 'https'
    else if (scheme === 'http') kind = 'http'
  }
  const at = rest.lastIndexOf('@')
  let credentials: { username?: string; password?: string } = {}
  if (at >= 0) {
    const cred = rest.slice(0, at)
    rest = rest.slice(at + 1)
    const idx = cred.indexOf(':')
    if (idx >= 0) {
      credentials = { username: cred.slice(0, idx), password: cred.slice(idx + 1) }
    } else {
      credentials = { username: cred }
    }
  }
  // `#sni=example.com` 显式指定 TLS 握手用的 SNI（与 URL 的 fragment 语法一致）
  let serverName: string | undefined
  const sniMatch = /#sni=([^/#]+)/i.exec(rest)
  if (sniMatch) {
    serverName = sniMatch[1]!.trim()
    rest = rest.slice(0, sniMatch.index) + rest.slice(sniMatch.index + sniMatch[0].length)
  }
  const portIndex = rest.lastIndexOf(':')
  if (portIndex < 0) return null
  const host = rest.slice(0, portIndex).replace(/^\[|\]$/g, '')
  const port = Number(rest.slice(portIndex + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  // 域名形式的 host 本身就是 SNI（IP 不行 —— 证书是签给域名的）
  if (!serverName && kind === 'https' && !isIpv4Literal(host)) {
    serverName = host
  }
  return { host, port, kind, ...credentials, ...(serverName ? { serverName } : {}) }
}

/** 主机是否是 IPv4 字面量（不是域名） */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** 解析代理池文本（换行 / 逗号 / 分号分隔） */
export function parseProxyPool(text: string, defaultKind: ProxyKind = 'direct'): ProxyEndpoint[] {
  const out: ProxyEndpoint[] = []
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim()
    if (!entry) continue
    const parsed = parseProxyEntry(entry, defaultKind)
    if (parsed) out.push(parsed)
  }
  return out
}
