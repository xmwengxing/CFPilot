/**
 * 出站拨号：直连（可选 NAT64 兜底）/ ProxyIP / SOCKS5 / HTTP / 并发竞速。
 *
 * `cloudflare:sockets` 用**静态 import 且必须落在文件首字节**（见 build.mjs 的 import 归一化）。
 * 真机实测：非字面量的动态 import 会让边缘 isolate 在实例化阶段失败（1101 且无调用日志）。
 */
import { connect } from 'cloudflare:sockets'
import { socks5Connect } from './socks5'
import { httpConnect } from './http-proxy'
import { isIpv4 } from '../protocols/address'
import type { ProxyEndpoint } from './proxy-pool'

export type { ProxyKind, ProxyEndpoint } from './proxy-pool'
export { parseProxyEntry, parseProxyPool } from './proxy-pool'

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

  // ProxyIP 语义：连到指定地址，但请求的目标仍是原始 hostname:port。
  // 这是 BPB / edgetunnel 等项目的通用做法，用于让出站流量落在指定的 Cloudflare 网段。
  if (proxy.kind === 'direct') {
    const socket = await connectWithTimeout(proxy.host, proxy.port, timeoutMs)
    return {
      readable: socket.readable,
      writable: socket.writable,
      via: 'direct',
      endpoint: `${proxy.host}:${proxy.port}`,
    }
  }

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
