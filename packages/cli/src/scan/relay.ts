/**
 * `scan relay` —— 反代入口（Proxy IP 池）候选的**出站体检**。
 *
 * ## 为什么不是「让 Worker 自己做 TLS」
 *
 * 生产里的反代链路是**明文管道**：
 *
 *   Worker ──明文 TCP──> 代理:443 ──把客户端的 ClientHello 原样转发──> 按 SNI 到目标
 *
 * Worker 侧不做 TLS。真机实测：在 Worker 里 `connect() + startTls()` 到这类代理，
 * 握手能"成功"、写入也返回成功，但**一个字节都读不到**（对端 RST）；
 * 同一批 IP 从普通主机测则全部 200。所以测量必须**复用这条明文管道**，
 * 把 TLS 握手交给本机完成。
 *
 * ## 测法
 *
 *   本机 ──VLESS/WS 隧道──> 你的数据面 ──connect──> 候选 IP:443
 *        └── TLS(SNI=你的域名) + GET /__cfp_version ──┘
 *
 * 这条链路的终点是 **Cloudflare 边缘再回到你自己的 Worker**：
 *   - TLS 证书用你的域名校验（`rejectUnauthorized` 默认开）⇒ 证明代理确实按 SNI 转发到了 CF；
 *   - 返回的 `build` 必须等于数据面自己的 build ⇒ 证明落点确实是你的实例。
 *
 * 两个条件同时成立才算通过。只看 TCP/TLS 通会把「连上了但转错地方」当成好的。
 *
 * ## 为什么这比「数据面加探测端点」好
 *
 * 不需要新端点、不需要面板密码、不改任何配置、没有开关要翻转，
 * 也就没有「拿订阅 UUID 当跳板扫外网」的滥用面 —— 全部能力都由本机驱动。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import { flagBool, flagNumber, flagString, type ParsedArgs } from '../shared/args'
import { NAME, VERSION } from '../shared/version'
import { SCAN_RELAY_HELP } from './help'
import { readIpFile, readIpUrl } from './ip-ranges'
import { readBuiltinRelayCandidates } from './relay-builtin'
import { getPanelConfig, patchPanelConfig } from './callback'

/** 同时探测几个候选（每条隧道是一个独立请求，不受 Worker 单请求 6 连接的限制） */
const CONCURRENCY = 8
/** 单目标总超时 */
const DEFAULT_TIMEOUT_MS = 12_000

interface ProbeOutcome {
  ip: string
  ok: boolean
  /** 隧道建立（含协议响应头）耗时 */
  tunnelMs: number
  /** TLS 握手耗时（经过代理到 CF 边缘） */
  tlsMs: number
  /** HTTP 往返耗时 */
  httpMs: number
  status: number
  build: string
  buildOk: boolean
  error: string
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 32) throw new Error(`UUID 应为 32 位十六进制，实际 ${hex.length} 位`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** IPv4 字面量 → VLESS 的 ATYP=1 地址 */
function ipv4Address(ip: string): Uint8Array {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`不是合法的 IPv4：${ip}`)
  }
  const out = new Uint8Array(5)
  out[0] = 0x01
  out.set(parts, 1)
  return out
}

function buildVlessHello(uuid: string, ip: string, port: number): Uint8Array {
  const addr = ipv4Address(ip)
  const out = new Uint8Array(21 + addr.length)
  out[0] = 0x00
  out.set(uuidToBytes(uuid), 1)
  out[17] = 0x00 // addons 长度
  out[18] = 0x01 // CONNECT
  out[19] = (port >> 8) & 0xff
  out[20] = port & 0xff
  out.set(addr, 21)
  return out
}

/**
 * 把 WebSocket 包成 Node 双向流，供 `tls.connect({ socket })` 使用。
 *
 * ⚠️ 这里**不注册** message 监听 —— 字节路由由 `openTunnel` 独占：
 * 第一条消息是 VLESS 协议响应头（`[0,0]`），必须剥掉才能交给 TLS。
 * 早前两边都注册了监听，结果响应头被原样推进流里，
 * TLS 客户端读到 `\0\0` 直接报 `wrong version number`。
 */
function createDuplex(ws: WebSocket): { duplex: Duplex; push: (buf: Buffer | null) => void } {
  const duplex = new Duplex({
    write(chunk, _enc, cb) {
      try {
        ws.send(chunk)
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
    read() {
      /* 推模式，无需实现 */
    },
  })
  // ⚠️ 必须挂一个 'error' 监听：隧道超时 / WS 异常时我们会 destroy 这个流，
  // 而 Node 的流如果被 destroy(err) 且没有 error 监听，会抛**未捕获的 error 事件**
  // 直接结束进程 —— 一个坏候选就能让整轮 3000 个候选的体检崩掉。
  // 真正的失败由 TLS 握手 / 读超时那条路径报出来，这里只负责别炸进程。
  duplex.on('error', () => {
    /* 由上层（Probe 的 try/catch）负责诊断 */
  })
  return {
    duplex,
    push: (buf: Buffer | null): void => {
      duplex.push(buf)
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)),
  ])
}

/** 打开隧道并等到协议响应头；顺带把紧跟其后的负载塞回流里 */
/**
 * 打开隧道并等到协议响应头，之后把字节原样交给 TLS。
 *
 * 第一条 WS 消息是 VLESS 响应头 `[版本, addons长度, ...addons]`，
 * **必须剥掉**：它之后的字节（可能是服务端首帧）属于隧道流。
 */
function openTunnel(
  wsUrl: string,
  uuid: string,
  ip: string,
  port: number,
  timeoutMs: number
): Promise<{ ws: WebSocket; duplex: Duplex; tunnelMs: number; first: { first: Buffer } }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    const { duplex, push } = createDuplex(ws)
    const sniff = { first: Buffer.alloc(0) }
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
      reject(new Error(`隧道建立超时（${timeoutMs}ms）`))
    }, timeoutMs)

    ws.addEventListener('open', () => {
      ws.send(buildVlessHello(uuid, ip, port))
    })

    ws.addEventListener('message', (ev: MessageEvent) => {
      const bytes = Buffer.from(ev.data as ArrayBuffer)
      if (!settled) {
        if (bytes.byteLength < 2) return
        const headerLen = 2 + (bytes[1] ?? 0)
        settled = true
        clearTimeout(timer)
        const rest = bytes.subarray(Math.min(headerLen, bytes.byteLength))
        if (rest.byteLength > 0) push(rest)
        resolve({ ws, duplex, tunnelMs: Date.now() - started, first: sniff })
        return
      }
      if (sniff.first.length === 0) sniff.first = Buffer.from(bytes)
      push(bytes)
    })

    ws.addEventListener('error', () => {
      if (settled) {
        duplex.destroy(new Error('WebSocket 连接失败'))
        return
      }
      settled = true
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败'))
    })

    ws.addEventListener('close', (ev: CloseEvent) => {
      push(null)
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`隧道被关闭 code=${ev.code} ${ev.reason || ''}`))
    })
  })
}

/** 读一段 HTTP/1.1 响应，边读边尝试解析正文 */
function readHttp(socket: tls.TLSSocket, timeoutMs: number): Promise<{ status: number; body: string; raw: string }> {
  return new Promise((resolve, reject) => {
    let text = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      const sep = text.indexOf('\r\n\r\n')
      const head = sep >= 0 ? text.slice(0, sep) : text
      const body = sep >= 0 ? text.slice(sep + 4) : ''
      const matched = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      resolve({ status: matched ? Number(matched[1]) : 0, body, raw: text })
    }
    const timer = setTimeout(finish, timeoutMs)
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      const sep = text.indexOf('\r\n\r\n')
      if (sep >= 0) {
        try {
          JSON.parse(text.slice(sep + 4))
          finish()
          return
        } catch {
          /* 还没读全 */
        }
      }
      if (text.length > 8192) finish()
    }
    socket.on('data', onData)
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', (err) => {
      clearTimeout(timer)
      if (!done) {
        done = true
        reject(err)
      }
    })
  })
}

async function probeOne(
  opts: { wsUrl: string; uuid: string; host: string; expectedBuild: string },
  ip: string,
  timeoutMs: number
): Promise<ProbeOutcome> {
  const out: ProbeOutcome = {
    ip,
    ok: false,
    tunnelMs: 0,
    tlsMs: 0,
    httpMs: 0,
    status: 0,
    build: '',
    buildOk: false,
    error: '',
  }
  let ws: WebSocket | undefined
  let socket: tls.TLSSocket | undefined
  let sniff: { first: Buffer } | undefined
  try {
    const tunnel = await openTunnel(opts.wsUrl, opts.uuid, ip, 443, timeoutMs)
    ws = tunnel.ws
    sniff = tunnel.first
    out.tunnelMs = tunnel.tunnelMs

    const tlsStarted = Date.now()
    socket = await withTimeout(
      new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect(
          {
            socket: tunnel.duplex,
            servername: opts.host,
            // 默认校验：证书链 + 主机名（servername 就是我们的域名）。
            // 这一条通过，就等于证明「这个候选确实把 SNI=我们的域名 转到了 CF」。
            rejectUnauthorized: true,
          },
          () => resolve(s)
        )
        s.once('error', reject)
      }),
      timeoutMs,
      'TLS 握手'
    )
    out.tlsMs = Date.now() - tlsStarted

    const httpStarted = Date.now()
    socket.write(
      `GET /__cfp_version HTTP/1.1\r\nHost: ${opts.host}\r\nConnection: close\r\n` +
        `User-Agent: cfpilot-scan-relay\r\n\r\n`
    )
    const res = await readHttp(socket, timeoutMs)
    out.httpMs = Date.now() - httpStarted
    out.status = res.status
    if (res.status === 200) {
      try {
        const parsed = JSON.parse(res.body) as { build?: string }
        out.build = typeof parsed.build === 'string' ? parsed.build : ''
        out.buildOk = out.build !== '' && out.build === opts.expectedBuild
      } catch {
        /* 正文不是 JSON */
      }
    }
    if (out.buildOk) {
      out.ok = true
    } else if (res.status === 0) {
      out.error = `无有效 HTTP 响应（收到 ${res.raw.length} 字节）`
    } else if (res.status === 200) {
      out.error = `build 不匹配（${out.build || '空'} ≠ ${opts.expectedBuild}）`
    } else {
      out.error = `HTTP ${res.status}`
    }
  } catch (err) {
    // 首包是判断「对面到底回了什么」的唯一证据：
    // 明文 HTTP → SNI 没生效；空 → 对端直接断；其它 → 见字节
    const preview =
      sniff && sniff.first.length > 0
        ? ` | 首包=${JSON.stringify(sniff.first.subarray(0, 40).toString('utf8'))}`
        : ' | 首包=（空）'
    out.error = (String(err instanceof Error ? err.message : err) + preview).slice(0, 400)
  } finally {
    try {
      socket?.destroy()
    } catch {
      /* 已关闭 */
    }
    try {
      ws?.close()
    } catch {
      /* 已关闭 */
    }
  }
  return out
}

interface Aggregate {
  ip: string
  rounds: number
  passed: number
  successPct: number
  tunnelMs: number
  tlsMs: number
  tlsP95: number
  httpMs: number
  errors: string[]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

/* ------------------------------------------------------------------ */
/* 校验网址终检（与 Go 版 internal/relay/verify_hosts.go 同口径）        */
/* ------------------------------------------------------------------ */

/** 内置校验网址：权威解析稳定落在 Cloudflare 网段的知名站点（内置豁免 DNS 剔除）。 */
const BUILTIN_VERIFY_HOSTS = [
  'cloudflare.com',
  'chatgpt.com',
  'canva.com',
  'discord.com',
  'x.com',
]

/** Cloudflare 自家网段（与 Go 版 cloudflareRanges 同源，按需同步）。 */
const CF_RANGES: Array<{ base: [number, number, number, number]; bits: number }> = [
  { base: [104, 16, 0, 0], bits: 13 },
  { base: [104, 24, 0, 0], bits: 14 },
  { base: [172, 64, 0, 0], bits: 13 },
  { base: [162, 158, 0, 0], bits: 15 },
  { base: [188, 114, 96, 0], bits: 20 },
  { base: [198, 41, 128, 0], bits: 17 },
  { base: [103, 21, 244, 0], bits: 22 },
  { base: [103, 22, 200, 0], bits: 22 },
  { base: [103, 31, 4, 0], bits: 22 },
  { base: [141, 101, 64, 0], bits: 18 },
  { base: [108, 162, 192, 0], bits: 18 },
  { base: [190, 93, 240, 0], bits: 20 },
  { base: [197, 234, 240, 0], bits: 22 },
  { base: [131, 0, 72, 0], bits: 22 },
  { base: [1, 0, 0, 0], bits: 24 },
  { base: [1, 1, 1, 0], bits: 24 },
]

function isCloudflareIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  return CF_RANGES.some(({ base, bits }) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0
    const baseValue =
      (((base[0]! << 24) | (base[1]! << 16) | (base[2]! << 8) | base[3]!) >>> 0) & mask
    return (value & mask) === baseValue
  })
}

/** Node dns.resolve4 的 promisify 包装（模块级，测试可替换）。 */
const resolve4Async = async (host: string): Promise<string[]> => {
  const dns = await import('node:dns')
  return new Promise((resolve, reject) => {
    dns.resolve4(host, (err, addrs) => (err ? reject(err) : resolve(addrs)))
  })
}

/**
 * 合并「用户手填 + 内置」成实际用于终检的网址列表（上限 3 个）。
 *
 * 内置清单豁免 DNS 剔除（国内本地 DNS 会把 CF 站点解析到本地 CDN，
 * 运行时剔除会误杀内置清单）；用户手填的按解析结果剔除非 CF 网段。
 */
async function resolveVerifyHosts(userRaw: string, quiet: boolean): Promise<string[]> {
  const verifyHostLimit = 3
  const userHosts = userRaw
    .split(/[\r\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (host: string): void => {
    if (!host || seen.has(host) || out.length >= verifyHostLimit) return
    seen.add(host)
    out.push(host)
  }
  for (const host of userHosts) {
    if (BUILTIN_VERIFY_HOSTS.includes(host)) {
      add(host) // 内置豁免
      continue
    }
    try {
      const addrs = await resolve4Async(host)
      if (!addrs.some((ip) => isCloudflareIPv4(ip))) {
        if (!quiet) process.stderr.write(`已剔除校验网址 ${host}（解析结果不在 Cloudflare 网段）\n`)
        continue
      }
      add(host)
    } catch {
      if (!quiet) process.stderr.write(`已剔除校验网址 ${host}（解析失败）\n`)
    }
  }
  for (const h of BUILTIN_VERIFY_HOSTS) {
    if (out.length >= verifyHostLimit) break
    add(h)
  }
  return out
}

/**
 * 终检一个候选能否把流量转发到指定 CF 网段站点。
 *
 * 链路与 probeOne 一致，只是 TLS SNI 与 HTTP Host 换成校验网址；
 * 收到任何 HTTP 状态行都算转发成功（403 也证明 SNI 转发到了 CF 边缘）。
 */
async function verifyOne(
  opts: { wsUrl: string; uuid: string },
  ip: string,
  verifyHost: string,
  timeoutMs: number
): Promise<boolean> {
  let ws: WebSocket | undefined
  let socket: tls.TLSSocket | undefined
  try {
    const tunnel = await openTunnel(opts.wsUrl, opts.uuid, ip, 443, timeoutMs)
    ws = tunnel.ws
    socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(
        {
          socket: tunnel.duplex,
          servername: verifyHost,
          // 校验网址是公网站点：证书链 + 主机名照常校验
          rejectUnauthorized: true,
        },
        () => resolve(s)
      )
      s.once('error', reject)
    })
    socket.write(
      `GET / HTTP/1.1\r\nHost: ${verifyHost}\r\nUser-Agent: cfpilot-relay-verify\r\nConnection: close\r\n\r\n`
    )
    const res = await readHttp(socket, timeoutMs)
    return res.status > 0
  } catch {
    return false
  } finally {
    try {
      socket?.destroy()
    } catch {
      /* 已关闭 */
    }
    try {
      ws?.close()
    } catch {
      /* 已关闭 */
    }
  }
}

export async function runRelayCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(SCAN_RELAY_HELP)
    return
  }

  const file = flagString(args, 'file')
  const url = flagString(args, 'url')
  const host = flagString(args, 'host').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
  const wsPath = flagString(args, 'ws-path')
  const uuid = flagString(args, 'uuid')
  const rounds = Math.max(1, flagNumber(args, 'rounds', 2))
  const timeoutMs = Math.max(1000, flagNumber(args, 'timeout', DEFAULT_TIMEOUT_MS))
  // 并发可以调高：每条并发都是一条独立隧道（独立 Worker 请求），
  // 不受「单请求 6 条出站 TCP」的限制；上限只受本机与文件句柄约束。
  const concurrency = Math.max(1, flagNumber(args, 'concurrency', CONCURRENCY))
  const asJson = flagBool(args, 'json')
  const quiet = flagBool(args, 'quiet')
  /** 产出可粘贴进 ProxyIP 池的清单（按质量排序，一行一个 IP） */
  const outPath = flagString(args, 'out')
  const topN = Math.max(1, flagNumber(args, 'top', 10))
  /** 写入面板 ProxyIP 池：incremental（默认语义）/ overwrite */
  const pushRaw = flagString(args, 'push').trim().toLowerCase()
  const pushKind =
    pushRaw === 'append' ? 'incremental' : pushRaw === 'replace' ? 'overwrite' : pushRaw
  const panel = flagString(args, 'panel')
  const panelPassword = flagString(args, 'panel-password')
  /** 校验网址（终检）：逗号分隔；空 = 内置清单 */
  const verifyHostsRaw = flagString(args, 'verify-hosts')

  if (!host || !wsPath || !uuid) {
    process.stderr.write('缺少参数：--host、--ws-path、--uuid 都是必填\n')
    process.stderr.write('候选默认用内置清单；也可用 --file / --url 指定\n')
    process.stderr.write('用法见：cfpilot scan relay --help\n')
    process.exit(1)
  }
  if (pushKind && pushKind !== 'incremental' && pushKind !== 'overwrite') {
    process.stderr.write('✗ --push 只接受 incremental（增量）/ overwrite（覆盖）\n')
    process.exit(1)
  }
  if (pushKind && (!panel || !panelPassword)) {
    process.stderr.write('✗ --push 需要同时提供 --panel（控制面）与 --panel-password\n')
    process.exit(1)
  }

  let ips: string[]
  let rawCount = 0
  // 三个来源，优先级：显式文件 > 显式链接 > **内置清单**。
  // 内置清单随版本发布、用户不可修改 —— 让手上没有 IP 源的用户也能跑通。
  const sourceLabel = file ? `文件 ${file}` : url ? `链接 ${url}` : '内置清单'
  try {
    const raw = file
      ? readIpFile(readFileSync(file, 'utf8'))
      : url
        ? await readIpUrl(url)
        : readBuiltinRelayCandidates()
    rawCount = raw.length
    // 反代入口是「明文 TCP + 按 SNI 转发」，端口固定 443，只接受 IPv4 ——
    // IPv6 候选在这里没有意义，直接排除并在下面报告跳过条数。
    ips = raw.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
  } catch (err) {
    process.stderr.write(`✗ 读取候选失败：${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }
  if (ips.length === 0) {
    process.stderr.write(`✗ ${sourceLabel} 里没有可读的 IPv4 候选\n`)
    process.exit(1)
    return
  }
  if (rawCount > ips.length && !quiet) {
    process.stderr.write(`已忽略 ${rawCount - ips.length} 条非 IPv4 条目\n`)
  }

  const wsUrl = `wss://${host}${wsPath.startsWith('/') ? wsPath : '/' + wsPath}`

  // 先问数据面「你是什么版本」—— 后面每个候选都要拿这个值比对
  let expectedBuild = ''
  try {
    const res = await fetch(`https://${host}/__cfp_version`, { signal: AbortSignal.timeout(15_000) })
    const body = (await res.json()) as { build?: string }
    expectedBuild = typeof body.build === 'string' ? body.build : ''
  } catch (err) {
    process.stderr.write(`✗ 读不到数据面版本：${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }
  if (!expectedBuild) {
    process.stderr.write('✗ 数据面没有返回 build，无法比对\n')
    process.exit(1)
    return
  }

  if (!quiet) {
    process.stderr.write(
      `${NAME} v${VERSION} —— 反代入口出站体检\n` +
        `数据面 ${host} · 候选 ${ips.length} 个 · ${rounds} 轮 · 期望 build ${expectedBuild}\n`
    )
  }

  const perIp = new Map<string, ProbeOutcome[]>()
  for (const ip of ips) perIp.set(ip, [])
  const jobs: string[] = []
  for (let round = 0; round < rounds; round++) for (const ip of ips) jobs.push(ip)

  let next = 0
  let finished = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= jobs.length) return
      const ip = jobs[index]!
      const outcome = await probeOne({ wsUrl, uuid, host, expectedBuild }, ip, timeoutMs)
      perIp.get(ip)?.push(outcome)
      finished += 1
      if (!quiet) {
        process.stderr.write(
          `\r  进度 ${finished}/${jobs.length}  最近 ${ip} ${outcome.ok ? '✓' : '✗'}`.padEnd(72)
        )
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
  if (!quiet) process.stderr.write('\n')

  const aggregates: Aggregate[] = []
  for (const [ip, list] of perIp) {
    const passed = list.filter((o) => o.ok)
    const tlsValues = passed.map((o) => o.tlsMs).filter((v) => v > 0)
    aggregates.push({
      ip,
      rounds: list.length,
      passed: passed.length,
      successPct: list.length === 0 ? 0 : Math.round((passed.length / list.length) * 100),
      tunnelMs: median(passed.map((o) => o.tunnelMs).filter((v) => v > 0)),
      tlsMs: median(tlsValues),
      tlsP95: percentile(tlsValues, 95),
      httpMs: median(passed.map((o) => o.httpMs).filter((v) => v > 0)),
      errors: [...new Set(list.filter((o) => !o.ok).map((o) => o.error))].slice(0, 2),
    })
  }
  // 成功率是硬门槛，其次看 TLS 尾部与中位
  aggregates.sort((a, b) => {
    if (b.successPct !== a.successPct) return b.successPct - a.successPct
    if (a.tlsP95 !== b.tlsP95) return a.tlsP95 - b.tlsP95
    return a.tlsMs - b.tlsMs
  })

  const alwaysOk = aggregates.filter((a) => a.successPct === 100).length
  const neverOk = aggregates.filter((a) => a.successPct === 0).length

  // ---- 校验网址终检（与 Go 版同口径）----
  //
  // 只对「全通」候选做：逐个建独立隧道，实测能否把流量转到 CF 网段站点。
  // 任一网址转发成功即通过；全部失败 = 假入口，从 picked 里剔除。
  const verifyHosts = await resolveVerifyHosts(verifyHostsRaw, quiet)
  const verifyFailed = new Set<string>()
  if (verifyHosts.length > 0 && !quiet) {
    process.stderr.write(`校验网址终检：${verifyHosts.join(', ')}\n`)
  }
  if (verifyHosts.length > 0) {
    const passList = aggregates.filter((a) => a.successPct === 100).map((a) => a.ip)
    let vNext = 0
    const vWorker = async (): Promise<void> => {
      for (;;) {
        const k = vNext
        vNext += 1
        if (k >= passList.length) return
        const ip = passList[k]!
        let passed = false
        for (const host of verifyHosts) {
          if (await verifyOne({ wsUrl, uuid }, ip, host, timeoutMs)) {
            passed = true
            break
          }
        }
        if (!passed) verifyFailed.add(ip)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, passList.length) }, () => vWorker()))
    if (verifyFailed.size > 0 && !quiet) {
      process.stderr.write(`校验网址终检剔除 ${verifyFailed.size} 个假入口\n`)
    }
  }

  // 产出可直接粘贴的清单：只取**全通**的，按 TLS 中位排序，最多 topN 条。
  // 池子不是越大越好 —— 每条都要参与拨号竞速，塞几百条反而拖慢选路。
  const picked = aggregates
    .filter((a) => a.successPct === 100 && !verifyFailed.has(a.ip))
    .slice(0, topN)
    .map((a) => a.ip)
  if (outPath) {
    writeFileSync(outPath, picked.join('\n') + (picked.length > 0 ? '\n' : ''), 'utf8')
    if (!quiet) process.stderr.write(`已写出 ${picked.length} 条到 ${outPath}\n`)
  }

  // ---- 写入面板 ProxyIP 池 ----
  //
  // 与「入口优选」的回填是两回事：那边写的是「手动优选 IP 池」（会进订阅、
  // 每个 IP 变成一个节点），这里写的是 `proxyIp`（只是 Worker 的出站选路，
  // **不进订阅**）。混用会把 260 个反代 IP 变成 260 个节点。
  if (pushKind) {
    if (picked.length === 0) {
      if (!quiet) process.stderr.write('没有全通项，跳过写入面板\n')
    } else {
      const current = await getPanelConfig(panel, panelPassword)
      if (!current.ok) {
        process.stderr.write(`✗ 读取面板配置失败：${current.error}\n`)
        process.exitCode = 1
      } else {
        const existing = String(current.config?.proxyIp ?? '')
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
        const next = pushKind === 'overwrite' ? picked : [...new Set([...existing, ...picked])]
        const written = await patchPanelConfig(panel, panelPassword, { proxyIp: next.join('\n') })
        if (!written.ok) {
          process.stderr.write(`✗ 写入面板失败：${written.error}\n`)
          process.exitCode = 1
        } else if (!quiet) {
          const verb = pushKind === 'overwrite' ? '覆盖写入' : '增量写入'
          const added = next.length - existing.length
          process.stderr.write(
            `已${verb}面板 ProxyIP 池：本次 ${picked.length} 条` +
              (pushKind === 'overwrite' ? '' : `（新增 ${Math.max(0, added)} 条）`) +
              `，池内共 ${next.length} 条\n`
          )
        }
      }
    }
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tool: 'cfpilot',
          version: VERSION,
          command: 'scan relay',
          params: { source: sourceLabel, host, wsPath, rounds, targets: ips.length },
          expectedBuild,
          summary: { alwaysOk, neverOk, flaky: aggregates.length - alwaysOk - neverOk },
          results: aggregates,
        },
        null,
        2
      )}\n`
    )
    return
  }

  process.stdout.write(`\n候选 ${aggregates.length} 个 · ${rounds} 轮 · 数据面 ${host}\n`)
  process.stdout.write(`全通 ${alwaysOk} · 抖动 ${aggregates.length - alwaysOk - neverOk} · 全挂 ${neverOk}\n\n`)
  const head = ['IP', '成功%', '轮次', '隧道ms', 'TLS中位', 'TLSP95', 'HTTPms', '失败原因']
  const rows = aggregates.slice(0, 30).map((a) => [
    a.ip,
    String(a.successPct),
    `${a.passed}/${a.rounds}`,
    String(a.tunnelMs),
    String(a.tlsMs),
    String(a.tlsP95),
    String(a.httpMs),
    a.errors[0] ?? (verifyFailed.has(a.ip) ? '校验网址失败（假入口）' : ''),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  process.stdout.write(line(head) + '\n')
  process.stdout.write(widths.map((w) => '─'.repeat(w)).join('  ') + '\n')
  for (const row of rows) process.stdout.write(line(row) + '\n')
  if (aggregates.length > rows.length) {
    process.stdout.write(`\n（只列前 ${rows.length} 名，完整结果用 --json）\n`)
  }
  process.stdout.write('\n提示：把通过率高的前几条填入面板「入站配置 → ProxyIP 池」（每行一条）。\n')
}
