/** 实验性网站兼容性：仅报告指定路径的 HTTP 观察，不推断账号权限或完整解锁。 */
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { isPublicIp, negotiateSocks } from './egress-identity'

export const WEBSITE_TIMEOUT_MS = 8000
export const WEBSITE_MAX_BYTES = 16 * 1024
export const WEBSITE_MAX_TARGETS = 10
export interface WebsiteTarget {
  label: string
  url: string
  /** 可选 UTF-8 正文标记；纯文本匹配，不执行脚本或正则。 */
  expectedText?: string
}
export type WebsiteStatus = 'ok' | 'challenge' | 'forbidden' | 'rate_limited' | 'tls_error' | 'timeout' | 'http_error' | 'invalid_response'
export interface WebsiteTargetResult {
  label: string
  /** 仅 origin + pathname，不输出 query、userinfo、fragment。 */
  url: string
  status: WebsiteStatus
  httpStatus: number
  challengeHeader: boolean
  ms: number
  expectedContentOk?: boolean
  error?: string
  transport: 'direct' | 'socks5'
}
export interface WebsiteOptions {
  targets: WebsiteTarget[]
  proxy?: string
  timeoutMs?: number
}

/** 与出口识别相同的显式 HTTPS 目标边界；代理 DNS 由可信代理负责。 */
function targetUrl(value: string): URL {
  const target = new URL(value)
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || !hostname || hostname.length > 253 || target.port === '0') throw new Error()
  if (net.isIP(hostname) ? !isPublicIp(hostname) : hostname === 'localhost' || !hostname.includes('.') || /\.(?:localhost|local|internal|home|test|invalid)$/.test(hostname)) throw new Error()
  return target
}
function proxyUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined
  const proxy = new URL(value)
  const port = Number(proxy.port || 1080)
  if (proxy.protocol !== 'socks5:' || !proxy.hostname || !Number.isInteger(port) || port < 1 || port > 65535 || (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) throw new Error()
  const user = decodeURIComponent(proxy.username)
  const password = decodeURIComponent(proxy.password)
  if (Buffer.byteLength(user) > 255 || Buffer.byteLength(password) > 255 || (!user && password)) throw new Error()
  return proxy
}
function tlsFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(code)
}

/** 单目标八秒总预算；不发送出口识别 token、Cookie 或任何账号凭据。 */
export function probeWebsite(target: WebsiteTarget, options: { proxy?: string; timeoutMs?: number } = {}): Promise<WebsiteTargetResult> {
  const started = Date.now()
  const base: WebsiteTargetResult = {
    label: typeof target.label === 'string' && target.label.length > 0 && target.label.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(target.label) ? target.label : 'invalid',
    url: '', transport: options.proxy === undefined ? 'direct' : 'socks5',
    ms: 0, status: 'invalid_response', httpStatus: 0, challengeHeader: false,
  }
  let url: URL
  let proxy: URL | undefined
  const timeout = options.timeoutMs ?? WEBSITE_TIMEOUT_MS
  try {
    if (base.label !== target.label || !Number.isInteger(timeout) || timeout < 1 || timeout > WEBSITE_TIMEOUT_MS) throw new Error()
    if (target.expectedText !== undefined && (typeof target.expectedText !== 'string' || target.expectedText.length === 0 || Buffer.byteLength(target.expectedText) > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(target.expectedText))) throw new Error()
    url = targetUrl(target.url)
    base.url = url.origin + url.pathname
    proxy = proxyUrl(options.proxy)
  } catch { return Promise.resolve({ ...base, error: '网站检测配置无效' }) }

  return new Promise((resolve) => {
    let settled = false
    let socket: net.Socket | undefined
    let request: ReturnType<typeof https.request> | undefined
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
    const finish = (patch: Partial<WebsiteTargetResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.destroy(); socket?.destroy(); agent.destroy()
      resolve({ ...base, ...patch, ms: Date.now() - started })
    }
    const onError = (error: unknown): void => finish({ status: tlsFailure(error) ? 'tls_error' : 'http_error', error: tlsFailure(error) ? '网站 TLS 校验失败' : '指定路径连接失败' })
    const timer = setTimeout(() => finish({ status: 'timeout', error: '网站检测超过总超时预算' }), timeout)
    if (proxy) {
      const selected = proxy
      agent.createConnection = (_connectionOptions, callback) => {
        socket = net.connect({ host: selected.hostname.replace(/^\[|\]$/g, ''), port: Number(selected.port || 1080) })
        socket.once('error', onError)
        socket.once('connect', () => {
          const raw = socket!
          void negotiateSocks(raw, selected, url).then(() => {
            if (settled) return
            const host = url.hostname.replace(/^\[|\]$/g, '')
            const secure = tls.connect({ socket: raw, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true })
            socket = secure
            secure.once('error', onError)
            callback?.(null, secure)
          }).catch(() => finish({ status: 'http_error', error: '指定代理握手失败' }))
        })
        return undefined
      }
    }
    request = https.request(url, {
      method: 'GET', agent, maxHeaderSize: 8192,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-store' },
    }, (response) => {
      const status = response.statusCode ?? 0
      base.httpStatus = status
      const header = response.headers['cf-mitigated']
      base.challengeHeader = typeof header === 'string' && header.trim().toLowerCase() === 'challenge'
      if (base.challengeHeader) { finish({ status: 'challenge' }); return }
      if (status === 403) { finish({ status: 'forbidden' }); return }
      if (status === 429) { finish({ status: 'rate_limited' }); return }
      if (status < 200 || status >= 300) { finish({ status: 'http_error', error: status >= 300 && status < 400 ? '目标返回重定向，未跟随' : '目标返回非成功状态码' }); return }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { finish({ status: 'invalid_response', error: '目标返回压缩内容，未解压' }); return }
      const declared = response.headers['content-length']
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > WEBSITE_MAX_BYTES)) { finish({ status: 'invalid_response', error: '网站响应超过 16 KiB' }); return }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > WEBSITE_MAX_BYTES) { finish({ status: 'invalid_response', error: '网站响应超过 16 KiB' }); return }
        chunks.push(chunk)
      })
      response.once('error', () => finish({ status: 'http_error', error: '网站响应传输失败' }))
      response.once('end', () => {
        if (settled) return
        // 只识别明确的挑战协议标记，不凭单个普通英文词推断挑战。
        const bytes = Buffer.concat(chunks)
        const contentType = response.headers['content-type'] ?? ''
        if (/^text\/html(?:\s*;|$)/i.test(contentType) && /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/cdn-cgi\/challenge-platform\//i.test(bytes.toString('utf8'))) { finish({ status: 'challenge' }); return }
        if (target.expectedText !== undefined) {
          try {
            const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            if (!body.includes(target.expectedText)) { finish({ status: 'invalid_response', expectedContentOk: false, error: '正文不符合显式检测条件' }); return }
          } catch { finish({ status: 'invalid_response', expectedContentOk: false, error: '目标正文不是有效 UTF-8' }); return }
          finish({ status: 'ok', expectedContentOk: true }); return
        }
        finish({ status: 'ok' })
      })
    })
    request.once('error', onError)
    request.end()
  })
}

/** 串行、有界目标列表，输出可直接嵌入报告；不加载 scan 或修改其结果。 */
export async function probeWebsites(options: WebsiteOptions): Promise<WebsiteTargetResult[]> {
  if (options.targets.length < 1 || options.targets.length > WEBSITE_MAX_TARGETS || new Set(options.targets.map((target) => target.label)).size !== options.targets.length) throw new Error('网站检测需要 1–10 个不同标签的目标')
  const results: WebsiteTargetResult[] = []
  for (const target of options.targets) results.push(await probeWebsite(target, options))
  return results
}
