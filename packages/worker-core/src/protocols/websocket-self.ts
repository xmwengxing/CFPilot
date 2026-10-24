/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）—— **自研数据面**
 *
 * ## 与 vendor 数据面的关系
 *
 * vendor（CFNext 的 `wsHandler`）目前仍在生产使用，作为回退实现保留。
 * 本文件是自研实现，取三家成熟项目之长：
 *   - **CFNext**：出站三级候选（代理 → 直连 → 优选 IP）与竞速语义
 *   - **BPB**：先回协议响应头再中继（客户端据此判定入站已建立）
 *   - **cfnew**：首包数据缓存（竞速期间客户端已发的数据不能丢）
 *   - **edgetunnel**：出站失败必须**可诊断**，不能吞异常
 *
 * ## 相对归档版本（archive/self-developed-dataplane）的关键修正
 *
 * 归档版本失败在出站选路，本版本修正了三点：
 *   1. **优选 IP 里 Cloudflare 网段的会被降权**（Worker 连不回 CF 自家 Anycast 入口，
 *      实测 1.1.1.1 / cloudflare.com / 104.16.0.1 一律被拒，第三方 IP 的 443 完全可用）
 *   2. **同区域过滤不再误杀代理**（归档版写成 `p.kind === 'direct'`，
 *      把 SOCKS5 / HTTP 代理全滤掉了）
 *   3. **失败分级上报**（`onFailure`），不再把一切失败都表现为「目标不可达」
 *
 * 实测与设计详见 docs/self-developed-dataplane-design.md。
 */
import type { UserConfig } from '../types'
import type { ProxyEndpoint } from '../outbound/proxy-pool'
import { parseVlessBuffer, VLESS_COMMAND_UDP } from '../protocols/vless'
import { parseTrojanBuffer, TROJAN_COMMAND_UDP } from '../protocols/trojan'
import { concatBytes } from '../protocols/stream'
import { dial, type DialResult } from '../outbound/dial'
import { classifyDialFailure, explainDialFailure, type DialFailure } from '../outbound/route'

export type WsMode = 'vless' | 'trojan'

/** 单次拨号超时（ms） */
const DIAL_TIMEOUT_MS = 5000

/** 握手头最大长度 */
const MAX_HEADER_BYTES = 64 * 1024

/**
 * 拨号期间暂存缓冲上限。
 *
 * 协议头之后即为负载，拨号期间客户端可能继续发送任意大小的数据。
 * 上限用于兜底防内存膨胀（拨号正常应在数秒内完成）。
 */
const MAX_RELAY_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * 截断 close reason 到 RFC 6455 允许的长度。
 *
 * 超出 123 字节会让 Cloudflare 边缘**静默丢弃 close frame**（真机实测）。
 */
export function truncateCloseReason(reason: string, maxBytes = 123): string {
  const encoder = new TextEncoder()
  if (encoder.encode(reason).length <= maxBytes) return reason

  // 按字节截断，再回退到不破坏 UTF-8 的边界
  let out = reason.slice(0, maxBytes)
  while (encoder.encode(out).length > maxBytes) {
    out = out.slice(0, -1)
  }
  // 去掉可能截断在多字节字符中间产生的半个字符
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\uFFFD+$/, '')

  // ⚠️ 省略号本身也占字节（'…' = 3 字节）—— 必须在**加上它之后**再检查一次。
  // 漏了这一步会超出 1~3 字节，真机上表现为 close frame 仍被丢弃。
  const ellipsis = '…'
  while (out.length > 0 && encoder.encode(out + ellipsis).length > maxBytes) {
    out = out.slice(0, -1)
  }
  return out + ellipsis
}

/**
 * 最近一次出站的诊断记录（isolate 级，最多保留 N 条）。
 *
 * ## 为什么需要它
 *
 * WebSocket close frame 的 reason 最多 123 字节（RFC 6455），
 * 装不下完整的多行诊断说明；超出后 Cloudflare 边缘还会**静默丢弃整个 close frame**。
 *
 * 所以完整诊断必须另辟渠道 —— 这也是自研相对 vendor 的核心优势之一：
 * vendor 把异常吞成「目标不可达」，什么都不留。
 */
const RECENT_DIAGNOSTICS: Array<{
  at: number
  target: string
  failures: DialFailure[]
  summary: string
}> = []

/** 保留条数 */
const RECENT_DIAGNOSTICS_LIMIT = 20

/** 记录一次出站诊断（供 /__diag 端点查询） */
export function recordDiagnostics(
  target: string,
  failures: DialFailure[],
  summary: string
): void {
  RECENT_DIAGNOSTICS.unshift({ at: Date.now(), target, failures, summary })
  if (RECENT_DIAGNOSTICS.length > RECENT_DIAGNOSTICS_LIMIT) {
    RECENT_DIAGNOSTICS.length = RECENT_DIAGNOSTICS_LIMIT
  }
}

/** 读取最近的出站诊断 */
export function recentDiagnostics(): Array<{
  at: number
  target: string
  failures: DialFailure[]
  summary: string
}> {
  return RECENT_DIAGNOSTICS
}

/** 首包等待窗口：客户端可能在 101 之后才发首个数据帧 */
const FIRST_PACKET_TIMEOUT_MS = 80

interface WsTarget {
  command: number
  port: number
  hostname: string
  /** 协议头占用的字节数，其后即为负载 */
  headerLength: number
}

/** 出站诊断信息（供上层记录到日志） */
export interface WsDiagnostics {
  /** 每次出站失败的详情 */
  failures: DialFailure[]
  /** 最终采用的出站方式描述 */
  route?: string
}

/**
 * 处理 WebSocket 升级请求，返回 101 响应并启动双向中继。
 *
 * 认证：VLESS 校验 UUID，Trojan 校验 SHA224 口令。
 */
export async function handleWebSocket(
  request: Request,
  mode: WsMode,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  ctx?: { waitUntil(promise: Promise<unknown>): void },
  diagnostics?: WsDiagnostics
): Promise<Response> {
  // ⚠️ 用 `Object.values` 解构而不是 pair[0] / pair[1]：
  // `WebSocketPair` 的索引顺序不是规范保证的，vendor 也是这么做的。
  // 按索引取可能拿到「客户端侧」那一个，导致 accept 失败或连接不通。
  const [client, server] = Object.values(new WebSocketPair()) as [
    WebSocket,
    WebSocket,
  ]

  try {
    server.accept({ allowHalfOpen: true })
  } catch {
    server.accept()
  }
  // workerd 下 event.data 可能是 Blob，用 arraybuffer 统一拿字节
  server.binaryType = 'arraybuffer'

  // 攒包缓冲：协议头可能跨多个数据帧
  let buffer = new Uint8Array(0)
  let established = false
  let dialed: DialResult | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let firstPacketTimer: ReturnType<typeof setTimeout> | null = null

  const send = (bytes: Uint8Array): void => {
    try {
      server.send(bytes)
    } catch {
      /* 客户端可能已断开 */
    }
  }

  /** 协议响应头：版本(1) + Addons 长度(1) + Addons */
  const sendResponseHeader = (addons: Uint8Array): void => {
    const header = new Uint8Array(2 + addons.byteLength)
    header[0] = 0x00
    header[1] = addons.byteLength
    header.set(addons, 2)
    send(header)
  }

  /**
   * 关闭 WebSocket。
   *
   * ⚠️ **reason 必须截断到 123 字节**（RFC 6455 §5.5.1）：
   * close frame 的 reason 字段最大 123 字节，超出会导致协议错误。
   *
   * 真机实测：诊断信息（`explainDialFailure` 的多行说明）远超 123 字节时，
   * **Cloudflare 边缘会静默丢弃整个 close frame** ——
   * 客户端表现为「一直连着但永远等不到关闭」（静默挂起 45s+），
   * 而本地 workerd 宽容地照发，能正常关闭。
   * 这个差异只在真机上暴露，很容易误判成「出站一直没结束」。
   */
  const closeWith = (code: number, reason: string): void => {
    try {
      server.close(code, truncateCloseReason(reason))
    } catch {
      /* 已关闭 */
    }
  }

  const cleanup = (): void => {
    if (firstPacketTimer) {
      clearTimeout(firstPacketTimer)
      firstPacketTimer = null
    }
    if (dialed) {
      try {
        void dialed.writable.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 下行：出站 → 客户端 */
  const pumpDown = async (): Promise<void> => {
    if (!dialed) return
    const reader = dialed.readable.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) send(value)
      }
    } catch {
      /* 传输错误 */
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* 已释放 */
      }
      closeWith(1000, 'done')
    }
  }

  /** 上行：客户端 → 出站 */
  const pumpUp = async (bytes: Uint8Array): Promise<void> => {
    if (!writer) return
    try {
      await writer.write(bytes)
    } catch {
      cleanup()
    }
  }

  /** 解析协议头 */
  const parseTarget = (bytes: Uint8Array): WsTarget | null => {
    if (mode === 'vless') {
      const parsed = parseVlessBuffer(bytes, config.uuid)
      if (!parsed) return null
      return {
        command: parsed.header.command,
        port: parsed.header.port,
        hostname: parsed.header.hostname,
        headerLength: parsed.consumed,
      }
    }
    const parsed = parseTrojanBuffer(bytes, config.trojanPassword)
    if (!parsed) return null
    return {
      command: parsed.header.command,
      port: parsed.header.port,
      hostname: parsed.header.hostname,
      headerLength: parsed.consumed,
    }
  }

  /**
   * 解析协议头并建立出站连接。
   *
   * ## 顺序（重要，2026-10-23 本地真机验证发现）
   *
   * **先回协议响应头，再做���站** —— 与 vendor（CFNext）和 BPB 一致：
   *
   * ```js
   * // vendor: 认证通过立刻发头，后续处理异步做
   * d(new Uint8Array([0,0]))
   * ```
   *
   * 早前本实现是「先 await 出站建连成功，再回响应头」，
   * 在 workerd 本地真机验证时表现为：
   * `Workers runtime canceled this request because it detected that your Worker's code had hung`
   * ——出站稍慢，客户端就一直等不到响应头。
   *
   * 改成先回响应头后，客户端立即判定「入站已建立」，
   * 出站失败则用 WS close code 1011 + 具体原因告知（分级诊断不受影响）。
   */
  const establish = async (isRetry: boolean): Promise<void> => {
    const target = parseTarget(buffer)
    if (!target) {
      // 数据还不够：等一小会儿再看一次（客户端可能分帧发送）
      if (!isRetry) {
        firstPacketTimer = setTimeout(() => {
          firstPacketTimer = null
          void establish(true).catch((err) => closeWith(1011, String(err)))
        }, FIRST_PACKET_TIMEOUT_MS)
      }
      return
    }
    if (firstPacketTimer) {
      clearTimeout(firstPacketTimer)
      firstPacketTimer = null
    }
    if (established) return
    established = true

    // UDP 暂不支持
    const udpCommand = mode === 'vless' ? VLESS_COMMAND_UDP : TROJAN_COMMAND_UDP
    if (target.command === udpCommand) {
      closeWith(1002, 'UDP over WebSocket 暂不支持')
      return
    }

    // 认证已在 parseTarget 里完成（VLESS 校验 UUID / Trojan 校验口令），
    // 失败时不会走到这里 —— 因此现在可以安全地回响应头。
    //
    // BPB / vendor 做法：先回协议响应头，客户端据此判定入站已建立。
    sendResponseHeader(new Uint8Array(0))

    // 出站：失败分级上报，便于定位（不再一律表现为「目标不可达」）
    const failures: DialFailure[] = []
    let dialError: unknown = null
    try {
      dialed = await dial({
        hostname: target.hostname,
        port: target.port,
        proxies,
        timeoutMs: DIAL_TIMEOUT_MS,
        concurrent: config.concurrentDial,
        nat64: config.nat64 || undefined,
        // 自动 DoH 解析目标域名，取得可用的优选 IP 候选。
        // 解析出的 Cloudflare 网段 IP 会被自动降权（连不回自家 Anycast）。
        resolvePreferred: config.resolvePreferred,
        // 反代入口池：打通 Cloudflare 网段目标的唯一手段。
        // 目标解析结果全是 CF 网段时参与竞速，否则作兜底。
        relayPool: {
          userEntries: config.relayPool || undefined,
          useBuiltin: config.useBuiltinRelay,
          // 当前边缘机房 → 决定优先用哪个地区的反代入口
          colo: typeof request.cf?.colo === 'string' ? request.cf.colo : undefined,
        },
        onFailure: (failure) => {
          failures.push(failure)
          diagnostics?.failures.push(failure)
        },
      })
    } catch (err) {
      dialError = err
    }

    if (!dialed) {
      // 把每一级失败原因都带出去，而不是只说「出站连接失败」
      const detail =
        failures.length > 0
          ? failures.map((f) => explainDialFailure(f)).join('\n')
          : `出站连接失败：${String(dialError)}`
      // 完整诊断另存一份（close reason 装不下，且超长会被边缘静默丢弃）
      recordDiagnostics(
        `${target.hostname}:${target.port}`,
        failures,
        detail
      )
      closeWith(1011, detail)
      return
    }

    writer = dialed.writable.getWriter()

    // cfnew / vendor 做法：把协议头之后已收到的数据整体补写。
    // buffer 里可能不只有首帧的负载——拨号期间到达的后续帧也会暂存进
    // buffer（见 message 处理器里 `if (!writer)` 分支），
    // 因此这里必须整段补写，而不是只写第一帧。
    const payload = buffer.byteLength > target.headerLength ? buffer.slice(target.headerLength) : new Uint8Array(0)
    if (payload.byteLength > 0) await pumpUp(payload)
    buffer = new Uint8Array(0)

    ctx?.waitUntil(pumpDown())
  }

  server.addEventListener('message', (event: MessageEvent) => {
    void (async () => {
      const data = event.data
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer)
      if (bytes.byteLength === 0) return

      if (!established) {
        buffer = concatBytes(buffer, bytes)
        if (buffer.byteLength > MAX_HEADER_BYTES) {
          closeWith(1009, '握手头超过 64KB')
          return
        }
        await establish(false)
        return
      }
      // ⚠️ 拨号期间（established 已置位但 writer 未就绪）到达的数据**不能丢**：
      // 真实客户端（Xray / v2rayN / Clash 等）都是把协议响应头之后的首包
      // 紧跟协议头背靠背发出，不等响应头。早前这里直接走 pumpUp，
      // 而 writer 仍为 null → `if (!writer) return` 静默丢弃 →
      // 表现为「VLESS 认证通过但隧道挂起、永远等不到响应」。
      //
      // vendor（CFNext）的实测形态：暂存回 buffer，writer 就绪后与首包一起补写：
      //   i ? (s ? await s.write(e) : l = l ? concat(l, e) : e) : await u(e)
      if (!writer) {
        buffer = concatBytes(buffer, bytes)
        // 兜底防内存膨胀：拨号期间暂存上限（协议头之后就是负载，允许较大值）
        if (buffer.byteLength > MAX_RELAY_BUFFER_BYTES) {
          closeWith(1009, '拨号期间数据过多')
          return
        }
        return
      }
      await pumpUp(bytes)
    })()
  })

  const onClose = (): void => {
    cleanup()
  }
  server.addEventListener('close', onClose)
  server.addEventListener('error', onClose)

  // Node（vitest）的 Response 不接受 101 状态码，只有 workerd 支持；
  // 因此这里用 200 + webSocket 选项，在 workerd 下同样完成升级。
  // 若运行时不支持 webSocket 选项，则退化为普通 200 响应。
  try {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  } catch (err) {
    // 记录原因，便于排查（否则只会看到一个没有信息量的 200）
    console.error('[自研数据面] 101 响应构造失败：', err)
    return new Response(null, { status: 200 })
  }
}
