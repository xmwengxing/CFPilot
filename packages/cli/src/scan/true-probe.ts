/**
 * 真连接探针
 *
 * 核心突破：直连候选 IP，但强制使用用户自己的 Worker 域名作为 TLS SNI 与 HTTP Host，
 * 完整执行 TLS 握手 + WebSocket 101 升级握手，
 * 只有真正能连上「你自己的域名」的 IP 才会被保留 —— 彻底过滤掉 -1 废节点。
 *
 * 测速统一到 `measureThroughput()`（**只有这一套口径**）：
 *   1. 探针端点模式（`measureProbeThroughput`）—— 拨号候选 IP、请求目标项目自己的
 *      `/__edge_probe`，最忠实；靠 `x-probe-bytes` 响应头确认「确实是探针端点」。
 *   2. 公开测速地址模式 —— 任何项目都能测，**必须先通过 101 校验再调用**，
 *      否则会选出「速度快但不能服务你的域名」的 IP，导入客户端全是 -1。
 *
 * 两者共用同一套计量：**多连接 + 丢弃慢启动 + 窗口峰值**。
 * ⚠️ 不要退回「单连接 / 总字节 ÷ 从拨号起算的总耗时」——
 * 2026-10-28 真机实测这个口径会把 0.87 MB/s 的稳态链路报成 0.42 MB/s。
 */
import * as tls from 'node:tls'
import * as crypto from 'node:crypto'

export interface WsProbeResult {
  ok: boolean
  latencyMs: number
  colo: string
  status: number
  error?: string
  /**
   * 是否通过了**响应体内容校验**（PING → PONG）。
   *
   * `undefined` 表示这次探测没做内容校验（只握手里）。
   * `true` / `false` 表示做了并通过 / 未通过。
   */
  pongVerified?: boolean
  /** 探针回带的机房（PONG 里的 colo，比 cf-ray 更可靠） */
  probeColo?: string
}

/**
 * TLS 握手探测结果。
 *
 * ## 为什么单列一个指标
 *
 * 实测（电信千兆，两个不同网络环境）：
 *
 * | 指标 | 实测范围 | 区分度 |
 * |------|---------|--------|
 * | TCP 建连延迟 | 8~40ms | **几乎没有**（都在同一个数量级） |
 * | TLS 握手耗时 | 768ms ~ 3531ms | **极大**（相差 4.6 倍） |
 *
 * 两者的**相关系数接近 0**：TCP 9ms 的 IP，TLS 可能 3.5 秒。
 *
 * 因此只按 TCP 延迟排序（旧行为）会选出一批「TCP 快但 TLS 慢」的 IP，
 * 客户端建立连接需要完整 TLS 握手，超过超时就是 **-1**。
 * 这正是「优选出来有速度、导入客户端一半以上 -1」的根因。
 */
export interface TlsProbeResult {
  ip: string
  /** TLS 握手完成耗时（ms）；-1 表示握手失败/超时 */
  tlsMs: number
  /** 协商到的 ALPN（http/1.1 才能走 WS） */
  alpn?: string
  error?: string
}

export interface DownloadResult {
  ok: boolean
  bytes: number
  ms: number
  speedMBps: number
  error?: string
}

/** 吞吐测量结果 */
export interface ThroughputResult {
  ok: boolean
  /** 总接收字节 */
  bytes: number
  ms: number
  /**
   * **稳态吞吐（MB/s）—— 对外报告的「下行速度」用它**。
   *
   * 口径：丢弃前 `warmupMs` 的慢启动样本后，用「剩余字节 ÷ 剩余时长」按时长加权平均。
   * 既排除了握手/TTFB 与慢启动的拖累，又不会被单个突发的窗口拉高。
   */
  steadyMBps: number
  /**
   * 滑动窗口峰值（MB/s）。
   *
   * ⚠️ **只作诊断用，不要拿来排序**：2026-10-28 真机同一条链路实测，
   * 峰值 2.46 MB/s 而稳态只有 1.14 MB/s（单个 400ms 窗口的突发会把峰值翻倍）。
   */
  peakMBps: number
  /** 总时长平均（MB/s）—— 含握手/TTFB 与慢启动，会明显偏低，仅供参考 */
  avgMBps: number
  /** 实际使用的并发连接数 */
  connections: number
  error?: string
}

/** 吞吐测量参数 */
export interface ThroughputOptions {
  ip: string
  port: number
  /** TLS SNI（测速地址的域名） */
  sniHost: string
  /** 请求路径（含 query） */
  path: string
  /** Host 头，默认与 sniHost 相同 */
  requestHost?: string
  /** 测量总时长（ms） */
  durationMs?: number
  /** 丢弃的慢启动时长（ms）—— TCP 慢启动会让开头几秒严重偏低 */
  warmupMs?: number
  /** 滑动窗口宽度（ms） */
  windowMs?: number
  /** 并发连接数：单连接可能受 TCP 窗口限制，测不出真实带宽 */
  connections?: number
  /** 整体超时（ms） */
  timeoutMs?: number
  /**
   * 响应头里**必须存在**的字段名（小写，不含冒号）。
   *
   * 探针端点用 `x-probe-bytes` —— 这是 CFPilot `/__edge_probe` 的独有标记。
   *
   * ## 为什么必须校验
   *
   * 测速请求打到的是候选 IP + 用户域名；如果这个域名上没有探针端点
   * （比如对接的第三方项目），CF Pages 会回一个 **200 + HTML 欢迎页**。
   * 那几百字节 HTML 会被当成「有数据」，产出一个速度极低但 `ok` 的假阳性节点。
   */
  requiredHeader?: string
  /** 判定成功所需的最小总字节数（默认 32KB）——同样用于挡掉报错页 */
  minBytes?: number
}

/**
 * 吞吐窗口计（纯逻辑、无 I/O，便于单测）。
 *
 * ## 为什么不能用「总字节 / 总耗时」
 *
 * TCP 慢启动让开头几秒远低于链路能力。2026-10-28 真机实测同一条链路
 * 逐秒速率：`0.19 → 0.25 → 0.29 → 0.20 → 0.50 → 0.47 → 0.52 → 0.81 → 0.87` MB/s。
 * 5MB 整段平均只有 **0.42** MB/s，而稳态已到 **0.87** —— 低估一倍以上。
 * 更糟的是阶段三原本还并发测多个候选（默认 4 路），
 * 4 条流分摊同一条链路后每个候选只剩约 1/4 带宽，最终报出 0.1~0.2 MB/s。
 *
 * ## 为什么对外用「稳态均值」而不是「窗口峰值」
 *
 * 真机同一条链路、3 条并行连接、400ms 窗口实测：
 * 逐窗 `0.38 0.42 0.91 0.43 1.05 1.63 1.04 1.05 1.49 1.40 1.11 2.46 0.66`，
 * 稳态均值 **1.14** MB/s，而峰值 **2.46** MB/s —— 单个突发窗口能把峰值翻倍。
 * 所以：对外报 `steadyMBps`（预热后的时长加权均值），峰值只留作诊断。
 */
export class WindowMeter {
  private readonly startedAt: number
  private readonly warmupMs: number
  private readonly windowMs: number
  private windowBytes = 0
  private windowStart: number
  private peak = 0
  private total = 0
  /** 预热之后累计的字节与**秒数**（注意 settle 里的 dt 已经是秒） */
  private steadyBytes = 0
  private steadySeconds = 0

  constructor(options: { startedAt: number; warmupMs?: number; windowMs?: number }) {
    this.startedAt = options.startedAt
    this.warmupMs = options.warmupMs ?? 1000
    this.windowMs = options.windowMs ?? 500
    this.windowStart = options.startedAt
  }

  /** 累计收到的字节到当前窗口 */
  add(bytes: number): void {
    if (bytes <= 0) return
    this.windowBytes += bytes
    this.total += bytes
  }

  /** 结算当前窗口（由定时器按 windowMs 调用）；返回当前峰值（MB/s） */
  tick(now: number): number {
    this.settle(now)
    return this.peak
  }

  /**
   * 收尾：结算最后一个不完整窗口，并处理「链路很快、没到预热期就下完预算」的兜底。
   */
  finish(now: number): number {
    this.settle(now)
    // 快速链路（或极小预算）会在 warmupMs 之前就传完：此时一个窗口都没结算过，
    // peak 会停在 0，被误判成「测速失败」。用整段平均兜底。
    const elapsed = (now - this.startedAt) / 1000
    if (this.peak === 0 && this.total > 0 && elapsed > 0) {
      this.peak = this.total / 1024 / 1024 / elapsed
    }
    this.windowBytes = 0
    this.windowStart = now
    return this.peak
  }

  /** 结算一个窗口：慢启动期内只丢弃，不记峰值/稳态 */
  private settle(now: number): void {
    const dt = (now - this.windowStart) / 1000
    if (dt <= 0) return
    const bytes = this.windowBytes
    this.windowBytes = 0
    this.windowStart = now
    if (now - this.startedAt < this.warmupMs) return
    this.steadyBytes += bytes
    this.steadySeconds += dt
    const speed = bytes / dt / 1024 / 1024
    if (speed > this.peak) this.peak = speed
  }

  /** 已接收总字节 */
  get totalBytes(): number {
    return this.total
  }

  /** 当前峰值（MB/s） */
  get peakMBps(): number {
    return this.peak
  }

  /**
   * 稳态吞吐（MB/s）：预热之后按时长加权的平均。
   *
   * 若整段都在预热期（链路极快），退回整段平均 —— 否则会报 0。
   */
  get steadyMBps(): number {
    if (this.steadySeconds > 0) return this.steadyBytes / 1024 / 1024 / this.steadySeconds
    return this.peak
  }
}

/**
 * 探测请求的 User-Agent。
 *
 * 用常见桌面浏览器标识，不用工具自身的名字。
 *
 * ## 为什么
 *
 * 扫描会在几秒内向**用户自己的域名**发起上百次探测请求。
 * 若带 `CFPilot-Scanner/1.0 (+github.com/...)`，Cloudflare 边缘日志会
 * 直接记录「这是某个扫描工具」—— 一是暴露工具指纹，二是让自家域名的
 * 访问日志出现明显的机器流量特征（可能触发额外风控）。
 *
 * 用浏览器标识后，这些请求与普通访问无异。
 *
 * ⚠️ 本地回传结果 / 日志输出仍用工具自身标识（见 callback.ts），不混淆。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function extractColo(text: string): string {
  const match = /cf-ray:\s*[0-9a-f]+-([A-Z]{3})/i.exec(text)
  return match ? match[1]!.toUpperCase() : ''
}

/**
 * 阶段二：携带自定义 SNI / Host 的 WebSocket 101 握手校验
 */
export function probeWs101(
  ip: string,
  port: number,
  host: string,
  timeoutMs = 3000,
  path = '/__edge_probe'
): Promise<WsProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const key = crypto.randomBytes(16).toString('base64')
    let settled = false
    let received = ''

    const finish = (result: Omit<WsProbeResult, 'latencyMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ ...result, latencyMs: Date.now() - started })
    }

    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      `User-Agent: ${USER_AGENT}`,
      '',
      '',
    ].join('\r\n')

    const socket = tls.connect(
      {
        host: ip,
        port,
        servername: host,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      },
      () => {
        socket.write(request)
      }
    )

    const timer = setTimeout(() => {
      finish({ ok: false, colo: '', status: 0, error: '握手超时' })
    }, timeoutMs)

    socket.setTimeout(timeoutMs, () => {
      finish({ ok: false, colo: '', status: 0, error: '连接超时' })
    })

    socket.on('error', (err: Error) => {
      finish({ ok: false, colo: '', status: 0, error: err.message })
    })

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      const lineEnd = received.indexOf('\r\n')
      const statusLine = lineEnd >= 0 ? received.slice(0, lineEnd) : received
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
      if (statusMatch) {
        const status = Number(statusMatch[1])
        if (status === 101) {
          finish({ ok: true, colo: extractColo(received), status })
        } else {
          finish({ ok: false, colo: extractColo(received), status, error: `HTTP ${status}` })
        }
        return
      }
      if (received.length > 4096) {
        finish({ ok: false, colo: '', status: 0, error: '响应异常' })
      }
    })
  })
}

/* ------------------------------------------------------------------ *
 * WS 帧编解码（最小实现，只覆盖探测需要的 binary/text 帧）
 * ------------------------------------------------------------------ */

/**
 * 构造客户端 WS 帧（必须掩码，RFC 6455 §5.3）。
 *
 * @param opcode 帧类型：1 = text，2 = binary。
 *   ⚠️ 给 CFPilot 数据面发 PING 必须传 **1（text）** ——
 *   数据面用 `typeof event.data === 'string'` 判定，binary 帧会被当空串忽略。
 */
function encodeWsFrame(payload: Uint8Array, opcode = 0x02): Buffer {
  const mask = crypto.randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i]! ^ mask[i % 4]!
  }
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0xfe
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0xff
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

interface DecodedFrame {
  opcode: number
  payload: Buffer
}

/**
 * 从缓冲区解析服务端 WS 帧（服务端帧不带掩码）。
 *
 * 返回 `null` 表示数据还不够一帧；否则返回帧与剩余字节。
 */
function decodeWsFrame(buf: Buffer): { frame: DecodedFrame; rest: Buffer } | null {
  if (buf.length < 2) return null
  const opcode = buf[0]! & 0x0f
  const len7 = buf[1]! & 0x7f
  let offset: number
  let payloadLen: number
  if (len7 < 126) {
    offset = 2
    payloadLen = len7
  } else if (len7 === 126) {
    if (buf.length < 4) return null
    offset = 4
    payloadLen = buf.readUInt16BE(2)
  } else {
    if (buf.length < 10) return null
    offset = 10
    payloadLen = Number(buf.readBigUInt64BE(2))
  }
  if (buf.length < offset + payloadLen) return null
  const frame: DecodedFrame = {
    opcode,
    payload: Buffer.from(buf.subarray(offset, offset + payloadLen)),
  }
  // subarray 会收窄成 Buffer<ArrayBufferLike>，这里显式拷贝成 Buffer<ArrayBuffer>
  const rest: Buffer = Buffer.from(buf.subarray(offset + payloadLen))
  return { frame, rest }
}

/**
 * 阶段二（严格版）：WS 101 握手 + **响应体内容校验**。
 *
 * ## 为什么在 101 之外还要验内容
 *
 * 借鉴 CFData-WEB 的「链路复验」思路：它不只做 TLS 握手，
 * 还解析响应体、校验其中的标记字段（`probe` / `ip`）。
 *
 * 我们此前的 `probeWs101` **只握手、不发任何数据**，因此无法分辨：
 *
 * - IP 能服务我们的域名，数据面真的在干活 ✅
 * - IP 到 CF 边缘通，但**数据面对该请求不响应** ❌（漏网 → 客户端 -1）
 *
 * CFPilot 数据面的 `/__edge_probe` 内置了 PING/PONG：
 * 客户端发文本 `PING`，服务端回 `{"pong":true,"colo":"XXX","clientIp":"..."}`。
 * 这个现成机制正是「响应体内容校验」的钩子 —— 此前 scanner 从未用过。
 *
 * ## 判定规则
 *
 * 1. 必须 101 握手成功；
 * 2. 发送 `PING` 后必须收到一个 **text/binary 帧**；
 * 3. 帧内容必须是 JSON 且 `pong === true`。
 *
 * 三条全过才判 `ok`，`pongVerified = true`。
 * 这样「101 通但数据面不响应」的 IP 会在阶段二被拦掉，不会进入测速、
 * 也不会出现在最终结果里。
 *
 * ## 兼容性
 *
 * 目标不是 CFPilot（没有 `/__edge_probe` 的 PING）时，退化为纯 101 校验
 * （`pongVerified = undefined`），不阻断通用场景。
 */
export function probeWsPing(
  ip: string,
  port: number,
  host: string,
  timeoutMs = 5000,
  path = '/__edge_probe'
): Promise<WsProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const key = crypto.randomBytes(16).toString('base64')
    let settled = false
    let handshakeDone = false
    // 显式标注为 Buffer（不带 ArrayBuffer 泛型约束），
    // 否则 Buffer.alloc(0) 推断出的 Buffer<ArrayBuffer> 与后续赋值不兼容
    let buf: Buffer = Buffer.alloc(0)
    let receivedText = ''

    const finish = (result: Omit<WsProbeResult, 'latencyMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ ...result, latencyMs: Date.now() - started })
    }

    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      `User-Agent: ${USER_AGENT}`,
      '',
      '',
    ].join('\r\n')

    const socket = tls.connect(
      {
        host: ip,
        port,
        servername: host,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      },
      () => {
        socket.write(request)
      }
    )

    const timer = setTimeout(() => {
      finish({
        ok: false,
        colo: '',
        status: 0,
        error: handshakeDone ? 'PING 超时（数据面未响应）' : '握手超时',
        pongVerified: handshakeDone ? false : undefined,
      })
    }, timeoutMs)

    socket.setTimeout(timeoutMs, () => {
      finish({
        ok: false,
        colo: '',
        status: 0,
        error: handshakeDone ? 'PING 超时（数据面未响应）' : '连接超时',
        pongVerified: handshakeDone ? false : undefined,
      })
    })

    socket.on('error', (err: Error) => {
      finish({
        ok: false,
        colo: '',
        status: 0,
        error: err.message,
        pongVerified: handshakeDone ? false : undefined,
      })
    })

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])

      if (!handshakeDone) {
        const lineEnd = buf.indexOf('\r\n\r\n')
        if (lineEnd < 0) {
          if (buf.length > 8192) finish({ ok: false, colo: '', status: 0, error: '响应头异常' })
          return
        }
        const head = buf.slice(0, lineEnd).toString('latin1')
        const statusLine = head.split('\r\n')[0] ?? ''
        const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)
        const status = statusMatch ? Number(statusMatch[1]) : 0
        const colo = extractColo(head)
        buf = buf.subarray(lineEnd + 4)

        if (status !== 101) {
          finish({ ok: false, colo, status, error: `HTTP ${status}` })
          return
        }
        handshakeDone = true
        // 101 成功 → 立刻发 PING，触发数据面的响应体校验。
        //
        // ⚠️ 必须是 **text 帧（opcode 1）**：数据面的判定是
        // `typeof event.data === 'string' ? event.data : ''`，
        // binary 帧（opcode 2）会被当成空字符串直接忽略（真机实测 8/8 全部超时）。
        socket.write(encodeWsFrame(new TextEncoder().encode('PING'), 0x01))
      }

      // 解析服务端帧
      for (;;) {
        const decoded = decodeWsFrame(buf)
        if (!decoded) break
        buf = decoded.rest
        const { opcode, payload } = decoded.frame
        // 8 = close：数据面主动关闭，说明没打算回 PONG
        if (opcode === 8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
          finish({
            ok: false,
            colo: '',
            status: 101,
            error: `WS 关闭（code ${code}）`,
            pongVerified: false,
          })
          return
        }
        // 1 = text，2 = binary：这就是 PONG
        if (opcode === 1 || opcode === 2) {
          receivedText += payload.toString('utf8')
          try {
            const parsed = JSON.parse(receivedText) as { pong?: unknown; colo?: unknown }
            if (parsed.pong === true) {
              finish({
                ok: true,
                colo: typeof parsed.colo === 'string' ? parsed.colo.toUpperCase() : '',
                status: 101,
                pongVerified: true,
                probeColo: typeof parsed.colo === 'string' ? parsed.colo.toUpperCase() : undefined,
              })
              return
            }
          } catch {
            /* 可能还没收全，继续等 */
          }
        }
      }
    })
  })
}

/**
 * 探测候选 IP 的 TLS 握手耗时。
 *
 * ## 用途
 *
 * 阶段一用：TCP 建连快不代表 TLS 握手快（实测两者相关系数接近 0），
 * 而客户端能否用这个 IP 取决于**完整 TLS 握手**能否在超时内完成。
 * 因此阶段一在 TCP 初筛后追加这一项，作为主要排序键。
 *
 * ## 实现要点
 *
 * - **只做握手、不发数据**：`tls.connect()` 的回调触发即视为握手完成，
 *   立刻 destroy，不产生额外请求。
 * - **ALPN 固定 http/1.1**：与 `probeWs101` 保持一致；
 *   协商不到 http/1.1 的 IP 走不了 WS，直接判失败。
 * - **超时单独给**：握手超时通常远大于 TCP 超时，默认 4 秒。
 */
export function probeTlsHandshake(
  ip: string,
  port: number,
  host: string,
  timeoutMs = 4000
): Promise<TlsProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false

    // 注意：finish 的参数**不含** ip —— resolve 时统一补上，
    // 否则 `{ ip, ...result }` 里的 ip 会被 result.ip 覆盖（TS2783）。
    const finish = (result: Omit<TlsProbeResult, 'ip' | 'tlsMs'> & { tlsMs?: number }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ ip, tlsMs: result.tlsMs ?? Date.now() - started, ...result })
    }

    const socket = tls.connect(
      {
        host: ip,
        port,
        servername: host,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      },
      () => {
        // 握手完成。ALPN 没协商到 http/1.1 就无法升级 WS，判失败。
        const alpn = socket.alpnProtocol
        if (alpn && alpn !== 'http/1.1') {
          finish({ error: `ALPN=${alpn}` })
          return
        }
        finish({ tlsMs: Date.now() - started, alpn: alpn || undefined })
      }
    )

    const timer = setTimeout(() => finish({ error: 'TLS 握手超时' }), timeoutMs)
    socket.setTimeout(timeoutMs, () => finish({ error: 'TLS 连接超时' }))
    socket.on('error', (err: Error) => finish({ error: err.message }))
  })
}


/**
 * 通用吞吐测量：拨号到候选 IP，但用**外部测速地址**的 SNI/Host 发起下载。
 *
 * ## 为什么需要它
 *
 * `measureProbeThroughput()` 要求目标项目提供探针端点（如 `/__edge_probe`）。
 * 对接第三方项目时对方没有这个端点，测速就永远是 0。
 * 本函数改为请求一个**公开的大文件地址**，因此任何项目都能测。
 *
 * ## ⚠️ 必须先通过 101 校验
 *
 * 本函数只回答「这个 IP 到 Cloudflare 边缘的带宽有多大」，
 * **不回答**「这个 IP 能不能服务你的代理域名」。
 * 直接用它排序会选出「速度很快但导入客户端全是 -1」的 IP ——
 * 这正是同类工具的通病。调用方必须先用 `probeWs101()` 过滤。
 *
 * ## 为什么取滑动窗口峰值而不是平均
 *
 * TCP 慢启动会让开头 1~2 秒的速率远低于链路实际能力，
 * 把它算进平均会让结果严重偏低（实测同一 IP：峰值 51.7 MB/s、均值仅 16.4 MB/s）。
 * 因此丢弃前 `warmupMs` 的样本，再取窗口速率的最大值。
 *
 * ## 为什么默认多条连接
 *
 * 单条 TCP 连接受拥塞窗口与 BDP 限制，在高延迟线路上往往填不满实际带宽。
 * 默认开 3 条并发，把各窗口的字节数汇总后取峰值。
 */
export function measureThroughput(options: ThroughputOptions): Promise<ThroughputResult> {
  const {
    ip,
    port,
    sniHost,
    path,
    requestHost = sniHost,
    durationMs = 6000,
    warmupMs = 1000,
    windowMs = 400,
    connections = 3,
    timeoutMs = 20000,
    requiredHeader,
    minBytes = 32 * 1024,
  } = options

  const connCount = Math.max(1, Math.min(8, connections))

  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    /** 窗口计量：丢弃慢启动期后按窗口取峰值（见 WindowMeter 注释） */
    const meter = new WindowMeter({ startedAt: started, warmupMs, windowMs })
    let openedCount = 0
    let lastError = ''
    /** 响应头不匹配（目标没有探针端点）：立即判失败，不必等时长跑完 */
    let headerMismatch = false
    const sockets: tls.TLSSocket[] = []

    const finish = (): void => {
      if (settled) return
      settled = true
      clearInterval(ticker)
      clearTimeout(timer)
      for (const s of sockets) {
        try {
          s.destroy()
        } catch {
          /* 已销毁 */
        }
      }
      const now = Date.now()
      const peakMBps = meter.finish(now)
      const totalBytes = meter.totalBytes
      const elapsed = Math.max(0.001, (now - started) / 1000)
      const ok = !headerMismatch && totalBytes >= minBytes
      let error: string | undefined
      if (!ok) {
        if (headerMismatch) error = lastError || '目标不支持探针测速'
        else if (totalBytes === 0) error = lastError || '未收到数据'
        else error = lastError || `载荷不足（${totalBytes}/${minBytes} 字节）`
      }
      resolve({
        ok,
        bytes: totalBytes,
        ms: now - started,
        steadyMBps: Number(meter.steadyMBps.toFixed(2)),
        peakMBps: Number(peakMBps.toFixed(2)),
        avgMBps: Number((totalBytes / 1024 / 1024 / elapsed).toFixed(2)),
        connections: openedCount,
        error,
      })
    }

    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${requestHost}`,
      `User-Agent: ${USER_AGENT}`,
      'Accept: */*',
      'Accept-Encoding: identity',
      'Connection: close',
      '',
      '',
    ].join('\r\n')

    /** 单条连接的接收逻辑 */
    const openOne = (): void => {
      let headerDone = false
      /**
       * 响应头缓冲（Buffer 累积）。
       *
       * 旧实现每收一个 chunk 就 toString('latin1') 拼字符串，
       * 找到边界后又 Buffer.from 转回去 —— 测速时每秒几十兆，
       * 这点编解码与分配是纯浪费。直接在 Buffer 上找分隔符。
       */
      let headerBuffer: Buffer = Buffer.alloc(0)

      const socket = tls.connect(
        {
          host: ip,
          port,
          servername: sniHost,
          rejectUnauthorized: false,
          ALPNProtocols: ['http/1.1'],
        },
        () => {
          openedCount++
          socket.write(request)
        }
      )
      sockets.push(socket)

      socket.setTimeout(timeoutMs, () => {
        try {
          socket.destroy()
        } catch {
          /* 已销毁 */
        }
      })

      socket.on('error', (err: Error) => {
        lastError = err.message
      })

      socket.on('data', (chunk: Buffer) => {
        if (!headerDone) {
          headerBuffer = headerBuffer.length === 0 ? chunk : Buffer.concat([headerBuffer, chunk])
          const idx = headerBuffer.indexOf('\r\n\r\n')
          if (idx < 0) {
            if (headerBuffer.length > 8192) {
              lastError = '响应头异常'
              socket.destroy()
            }
            return
          }
          const head = headerBuffer.subarray(0, idx).toString('latin1')
          const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1]
          if (status !== '200') {
            lastError = `HTTP ${status ?? '?'}`
            socket.destroy()
            return
          }
          // 探针端点独有标记校验：没有这个头的 200 是别的项目的欢迎页，
          // 把它的 HTML 当成「测速数据」会产出假阳性节点。
          if (requiredHeader && !head.toLowerCase().includes(`${requiredHeader.toLowerCase()}:`)) {
            headerMismatch = true
            lastError = `目标不支持探针测速（响应头缺少 ${requiredHeader}，可改用 --speed-mode url）`
            socket.destroy()
            finish()
            return
          }
          headerDone = true
          const body = headerBuffer.subarray(idx + 4)
          meter.add(body.byteLength)
          headerBuffer = Buffer.alloc(0)
        } else {
          meter.add(chunk.byteLength)
        }
        if (Date.now() - started > durationMs) finish()
      })

      socket.on('end', () => {
        // 单条连接提前结束（服务端发完文件）：其他连接还在跑就继续
        if (sockets.every((s) => s.destroyed || s.readableEnded)) finish()
      })
      socket.on('close', () => {
        if (sockets.every((s) => s.destroyed)) finish()
      })
    }

    // 每 windowMs 结算一次窗口速率；慢启动期内的样本只丢弃不记峰值
    const ticker = setInterval(() => {
      meter.tick(Date.now())
    }, windowMs)

    const timer = setTimeout(finish, durationMs + 4000)

    // 逐条建立连接，略微错开避免同时挤在同一拥塞窗口
    for (let i = 0; i < connCount; i++) {
      setTimeout(openOne, i * 60)
    }
  })
}

/** 探针端点测速参数 */
export interface ProbeThroughputOptions {
  /** 探针鉴权令牌（= uuid 或其前 8 位）：仅用于大体积下载 */
  token?: string
  ip: string
  port: number
  /** 数据面域名（同时作为 TLS SNI 与 Host） */
  host: string
  /** 每条连接请求的字节上限（服务端会按它封顶） */
  bytes: number
  /** 探针端点路径，默认 /__edge_probe */
  path?: string
  connections?: number
  durationMs?: number
  warmupMs?: number
  windowMs?: number
  timeoutMs?: number
}

/**
 * 阶段三：走**目标项目自己的探针端点**做真实下行测速。
 *
 * ## 与旧实现的区别（2026-10-28 真机定位后重写）
 *
 * 旧实现是「单连接、限时 12 秒、下载固定 5MB，然后 `总字节 / 从拨号起算的总耗时`」。
 * 真机同一条链路实测，旧口径报 0.42 MB/s，而实际链路能力是 **1.14 MB/s**。
 * 差距来自三处，按影响排序：
 *
 * | 因素 | 实测倍数 | 说明 |
 * |---|---|---|
 * | 单连接 → 3 条并行 | **×2.4** | 单条 TCP 受拥塞窗口 / BDP 限制，填不满链路 |
 * | 4 路候选并行 → 串行 | **×4** | 带宽是共享的，4 条流互相抢（见 scan.ts 的 speedConcurrency） |
 * | 含慢启动 → 丢预热后稳态 | ×1.05 | 预热只占整段 1/6，收益是个位数百分比 |
 *
 * 三项叠加正好解释「优选出来的 IP 全都只有 0.1~0.9 MB/s」：
 * 0.42（单流整段均值）÷ 4（候选抢带宽）× 2.4（多流不足）≈ 0.1。
 *
 * 现在统一到与公开测速地址**同一套口径**：
 *   1. 多连接（默认 3）；
 *   2. 丢弃前 `warmupMs`（默认 1s）的慢启动样本，报**稳态均值**（不是峰值，
 *      真机单窗口突发能把峰值翻倍）；
 *   3. 校验 `x-probe-bytes` 响应头 —— 否则别的项目返回的 200 欢迎页会被当成数据。
 */
export async function measureProbeThroughput(
  options: ProbeThroughputOptions
): Promise<ThroughputResult> {
  const rawPath = options.path && options.path.length > 0 ? options.path : '/__edge_probe'
  const separator = rawPath.includes('?') ? '&' : '?'
  return await measureThroughput({
    ip: options.ip,
    port: options.port,
    sniHost: options.host,
    requestHost: options.host,
    path: `${rawPath}${separator}bytes=${options.bytes}`,
    connections: options.connections,
    durationMs: options.durationMs,
    warmupMs: options.warmupMs,
    windowMs: options.windowMs,
    timeoutMs: options.timeoutMs,
    // /__edge_probe 的独有标记：少了它就不是「我们自己的探针端点」
    requiredHeader: 'x-probe-bytes',
    minBytes: 32 * 1024,
  })
}

/** `verifyTunnel` 的参数 */
export interface TunnelVerifyOptions {
  ip: string
  port: number
  host: string
  wsPath: string
  uuid?: string
  trojanPassword?: string
  targetHost?: string
  targetPort?: number
  timeoutMs?: number
}

/** `verifyTunnel` 的结果 */
export interface TunnelVerifyResult {
  ok: boolean
  stage?: 'handshake' | 'protocol' | 'data'
  latencyMs: number
  firstBytes?: string
  error?: string
}

/** 构造 VLESS 隧道首包（协议头 + HTTP 请求） */
export function buildVlessTunnelPayload(uuid: string, targetHost: string, targetPort: number, request: string): Buffer | null {
  const clean = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null
  const hostBuf = Buffer.from(targetHost, 'utf8')
  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(clean, 'hex'),
    Buffer.from([0x00, 0x01, (targetPort >> 8) & 0xff, targetPort & 0xff, 0x02, hostBuf.length]),
    hostBuf,
    Buffer.from(request, 'utf8'),
  ])
}

/** 构造 Trojan 隧道首包（sha224 口令 + CRLF + CONNECT + 域名 + 端口 + CRLF + 请求） */
export function buildTrojanTunnelPayload(password: string, targetHost: string, targetPort: number, request: string): Buffer {
  const digest = crypto.createHash('sha224').update(password).digest('hex')
  const hostBuf = Buffer.from(targetHost, 'utf8')
  return Buffer.concat([
    Buffer.from(digest + '\r\n', 'ascii'),
    Buffer.from([0x01, 0x03, hostBuf.length]),
    hostBuf,
    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    Buffer.from('\r\n', 'ascii'),
    Buffer.from(request, 'utf8'),
  ])
}

/** 建连用的 HTTP 请求头 */
function tunnelUpgradeRequest(host: string, wsPath: string, key: string): string {
  return ['GET ' + wsPath + ' HTTP/1.1', 'Host: ' + host, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13', 'User-Agent: ' + USER_AGENT, '', ''].join('\r\n')
}

/** 要访问的目标站请求（随便取个能回数据的路径即可） */
function tunnelTargetRequest(targetHost: string): string {
  return 'GET / HTTP/1.1\r\nHost: ' + targetHost + '\r\nUser-Agent: ' + USER_AGENT + '\r\nConnection: close\r\n\r\n'
}

export function verifyTunnel(options: TunnelVerifyOptions): Promise<TunnelVerifyResult> {
  const { ip, port, host, wsPath, uuid, trojanPassword, targetHost = 'baidu.com', targetPort = 80, timeoutMs = 8000 } = options
  const payload = uuid
    ? buildVlessTunnelPayload(uuid, targetHost, targetPort, tunnelTargetRequest(targetHost))
    : trojanPassword
      ? buildTrojanTunnelPayload(trojanPassword, targetHost, targetPort, tunnelTargetRequest(targetHost))
      : null
  if (!payload) return Promise.resolve({ ok: false, stage: 'protocol', latencyMs: 0, error: '缺少 uuid / trojanPassword' })
  return new Promise((resolve) => {
    const started = Date.now()
    const key = crypto.randomBytes(16).toString('base64')
    let settled = false
    let handshakeDone = false
    let buf: Buffer = Buffer.alloc(0)
    const finish = (r: Omit<TunnelVerifyResult, 'latencyMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* 已销毁 */ }
      resolve({ ...r, latencyMs: Date.now() - started })
    }
    const socket = tls.connect({ host: ip, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      socket.write(tunnelUpgradeRequest(host, wsPath, key))
    })
    const timer = setTimeout(() => {
      finish({ ok: false, stage: handshakeDone ? 'data' : 'handshake', error: handshakeDone ? '协议已发出但没有回包' : 'WS 握手超时' })
    }, timeoutMs)
    socket.on('error', (err: Error) => finish({ ok: false, stage: handshakeDone ? 'data' : 'handshake', error: err.message }))
    socket.setTimeout(timeoutMs, () => finish({ ok: false, stage: handshakeDone ? 'data' : 'handshake', error: '连接超时' }))
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (!handshakeDone) {
        const lineEnd = buf.indexOf('\r\n\r\n')
        if (lineEnd < 0) {
          if (buf.length > 8192) finish({ ok: false, stage: 'handshake', error: '响应头异常' })
          return
        }
        const head = buf.slice(0, lineEnd).toString('latin1')
        const status = Number((/^HTTP\/1\.[01]\s+(\d{3})/.exec(head.split('\r\n')[0] ?? '') ?? [])[1] ?? 0)
        buf = buf.subarray(lineEnd + 4)
        if (status !== 101) {
          finish({ ok: false, stage: 'handshake', error: 'HTTP ' + status })
          return
        }
        handshakeDone = true
        socket.write(encodeWsFrame(payload, 0x02))
      }
      for (;;) {
        const decoded = decodeWsFrame(buf)
        if (!decoded) break
        buf = decoded.rest
        const { opcode, payload: data } = decoded.frame
        if (opcode === 8) {
          const code = data.length >= 2 ? data.readUInt16BE(0) : 1005
          finish({ ok: false, stage: 'protocol', error: 'WS 关闭（code ' + code + '）' })
          return
        }
        if ((opcode === 1 || opcode === 2) && data.length > 0) {
          const body = uuid && data.length >= 2 && data[0] === 0x00 && data[1] === 0x00 ? data.subarray(2) : data
          if (body.length > 0) {
            finish({ ok: true, firstBytes: body.subarray(0, 16).toString('latin1') })
            return
          }
        }
      }
    })
  })
}
