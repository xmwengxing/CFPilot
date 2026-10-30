/**
 * 出口体检（客户端侧）
 *
 * 调数据面的 `/__unlock_probe`，拿回「这个机房出去能到哪些服务」。
 *
 * ## 为什么要按机房去重
 *
 * 体检结果由**出口**决定，而出口由机房决定 —— 同一机房下的所有优选 IP
 * 结果完全一样。50 个 IP 逐个测就是 50 次重复请求，纯浪费。
 * 因此调用方应当先按 `colo` 去重，每个机房挑一条代表 IP 去测。
 *
 * ## 与隧道校验的区别
 *
 * `verifyTunnel` 是「用真实 VLESS 隧道访问一个目标」，能验证端到端可用性；
 * 这里是「让 Worker 自己出去看一眼」，只验证出口能力。两者互补：
 * 前者回答「这条隧道通不通」，后者回答「通了之后能干什么」。
 */
import * as tls from 'node:tls'

export interface UnlockTargetResult {
  id: string
  verdict: 'ok' | 'blocked' | 'region' | 'unknown'
  status: number
  ms: number
  loc?: string
  error?: string
}

export interface UnlockResult {
  ok: boolean
  colo: string
  region: string
  targets: UnlockTargetResult[]
  error?: string
}

export interface UnlockProbeOptions {
  /** 候选 IP（连它，SNI 用 host） */
  ip: string
  /** 端口，默认 443 */
  port: number
  /** 数据面域名（TLS SNI + HTTP Host） */
  host: string
  /** 访问令牌（= 完整 UUID） */
  token: string
  /** 超时（ms） */
  timeoutMs?: number
}

/**
 * 对单个机房做一次体检。
 *
 * 失败一律返回 `{ ok: false, error }`，**不抛异常** ——
 * 体检是附加信息，任何失败都不应该让整轮优选失败。
 */
export function probeUnlock(options: UnlockProbeOptions): Promise<UnlockResult> {
  const { ip, port = 443, host, token, timeoutMs = 12000 } = options
  return new Promise((resolve) => {
    let settled = false
    let raw: Buffer = Buffer.alloc(0)
    const finish = (result: UnlockResult): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve(result)
    }

    const socket = tls.connect(
      {
        host: ip,
        port,
        servername: host,
        // 证书是给域名签的，我们连的是 IP；这里只验证「能不能通」，不校验证书链
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      },
      () => {
        socket.write(
          [
            'GET /__unlock_probe HTTP/1.1',
            `Host: ${host}`,
            `x-cfpilot-token: ${token}`,
            'Accept: application/json',
            'Connection: close',
            '',
            '',
          ].join('\r\n')
        )
      }
    )

    socket.setTimeout(timeoutMs, () => finish({ ok: false, colo: '', region: '', targets: [], error: '超时' }))
    socket.on('error', (err: Error) => finish({ ok: false, colo: '', region: '', targets: [], error: err.message }))

    socket.on('data', (chunk: Buffer) => {
      raw = raw.length === 0 ? chunk : Buffer.concat([raw, chunk])
      const idx = raw.indexOf('\r\n\r\n')
      if (idx < 0) {
        if (raw.length > 16384) finish({ ok: false, colo: '', region: '', targets: [], error: '响应头异常' })
        return
      }
      const head = raw.subarray(0, idx).toString('latin1')
      const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1]
      const body = raw.subarray(idx + 4).toString('utf8')
      // 端点默认关闭时数据面回 404（等价于不存在），这里给出可读提示
      if (status !== '200') {
        finish({
          ok: false,
          colo: '',
          region: '',
          targets: [],
          error:
            status === '404'
              ? '端点未开启（面板「出站与高级」里打开「出口体检」）'
              : status === '403'
                ? '令牌无效（需传完整 UUID）'
                : `HTTP ${status ?? '?'}`,
        })
        return
      }
      try {
        const parsed = JSON.parse(body) as UnlockResult & { ok?: boolean }
        finish({
          ok: true,
          colo: parsed.colo ?? '',
          region: parsed.region ?? '',
          targets: Array.isArray(parsed.targets) ? parsed.targets : [],
        })
      } catch {
        finish({ ok: false, colo: '', region: '', targets: [], error: '响应不是合法 JSON' })
      }
    })

    socket.on('end', () => {
      // 服务端 Connection: close，正常收尾
      if (!settled) finish({ ok: false, colo: '', region: '', targets: [], error: '连接提前结束' })
    })
  })
}

/** 人类可读的一行摘要（日志 / 终端输出用） */
export function describeUnlock(result: UnlockResult): string {
  if (!result.ok) return `体检失败：${result.error ?? '未知原因'}`
  const parts = result.targets.map((t) => `${t.id}:${t.verdict}`)
  return `${result.colo || 'UNK'} ${parts.join(' ')}`
}
