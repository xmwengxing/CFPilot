/** 实验性出口识别：只识别显式指定的传输路径，不参与扫描或排序。 */
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as https from 'node:https'

export const MAX_IDENTITY_BYTES = 16 * 1024
export const IDENTITY_TIMEOUT_MS = 8000
export const MAX_TOKEN_TTL_MS = 5 * 60 * 1000
const CLOCK_SKEW_MS = 30_000

export interface IdentityOptions {
  url: string
  /** 只在内存中使用，由用户自有服务签发；绝不复用部署或面板凭据。 */
  token?: string
  /** 提供 token 时必须声明过期时间，剩余有效期不超过五分钟。 */
  tokenExpiresAt?: string
  /** 显式 SOCKS5 传输；不传则为本机直连基线。 */
  proxy?: string
  /** 可以缩短，但不能扩大八秒总预算。 */
  timeoutMs?: number
}

export interface IdentityObservation {
  remoteIp: string
  observedAt: string
  fetchedAt: string
  ageMs: number
  sourceUrl: string
  transport: 'direct' | 'socks5'
  egressKind?: string
  colo?: string
}

export type IdentityResult = { ok: true; observation: IdentityObservation } | {
  ok: false
  code: 'config' | 'timeout' | 'transport' | 'http' | 'size' | 'response'
  error: string
}

function fail(code: Extract<IdentityResult, { ok: false }>['code'], error: string): IdentityResult {
  return { ok: false, code, error }
}

/** 只接受可路由单播地址；拒绝保留、映射与转换地址以免歧义。 */
export function isPublicIp(value: string): boolean {
  const family = net.isIP(value)
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = value.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || value.includes('%') || value.includes('.')) return false
  const halves = value.toLowerCase().split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const words = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const parts = words.map((word) => parseInt(word, 16))
  const first = parts[0] ?? 0
  // 只接受 2000::/3，并排除文档、基准测试、隧道和特殊协议分配。
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && ((parts[1] ?? 0) < 0x200 || parts[1] === 0xdb8)) &&
    !(first === 0x3fff && (parts[1] ?? 0) < 0x1000)
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return null
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null
  const zone = match[7]!
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 从不透传服务端额外字段；超过五分钟的结果失效，其余结果保留 age。 */
export function validateIdentityResponse(value: unknown, now: number): Omit<IdentityObservation, 'sourceUrl' | 'transport'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const observed = timestamp(data.observed_at)
  if (typeof data.remote_ip !== 'string' || !isPublicIp(data.remote_ip) || observed === null || observed > now + CLOCK_SKEW_MS || now - observed > 300_000) return null
  for (const key of ['egress_kind', 'colo']) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || (data[key] as string).length < 1 || (data[key] as string).length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(data[key] as string))) return null
  }
  return {
    remoteIp: data.remote_ip,
    observedAt: new Date(observed).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    ageMs: Math.max(0, now - observed),
    ...(typeof data.egress_kind === 'string' ? { egressKind: data.egress_kind } : {}),
    ...(typeof data.colo === 'string' ? { colo: data.colo } : {}),
  }
}

/** 有界握手读取；剩余数据退回 socket，避免吞掉后续 TLS 数据。 */
function readExactly(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data: Buffer = Buffer.alloc(0)
    const cleanup = (): void => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose) }
    const onError = (): void => { cleanup(); reject(new Error('SOCKS5 连接失败')) }
    const onClose = (): void => { cleanup(); reject(new Error('SOCKS5 提前关闭')) }
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk])
      if (data.length < length) return
      socket.pause()
      cleanup()
      if (data.length > length) socket.unshift(data.subarray(length))
      resolve(data.subarray(0, length))
    }
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose); socket.resume()
  })
}

export async function negotiateSocks(socket: net.Socket, proxy: URL, target: URL): Promise<void> {
  const user = Buffer.from(decodeURIComponent(proxy.username))
  const password = Buffer.from(decodeURIComponent(proxy.password))
  const authenticated = user.length > 0
  const greeting = readExactly(socket, 2)
  socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]))
  const method = await greeting
  if (method[0] !== 5 || method[1] !== (authenticated ? 2 : 0)) throw new Error('SOCKS5 认证方式不匹配')
  if (authenticated) {
    const auth = readExactly(socket, 2)
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
    const response = await auth
    if (response[0] !== 1 || response[1] !== 0) throw new Error('SOCKS5 认证失败')
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const host = Buffer.from(hostname)
  // 域名由代理解析；IP 字面量使用对应地址类型，避免依赖代理的 DNS 特例。
  let address = Buffer.concat([Buffer.from([3, host.length]), host])
  if (net.isIP(hostname) === 4) address = Buffer.from([1, ...hostname.split('.').map(Number)])
  else if (net.isIP(hostname) === 6) {
    const halves = hostname.split('::')
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const words = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    address = Buffer.alloc(17)
    address[0] = 4
    words.forEach((word, index) => address.writeUInt16BE(parseInt(word, 16), index * 2 + 1))
  }
  const port = Number(target.port || 443)
  const reply = readExactly(socket, 4)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]))
  const head = await reply
  if (head[0] !== 5 || head[1] !== 0 || head[2] !== 0) throw new Error('SOCKS5 CONNECT 失败')
  if (head[3] === 1) await readExactly(socket, 6)
  else if (head[3] === 4) await readExactly(socket, 18)
  else if (head[3] === 3) { const size = await readExactly(socket, 1); await readExactly(socket, size[0]! + 2) }
  else throw new Error('SOCKS5 响应地址无效')
}

/** 证书与主机名均校验；不跟随重定向，不重试，不保存 token 或代理凭据。 */
export function identifyEgress(options: IdentityOptions): Promise<IdentityResult> {
  let target: URL
  let proxy: URL | undefined
  const timeoutMs = options.timeoutMs ?? IDENTITY_TIMEOUT_MS
  try {
    target = new URL(options.url)
    const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
    if (target.protocol !== 'https:' || target.username || target.password || target.hash || !hostname || hostname.length > 253) throw new Error()
    if (net.isIP(hostname) ? !isPublicIp(hostname) : hostname === 'localhost' || !hostname.includes('.') || /\.(?:localhost|local|internal|home|test|invalid)$/.test(hostname)) throw new Error()
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > IDENTITY_TIMEOUT_MS) throw new Error()
    if (options.token !== undefined) {
      const expires = timestamp(options.tokenExpiresAt)
      if (!/^[A-Za-z0-9._~+/-]{16,2048}={0,2}$/.test(options.token) || expires === null || expires <= Date.now() || expires > Date.now() + MAX_TOKEN_TTL_MS) throw new Error()
    } else if (options.tokenExpiresAt !== undefined) throw new Error()
    if (options.proxy !== undefined) {
      proxy = new URL(options.proxy)
      const proxyPort = Number(proxy.port || 1080)
      if (proxy.protocol !== 'socks5:' || !proxy.hostname || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535 || (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) throw new Error()
      const user = decodeURIComponent(proxy.username)
      const password = decodeURIComponent(proxy.password)
      if (Buffer.byteLength(user) > 255 || Buffer.byteLength(password) > 255 || (!user && password)) throw new Error()
    }
  } catch { return Promise.resolve(fail('config', '识别配置无效：需要 HTTPS、有效短期令牌和可选 SOCKS5 地址')) }

  return new Promise((resolve) => {
    let settled = false
    let request: ReturnType<typeof https.request> | undefined
    let socket: net.Socket | undefined
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
    const finish = (result: IdentityResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.destroy()
      socket?.destroy()
      agent.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish(fail('timeout', '出口识别超过总超时预算')), timeoutMs)
    if (proxy) {
      const selectedProxy = proxy
      agent.createConnection = (_connectionOptions, callback) => {
        socket = net.connect({ host: selectedProxy.hostname.replace(/^\[|\]$/g, ''), port: Number(selectedProxy.port || 1080) })
        socket.once('error', () => finish(fail('transport', 'SOCKS5 连接失败')))
        socket.once('connect', () => {
          const raw = socket!
          void negotiateSocks(raw, selectedProxy, target).then(() => {
            if (settled) return
            const hostname = target.hostname.replace(/^\[|\]$/g, '')
            const secure = tls.connect({ socket: raw, host: hostname, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true })
            socket = secure
            secure.once('error', () => finish(fail('transport', '识别服务 TLS 连接失败')))
            callback?.(null, secure)
          }).catch(() => finish(fail('transport', 'SOCKS5 握手失败')))
        })
        return undefined
      }
    }
    request = https.request(target, {
      method: 'GET', agent, maxHeaderSize: 8192,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-store', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    }, (response) => {
      if (response.statusCode !== 200) { finish(fail('http', `识别服务返回 HTTP ${response.statusCode ?? 0}`)); return }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '') || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        finish(fail('response', '识别服务必须返回未压缩的 JSON')); return
      }
      const declared = response.headers['content-length']
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_IDENTITY_BYTES)) { finish(fail('size', '识别响应超过 16 KiB')); return }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_IDENTITY_BYTES) { finish(fail('size', '识别响应超过 16 KiB')); return }
        chunks.push(chunk)
      })
      response.once('error', () => finish(fail('transport', '识别响应传输失败')))
      response.once('end', () => {
        if (settled) return
        try {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          const observation = validateIdentityResponse(value, Date.now())
          if (!observation) { finish(fail('response', '识别结果字段或公网地址无效')); return }
          finish({ ok: true, observation: { ...observation, sourceUrl: target.origin + target.pathname, transport: proxy ? 'socks5' : 'direct' } })
        } catch { finish(fail('response', '识别响应不是有效 UTF-8 JSON')) }
      })
    })
    request.once('error', () => finish(fail('transport', '识别请求连接失败')))
    request.end()
  })
}
