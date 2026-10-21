/**
 * 出站拨号：
 *  - 直连（可选 NAT64 兜底）
 *  - ProxyIP / SOCKS5 / HTTP 代理池故障转移
 *  - TCP_CONCURRENT_DIAL 并发竞速
 */
import { connect } from 'cloudflare:sockets'
import { socks5Connect } from './socks5'
import { httpConnect } from './http-proxy'
import { isIpv4 } from '../protocols/address'

export type ProxyKind = 'socks5' | 'http'

export interface ProxyEndpoint {
  host: string
  port: number
  kind: ProxyKind
  username?: string
  password?: string
}

export interface DialOptions {
  hostname: string
  port: number
  /** 代理池（ProxyIP / SOCKS5 / HTTP 混合），非空时优先使用 */
  proxies?: ProxyEndpoint[]
  /** NAT64 前缀，例如 64:ff9b:: */
  nat64?: string
  /** 并发竞速拨号 */
  concurrent?: boolean
  /** 单次连接超时（ms） */
  timeoutMs?: number
}

export interface DialResult {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  via: 'direct' | 'nat64' | 'socks5' | 'http'
  /** 实际连接到的落地地址（代理场景为代理地址） */
  endpoint: string
}

const DEFAULT_TIMEOUT_MS = 8000

/** 解析代理条目：支持 `socks5://host:port`、`http://host:port`、`host:port` */
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

/** 解析代理池文本（换行 / 逗号 / 空格分隔） */
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

/** IPv4 → NAT64 合成地址 */
export function nat64Address(ipv4: string, prefix: string): string | null {
  if (!isIpv4(ipv4)) return null
  const parts = ipv4.split('.').map((p) => Number(p))
  const high = ((parts[0]! << 8) | parts[1]!).toString(16)
  const low = ((parts[2]! << 8) | parts[3]!).toString(16)
  const clean = prefix.replace(/:+$/, '')
  return `${clean}::${high}:${low}`
}

interface SocketLike {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  /** 建连成功时 resolve；失败时 reject */
  readonly opened: Promise<unknown>
  close(): Promise<void>
}

/**
 * 建立 TCP 连接并等待握手完成。
 *
 * Workers 的 `connect()` 是同步返回 socket 的，真正建连的结果在 `socket.opened`
 * （成功）/ `socket.closed`（失败）上，因此这里要等 `opened` 而不是等一个 Promise。
 */
async function connectWithTimeout(
  hostname: string,
  port: number,
  timeoutMs: number
): Promise<SocketLike> {
  const socket = connect({ hostname, port }) as unknown as SocketLike
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`连接超时：${hostname}:${port}`)), timeoutMs)
  })
  try {
    await Promise.race([socket.opened, timeout])
    return socket
  } catch (err) {
    // 超时或失败后立即关闭，避免 socket 泄漏
    try {
      await socket.close()
    } catch {
      /* 已关闭 */
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 直连（含 NAT64 兜底） */
async function dialDirect(options: DialOptions): Promise<DialResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const socket = await connectWithTimeout(options.hostname, options.port, timeoutMs)
    return {
      readable: socket.readable,
      writable: socket.writable,
      via: 'direct',
      endpoint: `${options.hostname}:${options.port}`,
    }
  } catch (err) {
    if (options.nat64 && isIpv4(options.hostname)) {
      const synthesized = nat64Address(options.hostname, options.nat64)
      if (synthesized) {
        const socket = await connectWithTimeout(synthesized, options.port, timeoutMs)
        return {
          readable: socket.readable,
          writable: socket.writable,
          via: 'nat64',
          endpoint: `${synthesized}:${options.port}`,
        }
      }
    }
    throw err
  }
}

/** 通过代理池落地 */
async function dialViaProxy(
  options: DialOptions,
  proxy: ProxyEndpoint
): Promise<DialResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const socket = await connectWithTimeout(proxy.host, proxy.port, timeoutMs)
  try {
    if (proxy.kind === 'http') {
      const readable = await httpConnect(socket.readable, socket.writable, options.hostname, options.port)
      return {
        readable,
        writable: socket.writable,
        via: 'http',
        endpoint: `${proxy.host}:${proxy.port}`,
      }
    }
    const readable = await socks5Connect(socket.readable, socket.writable, options.hostname, options.port, {
      username: proxy.username,
      password: proxy.password,
    })
    return {
      readable,
      writable: socket.writable,
      via: 'socks5',
      endpoint: `${proxy.host}:${proxy.port}`,
    }
  } catch (err) {
    try {
      await socket.close()
    } catch {
      /* 已关闭 */
    }
    throw err
  }
}

/** 并发竞速：多个候选同时拨号，取最先成功者 */
async function raceDial(
  attempts: Array<() => Promise<DialResult>>,
  concurrent: boolean
): Promise<DialResult> {
  if (attempts.length === 0) throw new Error('没有可用的出站拨号方式')
  if (attempts.length === 1 || !concurrent) {
    let lastError: unknown = new Error('拨号失败')
    for (const attempt of attempts) {
      try {
        return await attempt()
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  return await new Promise<DialResult>((resolve, reject) => {
    let pending = attempts.length
    let settled = false
    const errors: unknown[] = []

    for (const attempt of attempts) {
      attempt().then(
        (result) => {
          if (settled) {
            try {
              result.writable.getWriter().close()
            } catch {
              /* 忽略 */
            }
            return
          }
          settled = true
          resolve(result)
        },
        (err) => {
          errors.push(err)
          pending -= 1
          if (pending === 0 && !settled) {
            settled = true
            reject(errors[0] ?? new Error('拨号失败'))
          }
        }
      )
    }
  })
}

/** 统一拨号入口 */
export async function dial(options: DialOptions): Promise<DialResult> {
  const proxies = options.proxies ?? []
  const concurrent = options.concurrent ?? true

  if (proxies.length === 0) {
    return await dialDirect(options)
  }

  const attempts = proxies.map((proxy) => () => dialViaProxy(options, proxy))
  if (proxies.length > 1) {
    attempts.push(() => dialDirect(options))
  }
  return await raceDial(attempts, concurrent)
}
