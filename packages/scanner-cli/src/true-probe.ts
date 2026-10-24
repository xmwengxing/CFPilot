/**
 * 真连接探针
 *
 * 核心突破：直连候选 IP，但强制使用用户自己的 Worker 域名作为 TLS SNI 与 HTTP Host，
 * 完整执行 TLS 握手 + WebSocket 101 升级握手，
 * 只有真正能连上「你自己的域名」的 IP 才会被保留 —— 彻底过滤掉 -1 废节点。
 *
 * 测速有两条路：
 *   1. `measureDownload()` —— 走目标项目自己的探针端点（CFPilot 是 /__edge_probe），
 *      最忠实，但要求目标项目提供该端点。
 *   2. `measureThroughput()` —— 拨号到候选 IP、但用**公开测速地址**的 SNI/Host，
 *      任何项目都能用。**必须先通过 101 校验再调用**，否则会选出
 *      「速度快但不能服务你的域名」的 IP，导入客户端全是 -1。
 */
import * as tls from 'node:tls'
import * as crypto from 'node:crypto'

export interface WsProbeResult {
  ok: boolean
  latencyMs: number
  colo: string
  status: number
  error?: string
}

/**
 * TLS 握手探测结果。
 *
 * ## 为什么单列一个指标（2026-10-24 真机定位的 -1 根因）
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
  /** 滑动窗口峰值（MB/s）—— 反映链路可达带宽，受慢启动影响小 */
  peakMBps: number
  /** 总时长平均（MB/s）—— 会明显低于峰值，仅供参考 */
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
}

const USER_AGENT = 'CFPilot-Scanner/1.0 (+https://github.com/xmwengxing/CFPilot)'

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
 * 阶段三：在用户自己的域名下测试真实下行速度
 */
export function measureDownload(
  ip: string,
  port: number,
  host: string,
  bytes: number,
  timeoutMs = 12000,
  path = '/__edge_probe'
): Promise<DownloadResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let headerEnd = -1
    let received = 0
    let settled = false
    let buffer = ''

    const finish = (result: Omit<DownloadResult, 'ms'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve({ ...result, ms: Date.now() - started })
    }

    const request = [
      `GET ${path}?bytes=${bytes} HTTP/1.1`,
      `Host: ${host}`,
      `User-Agent: ${USER_AGENT}`,
      `Accept: */*`,
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
      const seconds = Math.max(0.001, (Date.now() - started) / 1000)
      finish({
        ok: received > 0,
        bytes: received,
        speedMBps: received / 1024 / 1024 / seconds,
        error: received > 0 ? undefined : '测速超时',
      })
    }, timeoutMs)

    socket.setTimeout(timeoutMs, () => {
      const seconds = Math.max(0.001, (Date.now() - started) / 1000)
      finish({
        ok: received > 0,
        bytes: received,
        speedMBps: received / 1024 / 1024 / seconds,
        error: received > 0 ? undefined : '测速超时',
      })
    })

    socket.on('error', (err: Error) => {
      finish({ ok: false, bytes: received, speedMBps: 0, error: err.message })
    })

    const settle = (): void => {
      if (settled) return
      const seconds = Math.max(0.001, (Date.now() - started) / 1000)
      finish({ ok: received > 0, bytes: received, speedMBps: received / 1024 / 1024 / seconds })
    }

    socket.on('data', (chunk: Buffer) => {
      if (headerEnd < 0) {
        buffer += chunk.toString('latin1')
        const idx = buffer.indexOf('\r\n\r\n')
        if (idx < 0) {
          if (buffer.length > 8192) finish({ ok: false, bytes: 0, speedMBps: 0, error: '响应头异常' })
          return
        }
        headerEnd = idx + 4
        const body = Buffer.from(buffer, 'latin1').subarray(headerEnd)
        received += body.byteLength
        headerEnd = 0
      } else {
        received += chunk.byteLength
      }
      if (received >= bytes) settle()
    })

    socket.on('end', settle)
    socket.on('close', settle)
  })
}

/**
 * 通用吞吐测量：拨号到候选 IP，但用**外部测速地址**的 SNI/Host 发起下载。
 *
 * ## 为什么需要它
 *
 * `measureDownload()` 要求目标项目提供探针端点（如 `/__edge_probe`）。
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
  } = options

  const connCount = Math.max(1, Math.min(8, connections))

  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let totalBytes = 0
    /** 所有连接的字节数汇总，用于窗口速率 */
    let windowBytes = 0
    let windowStart = started
    let peak = 0
    let openedCount = 0
    let lastError = ''
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
      // 收尾时把最后一个窗口也算进去（若已过慢启动期）
      const elapsedNow = Date.now() - started
      if (elapsedNow >= warmupMs) {
        const dt = (Date.now() - windowStart) / 1000
        if (dt > 0) {
          const speed = windowBytes / dt / 1024 / 1024
          if (speed > peak) peak = speed
        }
      }
      const elapsed = Math.max(0.001, (Date.now() - started) / 1000)
      resolve({
        ok: totalBytes > 0,
        bytes: totalBytes,
        ms: Date.now() - started,
        peakMBps: Number(peak.toFixed(2)),
        avgMBps: Number((totalBytes / 1024 / 1024 / elapsed).toFixed(2)),
        connections: openedCount,
        error: totalBytes > 0 ? undefined : lastError || '未收到数据',
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
      let headerBuffer = ''

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
          headerBuffer += chunk.toString('latin1')
          const idx = headerBuffer.indexOf('\r\n\r\n')
          if (idx < 0) {
            if (headerBuffer.length > 8192) {
              lastError = '响应头异常'
              socket.destroy()
            }
            return
          }
          const head = headerBuffer.slice(0, idx)
          const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1]
          if (status !== '200') {
            lastError = `HTTP ${status ?? '?'}`
            socket.destroy()
            return
          }
          headerDone = true
          const body = Buffer.from(headerBuffer, 'latin1').subarray(idx + 4)
          totalBytes += body.byteLength
          windowBytes += body.byteLength
          headerBuffer = ''
        } else {
          totalBytes += chunk.byteLength
          windowBytes += chunk.byteLength
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

    // 每 windowMs 结算一次窗口速率，慢启动期内的样本丢弃
    const ticker = setInterval(() => {
      const now = Date.now()
      const dt = (now - windowStart) / 1000
      if (dt <= 0) return
      const bytes = windowBytes
      windowBytes = 0
      windowStart = now
      if (now - started < warmupMs) return
      const speed = bytes / dt / 1024 / 1024
      if (speed > peak) peak = speed
    }, windowMs)

    const timer = setTimeout(finish, durationMs + 4000)

    // 逐条建立连接，略微错开避免同时挤在同一拥塞窗口
    for (let i = 0; i < connCount; i++) {
      setTimeout(openOne, i * 60)
    }
  })
}
