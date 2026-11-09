/**
 * XHTTP 入站处理（stream-one + packet-up）
 *
 * Xray 的 XHTTP 有三种模式：
 *   stream-one: 单请求全双工（POST /<path>，请求体上行、响应体下行）
 *   packet-up:  分包上行 + 流式下行（POST /<path>/<会话>/<seq> 多个短 POST 上行，
 *               GET /<path>/<会话> 流式下行，会话由 path 中的随机 UUID 关联）
 *   stream-up:  流式上行 + 流式下行（POST /<path>/<会话> 长连接上行 + GET 下行）
 *
 * 部署到 Cloudflare 时只有 packet-up 与 stream-one 可用：
 *   - stream-one/up 需要单请求全双工，CF 边缘对 Pages/Workers 的 POST 会缓冲
 *     请求体，服务端看不到首包就会死锁（真机实测 H1/H2 均复现）；
 *   - Xray 默认把上行 Content-Type 伪装成 application/grpc，
 *     CF 边缘在未开启 gRPC 支持时直接 403（*.pages.dev 无法开启），
 *     表现为全部 -1。订阅侧已用 extra 的 noGRPCHeader 关闭该伪装。
 * 因此默认订阅用 packet-up；stream-one 保留给自定义域名且已开启 gRPC 的部署。
 */
import type { UserConfig } from '../types'
import { ByteStream } from './stream'
import { parseVless, parseVlessBuffer, VLESS_COMMAND_TCP, type VlessHeader } from './vless'
import type { DialResult, ProxyEndpoint } from '../outbound/dial'
import { relay, TrafficMeter } from '../budget'

import { dial } from '../outbound/dial'

/**
 * XHTTP 请求头读取截止时间。
 *
 * ## 为什么要
 *
 * `parseVless` 从请求体里按需读取，**本身没有超时**：
 * 客户端把 POST body 停在不完整的 VLESS 头上（或扫描器直接发个半截 body），
 * 这个请求就会一直挂到运行时超时才回收 —— 期间占着一个 isolate 与一条子请求。
 *
 * 2 秒与 WebSocket 入站的握手截止时间保持一致（真实客户端都是立即发完整头）。
 */
const HEADER_DEADLINE_MS = 2000

/** 给一个 Promise 加截止时间；超时返回 `null` */
function withDeadline<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

export interface XhttpResult {
  response: Response
  dialResult: DialResult
}

/** 最近一次 XHTTP 出站诊断（isolate 级） */
const XHTTP_DIAGNOSTICS: Array<{ at: number; target: string; kind: string; message: string; candidate: string; summary: string }> = []

/** 记录 XHTTP 出站诊断 */
export function recordXhttpDiagnostics(
  target: string,
  failure: { kind: string; message: string; candidate: string },
  summary: string
): void {
  XHTTP_DIAGNOSTICS.unshift({ at: Date.now(), target, ...failure, summary })
  if (XHTTP_DIAGNOSTICS.length > 20) XHTTP_DIAGNOSTICS.length = 20
}

/** 读取 XHTTP 诊断 */
export function recentXhttpDiagnostics(): typeof XHTTP_DIAGNOSTICS {
  return XHTTP_DIAGNOSTICS
}

/* ------------------------------------------------------------------ */
/* 路径解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * XHTTP 路由解析结果。
 *
 * base 归一化：去掉尾部斜杠（配置写 /xhttp 或 /xhttp/ 都认）。
 * Xray 在 stream-one 下会给 path 补尾部斜杠（填 /xhttp 实际请求 /xhttp/），
 * 只认精确匹配就会把真实客户端全挡在外面（返回中性页）。
 */
export type XhttpRoute =
  | { kind: 'stream-one' }
  | { kind: 'packet-up'; sessionId: string; seq: number }
  | { kind: 'session'; sessionId: string }

function normalizeBase(base: string): string {
  const trimmed = String(base || '').trim()
  const withoutSlash = trimmed.replace(/\/+$/, '')
  return withoutSlash || '/'
}

/** 解析 XHTTP 请求路径；不匹配返回 null（外层返回中性页） */
export function parseXhttpRoute(pathname: string, baseValue: string | undefined): XhttpRoute | null {
  const base = normalizeBase(baseValue ?? '/xhttp')
  // stream-one：base 本身或 base + '/'
  if (pathname === base || pathname === `${base}/`) return { kind: 'stream-one' }
  const prefix = `${base}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (!rest) return null
  const parts = rest.split('/')
  // 下行 / 流式上行：<会话>
  if (parts.length === 1 && parts[0]) {
    // 会话 id 不含空白与控制字符
    if (/[\s\u0000-\u001f]/.test(parts[0])) return null
    return { kind: 'session', sessionId: parts[0] }
  }
  // 分包上行：<会话>/<seq>
  if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1]!)) {
    if (/[\s\u0000-\u001f]/.test(parts[0])) return null
    const seq = Number(parts[1])
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > 1_000_000) return null
    return { kind: 'packet-up', sessionId: parts[0], seq }
  }
  return null
}

/** 是否是 XHTTP 受理路径（供路由层判断，含 stream-one 与会话路径） */
export function isXhttpPath(pathname: string, baseValue: string | undefined): boolean {
  return parseXhttpRoute(pathname, baseValue) !== null
}

/* ------------------------------------------------------------------ */
/* packet-up 会话                                                      */
/* ------------------------------------------------------------------ */

/**
 * packet-up 会话（isolate 级内存）。
 *
 * 上行 POST 与下行 GET 是两个独立的 HTTP 请求，
 * 靠 path 里的随机会话 id 关联（Xray 官方设计）。
 * H2 多路复用时同一连接的请求必落同一边缘机房，
 * 同一 isolate 内内存关联可用；H1 散落多 isolate 时对端会自然重试。
 */
interface XhttpSession {
  id: string
  createdAt: number
  lastSeen: number
  /** seq 0 解析出的 VLESS 头；未到达时 undefined */
  header: VlessHeader | undefined
  headerWaiters: Array<(header: VlessHeader | null) => void>
  /** 出站拨号（由下行 GET 触发，避免短 POST 的 waitUntil 掐断后台泵） */
  dialPromise: Promise<DialResult> | null
  dialResult: DialResult | null
  /** seq -> 上行字节（seq 0 的为头之后剩余字节） */
  pending: Map<number, Uint8Array>
  nextPumpSeq: number
  pumpStarted: boolean
  /** 上行新块通知 */
  signalResolve: (() => void) | null
  traffic: TrafficMeter
  downlinkStarted: boolean
  closed: boolean
  targetLabel: string
}

const XHTTP_SESSIONS = new Map<string, XhttpSession>()
const SESSION_ASSOCIATE_MS = 30_000
const SESSION_MAX = 100
const SESSION_IDLE_MS = 10 * 60_000
/** packet-up 单 POST 上限（官方默认 1MB，这里放宽到 10MB 防误杀） */
const PACKET_MAX_BYTES = 10 * 1024 * 1024
/** 服务端最多缓存未泵出的分包数（官方默认 30） */
const PACKET_MAX_BUFFERED = 30

/**
 * isolate 级「未鉴权暂存」总预算。
 *
 * ## 为什么必须有这个上限
 *
 * packet-up 的 `seq >= 1` 分包**不需要** VLESS 头就能暂存（头只在 `seq = 0`
 * 校验）。于是任何人只要 `POST /xhttp/<任意随机 id>/<seq>` 就能往 isolate 里塞字节：
 *
 *   - 单会话最坏 = `PACKET_MAX_BUFFERED(30)` × `PACKET_MAX_BYTES(10MB)` = **300MB**；
 *   - `SESSION_MAX(100)` 个会话 ⇒ 理论 **30GB**；
 *   - 而 Workers 单 isolate 的内存上限是 **128MB**。
 *
 * 对照 WebSocket 路径：那边有 `MAX_RETAINED_TOTAL_BYTES = 32MiB` 的 isolate 级总量闸门，
 * XHTTP 起初**没有对应物** —— 也就是说新协议路径上多了一个「零成本占内存」的入口。
 *
 * ## 口径
 *
 * 记的是**实际暂存**的字节数（与 WebSocket 路径同口径：已确认通路的上行留存）。
 * 超预算的会话直接关闭（503），客户端重连后仍会走直连 —— 不会变成黑洞。
 *
 * 取 32 MiB：与 WebSocket 路径的 `MAX_RETAINED_TOTAL_BYTES` **同口径**，
 * 足够覆盖「TLS ClientHello + 大 POST 首包」的正常重放（几 KB~几 MB），
 * 又能把极端占用压到 isolate 内存上限（128 MiB）的四分之一。
 */
const MAX_RETAINED_TOTAL_BYTES = 32 * 1024 * 1024

/** 当前 isolate 内所有会话的暂存总量（模块级，跨会话共享） */
let retainedTotalBytes = 0

/**
 * 归还会话暂存的字节数。
 *
 * 会话关闭时必须调用 —— 否则额度只增不减，跑到一定量之后**所有**新会话都会被拒。
 */
function releaseRetained(bytes: number): void {
  retainedTotalBytes -= bytes
  if (retainedTotalBytes < 0) retainedTotalBytes = 0
}

/** 会话当前暂存的字节数 */
function sessionRetained(session: XhttpSession): number {
  let total = 0
  for (const chunk of session.pending.values()) total += chunk.byteLength
  return total
}

/**
 * 预留 isolate 级暂存额度；超限返回 false（调用方应拒绝并关闭会话）。
 *
 * 注意：预留发生在**写入 pending 之前**，所以额度与实际暂存始终一致；
 * 泵出时由 `releaseRetained` 归还。
 */
function reserveRetained(session: XhttpSession, bytes: number): boolean {
  if (bytes <= 0) return true
  if (retainedTotalBytes + bytes > MAX_RETAINED_TOTAL_BYTES) return false
  retainedTotalBytes += bytes
  return true
}

/** 只给测试隔离用 */
export function clearXhttpSessions(): void {
  for (const [key, value] of XHTTP_SESSIONS) {
    closeSession(key, value)
  }
  XHTTP_SESSIONS.clear()
  retainedTotalBytes = 0
}

function getOrCreateSession(id: string, trafficLimitBytes: number): XhttpSession {
  const now = Date.now()
  // 惰性清理过期与闲置会话，避免无界增长
  //
  // ⚠️ 这里必须走 closeSession（而不是直接 delete）：
  // 直接 delete 会**漏掉暂存字节的归还**，额度只增不减 ——
  // 跑到一定量之后所有新会话都会被 503 拒掉（假死）。
  for (const [key, value] of XHTTP_SESSIONS) {
    if (value.closed || now - value.lastSeen > SESSION_IDLE_MS || now - value.createdAt > 30 * 60_000) {
      closeSession(key, value)
    }
  }
  const existing = XHTTP_SESSIONS.get(id)
  if (existing) {
    existing.lastSeen = now
    return existing
  }
  if (XHTTP_SESSIONS.size >= SESSION_MAX) {
    // 满了就淘汰最旧的，让新会话可用
    const oldest = XHTTP_SESSIONS.keys().next().value
    if (oldest !== undefined) {
      const old = XHTTP_SESSIONS.get(oldest)
      if (old) closeSession(oldest, old)
      else XHTTP_SESSIONS.delete(oldest)
    }
  }
  const session: XhttpSession = {
    id,
    createdAt: now,
    lastSeen: now,
    header: undefined,
    headerWaiters: [],
    dialPromise: null,
    dialResult: null,
    pending: new Map(),
    nextPumpSeq: 0,
    pumpStarted: false,
    signalResolve: null,
    traffic: new TrafficMeter(trafficLimitBytes),
    downlinkStarted: false,
    closed: false,
    targetLabel: '',
  }
  XHTTP_SESSIONS.set(id, session)
  return session
}

function closeSession(id: string, session: XhttpSession): void {
  if (session.closed) return
  session.closed = true
  // 唤醒等待头与泵，避免挂死
  for (const waiter of session.headerWaiters) {
    try {
      waiter(null)
    } catch {
      /* 已关闭 */
    }
  }
  session.headerWaiters = []
  session.signalResolve?.()
  session.signalResolve = null
  if (session.dialResult?.close) {
    try {
      void session.dialResult.close()
    } catch {
      /* 已关闭 */
    }
  }
  // 归还暂存额度（否则 isolate 级预算只增不减，最终把所有会话都拒掉）
  releaseRetained(sessionRetained(session))
  session.pending.clear()
  XHTTP_SESSIONS.delete(id)
}

function notifyChunk(session: XhttpSession): void {
  const resolve = session.signalResolve
  session.signalResolve = null
  resolve?.()
}

/** 等待 VLESS 头（下行 GET 先到时用，超时返回 null） */
function waitForHeader(session: XhttpSession, timeoutMs: number): Promise<VlessHeader | null> {
  if (session.header) return Promise.resolve(session.header)
  if (session.closed) return Promise.resolve(null)
  return new Promise<VlessHeader | null>((resolve) => {
    const waiter = (header: VlessHeader | null): void => {
      clearTimeout(timer)
      resolve(header)
    }
    const timer = setTimeout(() => {
      const index = session.headerWaiters.indexOf(waiter)
      if (index >= 0) session.headerWaiters.splice(index, 1)
      resolve(null)
    }, timeoutMs)
    session.headerWaiters.push(waiter)
  })
}

function publishHeader(session: XhttpSession, header: VlessHeader): void {
  session.header = header
  const waiters = session.headerWaiters
  session.headerWaiters = []
  for (const waiter of waiters) {
    try {
      waiter(header)
    } catch {
      /* 已关闭 */
    }
  }
}

/** XHTTP 响应头（下行流式伪装 + 跨域，供 Browser Dialer） */
function xhttpHeaders(extra?: Record<string, string>): Record<string, string> {
  // header padding：官方服务端默认附 100-1000 字节 X，抗固定特征；这里给随机长度
  const padLen = 100 + Math.floor(Math.random() * 900)
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST',
    'X-Padding': 'X'.repeat(padLen),
    ...extra,
  }
}

function buildVlessResponseHeader(header: VlessHeader): Uint8Array {
  const addons = header.addons
  const out = new Uint8Array(2 + addons.byteLength)
  out[0] = header.version
  out[1] = addons.byteLength
  out.set(addons, 2)
  return out
}

async function ensureDial(
  session: XhttpSession,
  config: UserConfig,
  proxies: ProxyEndpoint[]
): Promise<DialResult> {
  if (session.dialResult) return session.dialResult
  if (!session.dialPromise) {
    const header = session.header
    if (!header) throw new Error('VLESS 头未到达')
    session.targetLabel = `${header.hostname}:${header.port}`
    session.dialPromise = dial({
      hostname: header.hostname,
      port: header.port,
      proxies,
      nat64: config.nat64,
      concurrent: config.concurrentDial,
      proxyMode: config.proxyMode,
      resolvePreferred: config.resolvePreferred,
      relayPool: {
        userEntries: config.relayPool || undefined,
        useBuiltin: config.useBuiltinRelay,
      },
      onFailure: (failure) => {
        recordXhttpDiagnostics(session.targetLabel, failure, `XHTTP 出站失败（${failure.candidate}）：${failure.message}`)
      },
    })
      .then((result) => {
        session.dialResult = result
        return result
      })
      .catch((err: unknown) => {
        recordXhttpDiagnostics(
          session.targetLabel,
          { kind: 'dial', message: String(err), candidate: 'all' },
          `XHTTP 出站全部失败：${String(err)}`
        )
        throw err
      })
  }
  return await session.dialPromise
}

/** 上行泵：把按 seq 重组的上行按序写入出站 */
async function pumpUplink(session: XhttpSession, dialResult: DialResult): Promise<void> {
  const writer = dialResult.writable.getWriter()
  try {
    for (;;) {
      if (session.closed) break
      const chunk = session.pending.get(session.nextPumpSeq)
      if (chunk) {
        session.pending.delete(session.nextPumpSeq)
        session.nextPumpSeq += 1
        // 泵出即归还暂存额度（否则额度只增不减，最终把所有会话都拒掉）
        releaseRetained(chunk.byteLength)
        if (chunk.byteLength === 0) continue
        if (session.traffic.add(chunk.byteLength)) {
          recordXhttpDiagnostics(session.targetLabel, { kind: 'budget', message: '流量超限', candidate: 'traffic' }, 'XHTTP 上行流量超限')
          break
        }
        try {
          await writer.write(chunk)
        } catch (err) {
          recordXhttpDiagnostics(
            session.targetLabel,
            { kind: 'relay-write', message: String(err), candidate: dialResult.endpoint },
            `XHTTP 写入目标失败：${String(err)}`
          )
          break
        }
        continue
      }
      // 无可泵的下一块：等下一 POST 通知
      let resolveSignal: (() => void) | null = null
      const signal = new Promise<void>((resolve) => {
        resolveSignal = resolve
      })
      session.signalResolve = resolveSignal
      // 避免竞态：等前再检查一次（POST 可能在挂上信号前已到）
      if (session.pending.has(session.nextPumpSeq) || session.closed) {
        session.signalResolve = null
        continue
      }
      await signal
    }
  } finally {
    try {
      writer.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
}

/** packet-up 上行分包（短 POST，完整 body） */
async function handlePacketUpChunk(
  request: Request,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  sessionId: string,
  seq: number
): Promise<Response | null> {
  void proxies
  const trafficLimit = (config.dataBudgetMB || 0) * 1024 * 1024
  const session = getOrCreateSession(sessionId, trafficLimit)
  if (session.closed) return null

  // ⚠️ 先按 Content-Length 拒掉超限的包，**再**读 body。
  //
  // 顺序反了的话，一个 100MB 的包会先被 arrayBuffer() **完整读进内存**
  // 才判超限 —— 那一刻内存已经分配出去了，拒绝也来不及
  // （Workers isolate 上限 128MB，一次就能把它顶爆）。
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > PACKET_MAX_BYTES) {
    return new Response('分包超出上限', { status: 413, headers: xhttpHeaders() })
  }

  let body: Uint8Array
  try {
    const buffer = await request.arrayBuffer()
    body = new Uint8Array(buffer)
  } catch {
    return new Response('请求体读取失败', { status: 400, headers: xhttpHeaders() })
  }
  if (body.byteLength > PACKET_MAX_BYTES) {
    return new Response('分包超出上限', { status: 413, headers: xhttpHeaders() })
  }

  if (seq === 0 && !session.header) {
    const parsed = parseVlessBuffer(body, config.uuid)
    if (!parsed) {
      closeSession(sessionId, session)
      return new Response('VLESS 头解析失败', { status: 400, headers: xhttpHeaders() })
    }
    if (parsed.header.command !== VLESS_COMMAND_TCP) {
      closeSession(sessionId, session)
      return new Response('XHTTP 暂不支持 UDP', { status: 400, headers: xhttpHeaders() })
    }
    publishHeader(session, parsed.header)
    session.targetLabel = `${parsed.header.hostname}:${parsed.header.port}`
    const rest = body.subarray(parsed.consumed)
    // 已泵过的 seq 直接忽略（重传）
    if (seq >= session.nextPumpSeq && !session.pending.has(seq)) {
      if (!reserveRetained(session, rest.byteLength)) {
        closeSession(sessionId, session)
        return new Response('暂存超限', { status: 503, headers: xhttpHeaders() })
      }
      if (session.pending.size >= PACKET_MAX_BUFFERED) {
        closeSession(sessionId, session)
        return new Response('分包缓存已满', { status: 503, headers: xhttpHeaders() })
      }
      session.pending.set(seq, rest.slice())
    }
  } else {
    if (seq < session.nextPumpSeq || session.pending.has(seq)) {
      // 重复/已泵：幂等忽略
      return new Response(null, { status: 200, headers: xhttpHeaders() })
    }
    // ⚠️ seq >= 1 的分包**没有 VLESS 头**（头只在 seq = 0 校验），
    // 所以这里必须先过 isolate 级暂存预算 —— 否则任何人都能
    // `POST /xhttp/<任意随机 id>/<seq>` 免费占用 isolate 内存。
    if (!reserveRetained(session, body.byteLength)) {
      closeSession(sessionId, session)
      return new Response('暂存超限', { status: 503, headers: xhttpHeaders() })
    }
    if (session.pending.size >= PACKET_MAX_BUFFERED) {
      closeSession(sessionId, session)
      return new Response('分包缓存已满', { status: 503, headers: xhttpHeaders() })
    }
    session.pending.set(seq, body.slice())
  }
  notifyChunk(session)
  return new Response(null, { status: 200, headers: xhttpHeaders() })
}

/** packet-up 下行（GET 长流） */
async function handleSessionDownlink(
  request: Request,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  sessionId: string
): Promise<Response | null> {
  void request
  const trafficLimit = (config.dataBudgetMB || 0) * 1024 * 1024
  const session = getOrCreateSession(sessionId, trafficLimit)
  if (session.closed || session.downlinkStarted) return null
  session.downlinkStarted = true

  const headerPromise = waitForHeader(session, SESSION_ASSOCIATE_MS)
  let cancelled = false
  let downReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
  let headerSent = false
  let dialResult: DialResult | null = null

  const cleanup = (): void => {
    closeSession(sessionId, session)
  }

  const combined = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller
    },
    async pull(controller) {
      if (cancelled) return
      try {
        if (!headerSent) {
          const header = await headerPromise
          if (cancelled) return
          if (!header) {
            cleanup()
            controller.close()
            return
          }
          try {
            dialResult = await ensureDial(session, config, proxies)
          } catch {
            cleanup()
            controller.close()
            return
          }
          if (cancelled) return
          // 上行泵随下行一起起（泵的生命周期与下行流绑定）
          if (!session.pumpStarted) {
            session.pumpStarted = true
            void pumpUplink(session, dialResult).catch(() => {
              /* 泵内已记录 */
            })
          }
          try {
            controller.enqueue(buildVlessResponseHeader(header))
          } catch {
            /* 已关闭 */
          }
          headerSent = true
          return
        }
        if (!dialResult) return
        if (!downReader) downReader = dialResult.readable.getReader()
        const { done, value } = await downReader.read()
        if (cancelled) return
        if (done) {
          cleanup()
          try {
            controller.close()
          } catch {
            /* 已关闭 */
          }
          return
        }
        if (value && value.byteLength > 0) {
          if (session.traffic.add(value.byteLength)) {
            recordXhttpDiagnostics(session.targetLabel, { kind: 'budget', message: '流量超限', candidate: 'traffic' }, 'XHTTP 下行流量超限')
            cleanup()
            try {
              controller.close()
            } catch {
              /* 已关闭 */
            }
            return
          }
          controller.enqueue(value)
        }
      } catch (err) {
        if (cancelled) return
        cleanup()
        try {
          controller.error(err)
          void bodyController
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel(reason) {
      cancelled = true
      if (dialResult) {
        try {
          void dialResult.readable.cancel(reason)
        } catch {
          /* 已取消 */
        }
      }
      cleanup()
    },
  })

  return new Response(combined, { status: 200, headers: xhttpHeaders() })
}

/** 解析 XHTTP 请求并建立出站连接，返回流式响应 */
export async function handleXhttp(
  request: Request,
  config: UserConfig,
  proxies: ProxyEndpoint[]
): Promise<Response | null> {
  let pathname = '/xhttp'
  try {
    pathname = new URL(request.url).pathname
  } catch {
    pathname = '/xhttp'
  }
  const route = parseXhttpRoute(pathname, config.xhttpPath)
  if (!route) return null
  if (route.kind === 'stream-one') {
    if (request.method !== 'POST') return null
    return await handleStreamOne(request, config, proxies)
  }
  if (route.kind === 'packet-up') {
    if (request.method !== 'POST') return null
    return await handlePacketUpChunk(request, config, proxies, route.sessionId, route.seq)
  }
  // session：GET 下行；stream-up 的 POST 流式上行本部署不受理（同包内走 packet-up 更稳）
  if (request.method === 'GET') return await handleSessionDownlink(request, config, proxies, route.sessionId)
  return null
}

/** stream-one：单请求全双工（保留给自定义域名 + gRPC 已启用的部署） */
async function handleStreamOne(
  request: Request,
  config: UserConfig,
  proxies: ProxyEndpoint[]
): Promise<Response> {
  const body = request.body
  if (!body) {
    return new Response('缺少请求体', { status: 400 })
  }

  const stream = new ByteStream(body)
  const parsed = await withDeadline(parseVless(stream, config.uuid), HEADER_DEADLINE_MS)
  if (!parsed) {
    // 超时或解析失败：必须由 ByteStream 取消它自己持有的 reader。
    //
    // ⚠️ 直接 `body.cancel()` 是无效的 —— 原始流已被 `getReader()` 锁定，
    // cancel 会抛错（被吞掉），解析任务里的 `reader.read()` 仍然挂着，
    // 直到客户端断开或运行时超时。扫描器发半截 VLESS 头即可持续占用资源。
    await stream.cancel('header timeout')
    return new Response('VLESS 头解析失败', { status: 400 })
  }
  if (parsed.header.command !== VLESS_COMMAND_TCP) {
    // 必须显式取消剩余请求体。
    //
    // `parseVless()` 结尾调用了 `stream.release()`，把 body 的 reader 交到了
    // `parsed.payload` 手上。直接 return 响应的话，没有任何一方去取消它：
    // 客户端还在继续发字节，服务端不读，这条读取任务会一直挂到运行时超时。
    // 扫描器发一个 UDP 命令 + 半截 body 就能持续占用资源。
    //
    // ⚠️ 不能写成 `body.cancel()` —— 原始流已被 getReader() 锁定，cancel 会抛错
    // 并被吞掉（见 protocols/stream.ts 的注释）。必须取消 release() 出来的那个流：
    // 它的 cancel 会转发给底层 reader。
    await parsed.payload.cancel('unsupported UDP')
    return new Response('XHTTP 暂不支持 UDP', { status: 400 })
  }

  let dialResult: DialResult
  try {
    dialResult = await dial({
    hostname: parsed.header.hostname,
    port: parsed.header.port,
    proxies,
    nat64: config.nat64,
    concurrent: config.concurrentDial,
    // 代理调度模式（与 WS 入站路径保持一致）
    proxyMode: config.proxyMode,
    // ⚠️ 这两项必须与 WS 入站路径保持一致：
    // 少了它们，XHTTP 会**用运行时自己的 DNS 解析**目标域名 ——
    // 而运行时的解析结果可能落在 Cloudflare 网段（Worker 不能连回自家 Anycast），
    // 表现为「XHTTP 节点延迟全是 -1」，但服务端看不出任何错误。
    resolvePreferred: config.resolvePreferred,
    relayPool: {
      userEntries: config.relayPool || undefined,
      useBuiltin: config.useBuiltinRelay,
    },
    // 失败分级上报：XHTTP 出站失败此前**完全不可诊断**（表现就是客户端延迟 -1），
    // 排查时看不到任何线索。现在记录到诊断端点。
    onFailure: (failure) => {
      recordXhttpDiagnostics(
        `${parsed.header.hostname}:${parsed.header.port}`,
        failure,
        `XHTTP 出站失败（${failure.candidate}）：${failure.message}`
      )
    },
    })
  } catch (err) {
    // 出站失败此前会抛到最外层、变成无信息的 500。
    // 这里转成受控响应（不暴露目标地址），并记进诊断端点。
    recordXhttpDiagnostics(
      `${parsed.header.hostname}:${parsed.header.port}`,
      { kind: 'dial', message: String(err), candidate: 'all' },
      `XHTTP 出站全部失败：${String(err)}`
    )
    // 同理：上行流是从 ByteStream 释放出来的包装流，取消它才会真正取消底层 reader
    try {
      void parsed.payload.cancel('dial failed').catch(() => {})
    } catch {
      /* 已关闭 */
    }
    return new Response('出站不可用', { status: 502 })
  }

  // 上行：请求体剩余部分 → 出站
  //
  // ⚠️ `closeTarget: false` —— 关闭 socket 的写流等于关闭整个 TCP 连接，
  // 目标站会收到 RST 而来不及把响应发回来。
  // 对比：WebSocket 入站路径只 releaseLock 不 close，是正常的。
  //
  // 实际发起放在下方（响应流建完之后）—— 上行计量器需要那里的作用域。
  // 下行：出站 → 响应体，由下方 combined 流**直接**从 dialResult.readable 拉取。
  // 中间不再套一层 TransformStream：同一份下行少一次拷贝与一对流控制器。

  // VLESS 响应头：版本(1) + Addons 长度(1) + Addons（原样回显请求里的 Addons）。
  // Xray 客户端要求先读到这个头才认为入站已建立，缺失时会把后续下行数据当作协议错误丢弃。
  const addons = parsed.header.addons
  if (addons.byteLength > 255) {
    return new Response('Addons 长度超出 VLESS 协议上限', { status: 400 })
  }
  const header = new Uint8Array(2 + addons.byteLength)
  header[0] = parsed.header.version
  header[1] = addons.byteLength
  header.set(addons, 2)

  // 把响应头与下行流拼接：头部先行，下行数据随后。
  // ⚠️ **不能用 async start 承载整个下行**：
  //
  // `start` 返回的 Promise 未完成时，流的 `pull` 不会被调用，
  // 而消费者（`fetch` / Xray 客户端）会一直等 —— 表现为
  // 「响应头到了，但**永远收不到后续数据**」（客户端侧就是延迟 -1）。
  //
  // 正确做法：`start` 立即返回（只把响应头入队），
  // 后续下行数据在 `pull` 里按需读取。
  let headerSent = false
  let downReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  /**
   * 客户端是否已经取消。
   *
   * pull 是异步的：cancel 之后仍可能有 pending 的 read() 返回/抛错，
   * 那时再去碰 controller 会抛 `ERR_INVALID_STATE`（流已关闭）——
   * 表现为「测试全绿但进程报未处理异常」，真机上则是日志噪音。
   */
  let cancelled = false

  /**
   * 单连接流量计量（上下行合计，0 = 不限制）。
   *
   * 与 WebSocket 入站同一口径，配置项同为 `dataBudgetMB`。
   * 数据面没有任何 CPU 预算约束（`CpuBudget` 只管控制面），
   * 一条超大流量连接能把账号当日配额吃穿，超限主动断流让客户端重连。
   */
  const traffic = new TrafficMeter((config.dataBudgetMB || 0) * 1024 * 1024)

  /** 响应流控制器（流量熔断时用它正常收尾） */
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null

  /**
   * 流量熔断：关闭出站 Socket + 结束响应流。
   *
   * 用 `close()` 而不是 `error()`：客户端会把异常断流当成目标站报错并停止重试，
   * 而这里我们是主动结束，正常 EOF 才是「可重连」的信号。
   */
  const cutByTraffic = (): void => {
    if (cancelled) return
    cancelled = true
    const reason = `单连接流量超过 ${config.dataBudgetMB}MB 上限`
    recordXhttpDiagnostics(
      `${parsed.header.hostname}:${parsed.header.port}`,
      { kind: 'budget', message: reason, candidate: 'traffic' },
      reason
    )
    if (dialResult.close) {
      try {
        void dialResult.close()
      } catch {
        /* 已关闭 */
      }
    }
    try {
      bodyController?.close()
    } catch {
      /* 已关闭 */
    }
  }

  /** 上行计量：超限即熔断（返回 true 让 relay 停止中继） */
  const onUpstreamChunk = (bytes: number): boolean => {
    if (!traffic.add(bytes)) return false
    cutByTraffic()
    return true
  }

  void relay(
    parsed.payload,
    dialResult.writable,
    undefined,
    false,
    onUpstreamChunk,
    (err, phase) => {
      // 原先所有中继异常都被吞成一句「忽略传输错误」，
      // 客户端取消、上游重置、写入失败在诊断里长得一模一样。
      // 这里按「读/写阶段 + 错误形态」分类，写进 /__diag 的 xhttp 记录。
      const message = err instanceof Error ? err.message : String(err)
      let kind = `relay-${phase}`
      if (/cancel|abort|closed/i.test(message)) kind = `relay-${phase}-client-cancel`
      else if (/reset|broken pipe/i.test(message)) kind = `relay-${phase}-upstream-reset`
      recordXhttpDiagnostics(
        `${parsed.header.hostname}:${parsed.header.port}`,
        { kind, message: message.slice(0, 200), candidate: dialResult.endpoint },
        `XHTTP 中继${phase === 'read' ? '读上游' : '写目标'}失败（${kind}）：${message.slice(0, 120)}`
      )
    }
  ).catch(() => {
    /* 客户端取消 / 出站已关闭：写入失败属预期，不构成未处理异常 */
  })

  const combined = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller
      // 只入队响应头（2 字节），立即结束 start
      controller.enqueue(header)
      headerSent = true
    },
    async pull(controller) {
      if (cancelled || !headerSent) return
      if (!downReader) downReader = dialResult.readable.getReader()
      try {
        const { done, value } = await downReader.read()
        if (cancelled) return
        if (done) {
          // 下行结束 = 连接结束：必须关闭出站 Socket。
          // 只 close 响应流的话 TCP 连接仍然开着，一直占着
          // 「单请求 6 条并发出站」里的一个槽位（同 isolate 的其它请求更容易撞上限）。
          if (dialResult.close) {
            try {
              void dialResult.close()
            } catch {
              /* 已关闭 */
            }
          }
          controller.close()
          return
        }
        if (value && value.byteLength > 0) {
          // 流量熔断：超限的那块不再下发，直接收尾
          if (traffic.add(value.byteLength)) {
            cutByTraffic()
            return
          }
          controller.enqueue(value)
        }
      } catch (err) {
        if (cancelled) return
        // 之前这里 controller.close() —— 客户端会把「异常截断」当成正常 EOF，
        // 既不能重试也无法区分。现在把错误传给流，同时保留 Socket 关闭。
        if (dialResult.close) {
          try {
            void dialResult.close()
          } catch {
            /* 已关闭 */
          }
        }
        try {
          controller.error(err)
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel(reason) {
      cancelled = true
      // 客户端断开（Xray 取消请求）时：取消下行读取，并**关闭底层 Socket**。
      //
      // 只 cancel readable 的话，TCP 连接仍然开着 —— 在 Workers 上它会一直占着
      // 「单请求 6 条并发出站」里的一个槽位，同 isolate 的其它请求更容易撞上限。
      try {
        void dialResult.readable.cancel(reason)
      } catch {
        /* 已取消 */
      }
      if (dialResult.close) {
        try {
          void dialResult.close()
        } catch {
          /* 已关闭 */
        }
      }
    },
  })

  return new Response(combined, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
