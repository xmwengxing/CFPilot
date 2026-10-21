/**
 * 出站代理池解析（纯字符串处理，不依赖 `cloudflare:sockets`）
 *
 * 单独成模块的原因：`dial.ts` 里引用了 `cloudflare:sockets`，而 Worker 的启动图越小越稳。
 * 把「解析配置」和「真正拨号」拆开后，路由层与配置层不再把 sockets 拖进启动图，
 * sockets 只在真正建立连接时才被动态加载。
 */

export type ProxyKind = 'socks5' | 'http'

export interface ProxyEndpoint {
  host: string
  port: number
  kind: ProxyKind
  username?: string
  password?: string
}

/** 解析单条代理条目：支持 `socks5://host:port`、`http://host:port`、`host:port` */
export function parseProxyEntry(entry: string, defaultKind: ProxyKind = 'socks5'): ProxyEndpoint | null {
  const text = entry.trim()
  if (!text) return null
  let kind = defaultKind
  let rest = text
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(text)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    rest = text.slice(schemeMatch[0].length)
    if (scheme === 'socks5' || scheme === 'socks' || scheme === 'socks5h') kind = 'socks5'
    else if (scheme === 'http' || scheme === 'https') kind = 'http'
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
  const portIndex = rest.lastIndexOf(':')
  if (portIndex < 0) return null
  const host = rest.slice(0, portIndex).replace(/^\[|\]$/g, '')
  const port = Number(rest.slice(portIndex + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port, kind, ...credentials }
}

/** 解析代理池文本（换行 / 逗号 / 分号分隔） */
export function parseProxyPool(text: string, defaultKind: ProxyKind = 'socks5'): ProxyEndpoint[] {
  const out: ProxyEndpoint[] = []
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim()
    if (!entry) continue
    const parsed = parseProxyEntry(entry, defaultKind)
    if (parsed) out.push(parsed)
  }
  return out
}
