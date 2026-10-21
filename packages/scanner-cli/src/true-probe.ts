/**
 * 真连接探针
 *
 * 核心突破：直连候选 IP，但强制使用用户自己的 Worker 域名作为 TLS SNI 与 HTTP Host，
 * 完整执行 TLS 握手 + WebSocket 101 升级握手，
 * 只有真正能连上「你自己的域名」的 IP 才会被保留 —— 彻底过滤掉 -1 废节点。
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

export interface DownloadResult {
  ok: boolean
  bytes: number
  ms: number
  speedMBps: number
  error?: string
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
  timeoutMs = 3000
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
      `GET /__edge_probe HTTP/1.1`,
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
 * 阶段三：在用户自己的域名下测试真实下行速度
 */
export function measureDownload(
  ip: string,
  port: number,
  host: string,
  bytes: number,
  timeoutMs = 12000
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
      `GET /__edge_probe?bytes=${bytes} HTTP/1.1`,
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
        return
      }
      received += chunk.byteLength
    })
  })
}
