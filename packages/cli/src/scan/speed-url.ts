/**
 * 测速地址：内置预设、可用性预检、解析。
 *
 * ## 设计取舍
 *
 * CFPilot 原本只能通过目标项目自己的探针端点（`/__edge_probe`）测速，
 * 对接第三方项目时对方没有该端点，速度永远是 0。
 *
 * 这里改为支持**公开测速地址**：请求一个 Cloudflare 上的大文件，
 * 但把 TCP 连接拨到候选 IP 上（TLS SNI / Host 仍用测速地址的域名）。
 * 这样任何项目都能测。
 *
 * ## ⚠️ 关键前提
 *
 * 公开地址测的是「候选 IP 到 Cloudflare 边缘的带宽」，
 * **不代表这个 IP 能服务你的代理域名**。
 * 因此调用方必须**先用 101 校验筛出能服务自己域名的 IP，再对它们测速**。
 * 跳过 101 直接用公开地址排序，就会得到「速度很快但导入客户端全是 -1」
 * 的结果 —— 这是同类工具的常见通病，不要重蹈覆辙。
 *
 * ## 为什么要有可用性预检
 *
 * 测速地址本身可能在本网络下不可用（被墙、限流、服务下线）。
 * 若不预检，就会把「地址不可用」误判成「所有 IP 速度都是 0」。
 * 启动时并行探测各候选地址，优先用可用的那个。
 */
import * as tls from 'node:tls'
import * as net from 'node:net'

/** 内置测速地址（都不含协议前缀，端口按目标端口推断） */
export const SPEED_URL_PRESETS: Array<{ url: string; label: string }> = [
  { url: 'speed.cloudflare.com/__down?bytes=104857600', label: 'Cloudflare 官方' },
  { url: 'cf.090227.xyz/__down?bytes=104857600', label: 'CM 提供' },
]

/** 默认测速地址 */
export const DEFAULT_SPEED_URL = SPEED_URL_PRESETS[0]!.url

export interface ParsedSpeedUrl {
  /** 原始形式（用于展示） */
  raw: string
  scheme: 'http' | 'https'
  /** TLS SNI / Host 头的域名 */
  host: string
  /** 请求路径（含 query） */
  path: string
}

/**
 * 解析测速地址。
 *
 * 允许以下写法：
 *   - `speed.cloudflare.com/__down?bytes=100000000`
 *   - `https://speed.cloudflare.com/__down?bytes=100000000`
 *   - `//speed.cloudflare.com/__down`
 */
export function parseSpeedUrl(raw: string, fallbackScheme: 'http' | 'https' = 'https'): ParsedSpeedUrl {
  const value = (raw ?? '').trim()
  if (!value) throw new Error('测速地址为空')

  // 先拦住「明确写了别的协议」的输入。
  // 否则下面的补全逻辑会把 ftp://example.com/a 变成 https://ftp://example.com/a，
  // 被解析成 host=ftp —— 不报错但完全跑不通。
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`不支持的测速地址协议：${scheme}（只支持 http / https）`)
    }
  }

  let normalized = value
  if (normalized.startsWith('//')) {
    normalized = `${fallbackScheme}:${normalized}`
  } else if (!/^https?:\/\//i.test(normalized)) {
    normalized = `${fallbackScheme}://${normalized}`
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`测速地址无法解析：${value}`)
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error(`不支持的测速地址协议：${scheme}`)
  }
  if (!parsed.hostname) throw new Error(`测速地址缺少域名：${value}`)

  return {
    raw: value,
    scheme,
    host: parsed.hostname,
    path: `${parsed.pathname}${parsed.search}` || '/',
  }
}

/** 端口对应的默认协议：CF 的 TLS 端口用 https，其余用 http */
export function schemeForPort(port: number): 'http' | 'https' {
  return port === 443 || port === 2053 || port === 2083 || port === 2087 || port === 2096 || port === 8443
    ? 'https'
    : 'http'
}

/**
 * 预检某个测速地址是否可用（发一个小请求，看是否返回 200）。
 *
 * 用系统 DNS 解析地址本身（不经过候选 IP）—— 这里只判断
 * 「我这个网络能不能访问这个测速地址」。
 */
export function checkSpeedUrlAvailable(
  parsed: ParsedSpeedUrl,
  timeoutMs = 6000
): Promise<{ available: boolean; status: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let received = ''

    const finish = (available: boolean, status: number, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ available, status, error })
    }

    // 只取前 1KB，够判断状态码即可
    const path = parsed.path.includes('bytes=')
      ? parsed.path.replace(/bytes=\d+/, 'bytes=1024')
      : parsed.path

    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${parsed.host}`,
      `User-Agent: ${USER_AGENT_FOR_CHECK}`,
      'Accept: */*',
      'Connection: close',
      '',
      '',
    ].join('\r\n')

    const connectOptions = {
      host: parsed.host,
      port: parsed.scheme === 'https' ? 443 : 80,
      servername: parsed.host,
      rejectUnauthorized: false,
    }

    const socket =
      parsed.scheme === 'https'
        ? tls.connect(connectOptions, () => socket.write(request))
        : // http 明文：用 net 连接
          (() => {
            // ⚠️ 必须用顶层 import 的 net，不能写 require('node:net')。
            // 本包是 ESM（format: 'esm'），esbuild 会把 require 改写成
            // __require() 垫片，运行时抛：
            //   Error: Dynamic require of "node:net" is not supported
            // 实测：http:// 测速地址直接崩，https:// 正常。
            const s = net.connect({ host: parsed.host, port: 80 }, () => s.write(request))
            return s as unknown as tls.TLSSocket
          })()

    const timer = setTimeout(() => finish(false, 0, '预检超时'), timeoutMs)
    socket.setTimeout(timeoutMs, () => finish(false, 0, '预检超时'))
    socket.on('error', (err: Error) => finish(false, 0, err.message))
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(received)
      if (m) {
        const status = Number(m[1])
        finish(status === 200 || status === 206, status)
      }
    })
  })
}

/**
 * 测速预检用的 User-Agent。
 *
 * 用常见桌面浏览器标识，不用工具自身的名字。
 *
 * ## 为什么
 *
 * 预检请求打的是**公开测速地址**（speed.cloudflare.com 等第三方），
 * 带 `CFPilot-Scanner/1.0 (+github.com/...)` 会在对方的访问日志里
 * 留下明确的「这是某个工具」指纹。几百次扫描下来很容易被识别并限流。
 *
 * 本地回传结果 / 日志输出仍用工具自身标识（见 callback.ts），不混淆。
 */
const USER_AGENT_FOR_CHECK =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 依次预检候选测速地址，返回第一个可用的。
 *
 * 全部不可用时回退到默认地址（宁可试一次，也不要直接放弃测速）。
 */
export async function pickAvailableSpeedUrl(
  candidates: string[],
  log?: (message: string) => void
): Promise<string> {
  const list = candidates.length > 0 ? candidates : [DEFAULT_SPEED_URL]
  for (const candidate of list) {
    let parsed: ParsedSpeedUrl
    try {
      parsed = parseSpeedUrl(candidate, 'https')
    } catch {
      continue
    }
    const result = await checkSpeedUrlAvailable(parsed)
    if (result.available) {
      log?.(`测速地址可用：${candidate}`)
      return candidate
    }
    log?.(`测速地址不可用（${result.error ?? 'HTTP ' + result.status}）：${candidate}`)
  }
  log?.(`所有测速地址都不可用，回退到默认：${DEFAULT_SPEED_URL}`)
  return DEFAULT_SPEED_URL
}

/** 生成测速请求路径：保留原有 query，只把 bytes 调到指定大小 */
export function withBytes(parsed: ParsedSpeedUrl, bytes: number): string {
  if (/bytes=\d+/.test(parsed.path)) {
    return parsed.path.replace(/bytes=\d+/, `bytes=${bytes}`)
  }
  const sep = parsed.path.includes('?') ? '&' : '?'
  return `${parsed.path}${sep}bytes=${bytes}`
}

/**
 * 探测目标项目是否提供 CFPilot 风格的探针端点。
 *
 * 判定依据是响应头 `x-probe-bytes` —— 这是 `/__edge_probe` 独有的标记，
 * 其它端点不会带。据此决定用 probe 模式（最忠实）还是 url 模式（通用）。
 *
 * 探测失败一律返回 false（走更通用的 url 模式），不让测速因此跳过。
 */
export async function detectProbeEndpoint(
  host: string,
  probePath: string,
  timeoutMs = 8000
): Promise<boolean> {
  try {
    const response = await fetch(`https://${host}${probePath}?bytes=1024`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return Boolean(response.headers.get('x-probe-bytes'))
  } catch {
    return false
  }
}

/**
 * 决定测速方式：
 *   - 目标有探针端点 → probe（走项目自己的路径，最忠实）
 *   - 否则 → url（公开测速地址，任何项目都能测）
 *
 * 两种方式都只作用于已通过 101 校验的 IP，所以都不会产出 -1 节点。
 */
export async function resolveSpeedMode(
  host: string,
  probePath: string,
  explicit?: 'probe' | 'url' | 'auto'
): Promise<{ mode: 'probe' | 'url'; reason: string }> {
  if (explicit === 'probe') return { mode: 'probe', reason: '用户指定 probe 模式' }
  if (explicit === 'url') return { mode: 'url', reason: '用户指定 url 模式' }

  const hasProbe = await detectProbeEndpoint(host, probePath)
  return hasProbe
    ? { mode: 'probe', reason: `检测到探针端点 ${probePath}，走项目自身路径` }
    : { mode: 'url', reason: `${probePath} 无探针标记，改用公开测速地址` }
}