/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）—— **自研数据面**
 *
 * ## 与 vendor 数据面的关系
 *
 * 历史第三方实现（`wsHandler`）目前仍在生产使用，作为回退实现保留。
 * 本文件是自研实现，取三家成熟项目之长：
 *   - **历史实现**：出站三级候选（代理 → 直连 → 优选 IP）与竞速语义
 *   - **先回协议响应头**：再中继（客户端据此判定入站已建立）
 *   - **首包数据缓存**：竞速期间客户端已发的数据不能丢
 *   - **可诊断性**：出站失败必须能看出原因，不能吞异常
 *
 * ## 出站选路的三个关键点
 *
 *   1. **优选 IP 里 Cloudflare 网段的会被降权**（Worker 连不回 CF 自家 Anycast 入口，
 *      实测 1.1.1.1 / cloudflare.com / 104.16.0.1 一律被拒，第三方 IP 的 443 完全可用）
 *   2. **同区域过滤不能误杀代理**（`p.kind === 'direct'` 只匹配 ProxyIP，
 *      不能拿它去过滤 SOCKS5 / HTTP 代理）
 *   3. **失败分级上报**（`onFailure`），不再把一切失败都表现为「目标不可达」
 *
 * 实测与设计详见 docs/self-developed-dataplane-design.md。
 */
import type { UserConfig } from '../types'
import type { ProxyEndpoint } from '../outbound/proxy-pool'
import { parseVlessBuffer, VLESS_COMMAND_UDP } from '../protocols/vless'
import { parseTrojanBuffer, TROJAN_COMMAND_UDP } from '../protocols/trojan'
import { DnsUdpSession } from './udp-dns'
import { concatBytes } from '../protocols/stream'
import { dial, type DialResult } from '../outbound/dial'
import { TrafficMeter } from '../budget'
import { classifyDialFailure, explainDialFailure, type DialFailure } from '../outbound/route'
import { collectRelayEndpoints, type RelayEndpoint } from '../outbound/relay'

export type WsMode = 'vless' | 'trojan'

/** 单次拨号超时（ms） */
const DIAL_TIMEOUT_MS = 5000

/**
 * 下行静默检测窗口（ms）。
 *
 * ## 为什么需要
 *
 * Cloudflare Workers 的 `connect()` **只保证 TCP 能建连，不保证能收到数据**。
 * 真机实测（电信千兆，VLESS over WS 到 443 目标）：
 *
 * | 目标 | TCP | TLS | 实际收到字节 |
 * |------|-----|-----|-------------|
 * | `neverssl.com:80` | ✅ | — | 413B ✅ |
 * | `baidu.com:80` | ✅ | — | 241B ✅ |
 * | `github.com:443` | ✅ | ✅ | **0B** ❌ |
 * | `www.youtube.com:443` | ✅ | ✅ | **0B** ❌ |
 *
 * 即：TCP 握手成功、协议响应头 `[0,0]` 已回，但目标站一个字节都不回。
 * 客户端侧表现为「连着但永远等不到响应」，超时后 -1。
 *
 * 通用解法：**直连成功后若下行无数据，自动重拨到反代入口**
 * （第三方服务器按 SNI 转发，出口不是 Cloudflare，因而不受该限制）。
 * 用 NAT64 前缀可达到同样目的。
 *
 * 因此这里做同一件事：建连后 `DOWNLINK_STALL_MS` 内没收到任何下行字节，
 * 就关闭当前出站、改连反代入口重试一次。
 */
const DOWNLINK_STALL_MS = 2500

/** 反代重拨的最多次数（含内置入口的轮换） */
const MAX_RELAY_REDIAL = 2

/** 握手头最大长度 */
const MAX_HEADER_BYTES = 64 * 1024

/**
 * 拨号期间暂存缓冲上限（单连接）。
 *
 * 协议头之后即为负载，拨号期间客户端可能继续发送任意大小的数据。
 * 上限用于兜底防内存膨胀（拨号正常应在数秒内完成）。
 */
const MAX_RELAY_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * 单个 isolate 内「未确认通路的上行留存」总预算。
 *
 * ## 为什么单连接上限不够
 *
 * 每个假活 / 拨号中的连接最多可留存 8 MiB。并发 20 条就是 160 MiB ——
 * Workers 的 isolate 内存上限是 128 MiB，而且这 20 条连接完全可能是
 * 同一个客户端（多开）或同一批扫描流量造成的，不是恶意才有的形态。
 *
 * 取 32 MiB：足够覆盖「TLS ClientHello + 大 POST 首包」的正常重放（几 KB~几 MB），
 * 又能把极端情况下的占用压到 isolate 内存上限的四分之一。
 * 超预算的连接直接关闭（1009），客户端重连后仍会走直连 —— 不会变成黑洞。
 */
const MAX_RETAINED_TOTAL_BYTES = 32 * 1024 * 1024

/** 当前 isolate 内所有连接的上行留存总量（模块级，跨连接共享） */
let retainedTotalBytes = 0

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
/**
 * 握手截止时间：**首个字节到达**后，必须在这段时间内凑齐完整可认证的协议头。
 *
 * ## 为什么必须有
 *
 * 早前对「协议头不完整 / 认证失败」的处理是静默 return ——
 * 连接既不关闭也不报错，一直占用着 isolate 的 WebSocket 与出站资源，
 * 直到运行时自己超时。错误 UUID / 错误口令的客户端、
 * 或者扫描器故意发半个头，都会命中这条路。
 *
 * 2 秒的依据：真实客户端（Xray / v2rayN / Clash / sing-box）都是
 * 建立 WS 后**立即**发送完整协议头，实测 < 100ms；
 * 给 2 秒足够覆盖慢网与分帧，又不至于让异常连接长期占用资源。
 */
const HANDSHAKE_DEADLINE_MS = 2000

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
 * 解析 `Sec-WebSocket-Protocol` 里的 0-RTT 早期数据（Xray `?ed=2048`）。
 *
 * 主流客户端（Xray / sing-box / Mihomo）开启 early data 后把首包 Base64
 * 编码塞进子协议头随升级请求一起送达，省掉 WS 建连后的一个往返。
 * 此前本实现忽略该头：开了 `ed` 的客户端会永远等不到服务端消费它的首包
 * （握手数据只在头里、不作为首帧重发），表现为连接必挂。
 *
 * 解码失败或过短（< 17 字节，连 VLESS 版本+UUID 都不够）一律忽略 ——
 * 普通客户端的非 early-data 子协议头（如 `graphql-ws`）不受影响。
 * 解码后限 8192 字节：early data 只承载首包，正常远小于此值。
 */
function decodeEarlyData(headerValue: string | null): Uint8Array {
  if (!headerValue) return new Uint8Array(0)
  const raw = headerValue.trim()
  if (!raw || raw.length > 16384) return new Uint8Array(0)
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const bin = atob(b64 + pad)
    if (bin.length < 17 || bin.length > 8192) return new Uint8Array(0)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
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

  // 攒包缓冲：协议头可能跨多个数据帧。
  // 0-RTT：Xray 等客户端开 `?ed=2048` 后会把首包 Base64 放进
  // `Sec-WebSocket-Protocol` 随升级请求送达（不再作为首帧重发）——
  // 直接作为种子；忽略该头时行为与原来完全一致。
  let buffer = decodeEarlyData(request.headers.get('sec-websocket-protocol'))
  let established = false
  let dialed: DialResult | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  /** 握手截止定时器（**唯一一个**：绝不在每帧里新建） */
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** 下行 reader（清理时需要 cancel，否则读任务挂到运行时超时） */
  let downReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  /** 是否已经进入关闭流程（closeWith 置位，用于让时间线后续步骤短路） */
  let closed = false
  /** 清理是否已执行过（幂等：客户端断开 / 读错误 / 拨号超时都可能抢先触发） */
  let cleanupDone = false
  /**
   * 当前会话的目标站信息。
   *
   * 提到外层作用域是为了让 `redialViaRelay()` 能拿到它做诊断记录
   * （反代重拨发生在 `establish()` 之后，那里有自己的局部 target）。
   */
  let target: WsTarget | null = null

  /**
   * DNS-over-DoH 会话（仅 `udpDns === 'doh'` 且命令为 UDP/53 时存在）。
   *
   * 一旦置位，这条连接的上行字节**全部**交给它按长度前缀切帧，
   * 不再走 `writer`（UDP 连接根本没有出站 socket）。
   */
  let udpSession: DnsUdpSession | null = null

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
    closed = true
    try {
      server.close(code, truncateCloseReason(reason))
    } catch {
      /* 已关闭 */
    }
    cleanup()
  }

  /**
   * 统一清理：**幂等**，无论谁先触发（客户端断开 / 读错误 / 拨号超时 / 正常结束）
   * 都只真正执行一次。
   *
   * 四件事缺一不可：
   *  1. 清定时器（握手截止 / 下行静默）；
   *  2. 取消下行 reader —— 只 close writable 的话，挂起的 `reader.read()`
   *     要等运行时超时才回收；
   *  3. 关闭底层 Socket —— 优先用 `DialResult.close()`（`socket.close()` 同时关读写两端，
   *     立即释放 Workers 的并发连接槽位），没有则退回 `writable.close()`；
   *  4. 释放重放留存缓冲。
   */
  const cleanup = (): void => {
    if (cleanupDone) return
    cleanupDone = true
    clearRetained()
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
    if (downReader) {
      const reader = downReader
      downReader = null
      try {
        void reader.cancel()
      } catch {
        /* 已释放 */
      }
    }
    if (dialed) {
      const close = dialed.close
      if (close) {
        try {
          void close()
        } catch {
          /* 已关闭 */
        }
      } else {
        try {
          void dialed.writable.close()
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  /**
   * 下行静默检测定时器。
   *
   * 建连后启动；收到第一个下行字节或出站流结束时清除。
   * 到点仍未收到字节 → 判定「直连假活」，触发反代重拨。
   */
  let stallTimer: ReturnType<typeof setTimeout> | null = null

  /** 已尝试过的反代入口（避免同一入口反复重试） */
  const triedRelays = new Set<string>()

  /** 反代重拨次数 */
  let relayRedialCount = 0

  /**
   * 下行首字节确认前的上行留存（反代重拨重放用）。
   *
   * 真机缺陷（2026-10-27 实测定位）：
   * 直连可能「假活」—— TCP 通了但目标站收不到数据，写进去的上行被静默丢弃。
   * 早前 `establish` 把首包写进直连后**立即清空 buffer**，
   * 假活触发反代重拨时重放的是空缓冲 —— 反代永远收不到 TLS ClientHello，
   * 连接必然卡死到超时（假活重拨形同虚设）。
   *
   * 现在：下行首字节到达（= 通路确认）之前，所有上行都留存一份；
   * 重拨时整体重放，直到新通路首字节确认后再释放。
   */
  let retained: Uint8Array[] = []
  let retainedBytes = 0

  const retain = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0 || downlinkBytes > 0) return // 通路已确认，无需留存
    if (retainedBytes + bytes.byteLength > MAX_RELAY_BUFFER_BYTES) {
      closeWith(1009, '未确认通路的上行数据过多')
      return
    }
    // 单连接上限之外还要看 isolate 总预算：并发连接各留几 MB 就能把内存吃穿
    if (retainedTotalBytes + bytes.byteLength > MAX_RETAINED_TOTAL_BYTES) {
      closeWith(1009, '实例内存预算已满，请重试')
      return
    }
    retained.push(bytes)
    retainedBytes += bytes.byteLength
    retainedTotalBytes += bytes.byteLength
  }

  const clearRetained = (): void => {
    // 先减总量再清空 —— 本函数会被「首字节到达」与「清理」各调一次，
    // 靠 retainedBytes 归零保证不会重复扣减。
    retainedTotalBytes = Math.max(0, retainedTotalBytes - retainedBytes)
    retained = []
    retainedBytes = 0
  }

  /**
   * 下行泵的「代号」。
   *
   * 反代重拨会启动**第二条**下行泵，而旧泵不会立即结束 ——
   * 它还在旧的 socket 上 `await reader.read()`。旧泵退出时绝不能
   * 替整个会话收尸（那样刚切到的新通路会被一并关掉），
   * 也不能清掉新泵的静默检测定时器（两者共用 `stallTimer`）。
   * 因此每个泵带一个递增代号，只有**当前代号**有权结束会话、清理共享定时器。
   */
  let pumpGeneration = 0

  /**
   * 让当前下行泵失效（它退出时不再拥有「结束会话」的权力）。
   *
   * ⚠️ 反代重拨**必须**先调它、再关闭旧出站：
   * 关闭旧 socket 会让旧泵的 `read()` 立即失败，若它此时仍是「当前代」，
   * 就会按「下行结束」给整个会话收尸 ——
   * 真机实测（静默窗口降到 300ms 的插桩构建）：重拨刚发起就被自己关掉，
   * close 1000 + 0 字节，重拨永远不可能成功。
   */
  const retirePump = (): void => {
    pumpGeneration += 1
  }

  /** 下行：出站 → 客户端 */
  const pumpDown = async (): Promise<void> => {
    if (!dialed) return
    const generation = ++pumpGeneration
    const reader = dialed.readable.getReader()
    downReader = reader
    // 建连后启动静默检测：目标是「TCP 通了但收不到数据」的假活场景
    if (stallTimer) clearTimeout(stallTimer)
    const stall = setTimeout(() => {
      if (stallTimer === stall) stallTimer = null
      if (downlinkBytes > 0) return
      // 只有「已经向上游写过数据」时才值得判定假活。
      //
      // 客户端在协议头之后一个字节都没发（比如某些需要先收到响应才继续的
      // 应用层协议），静默完全是**预期行为**：这时重拨既没有可重放的数据，
      // 又会让同一个请求在另一个上游连接上再走一遍。
      if (retainedBytes === 0) return
      // 一个字节都没收到 —— 这条出站是假活，换反代入口重拨
      recordDiagnostics(
        `${target!.hostname}:${target!.port}`,
        [],
        `直连 ${DOWNLINK_STALL_MS}ms 无下行数据，改走反代入口`
      )
      void redialViaRelay()
    }, DOWNLINK_STALL_MS)
    stallTimer = stall

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          const firstByte = downlinkBytes === 0
          downlinkBytes += value.byteLength
          if (firstByte) clearRetained() // 通路确认，释放重放留存
          // 流量熔断：超限立即结束，不再把这块数据发给客户端
          if (traffic.add(value.byteLength)) {
            cutByTraffic()
            return
          }
          send(value)
        }
      }
    } catch {
      /* 传输错误 */
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* 已释放 */
      }
      // 只清自己的定时器：共享变量此时可能已经属于新的下行泵
      clearTimeout(stall)
      if (stallTimer === stall) stallTimer = null
      if (downReader === reader) downReader = null
      // 只有当前代的下行泵有权结束会话（旧泵在重拨后退出属于正常现象）；
      // 已经因流量熔断 / 客户端断开关闭过时也不再重复关。
      if (generation === pumpGeneration && !closed) closeWith(1000, 'done')
    }
  }

  /** 已收到的下行字节数（用于静默检测） */
  let downlinkBytes = 0

  /**
   * 单连接流量计量（上下行合计）。
   *
   * 上限来自配置 `dataBudgetMB`，**0 表示不限制**（默认，行为与未引入时一致）。
   * 数据面本身不会被「跑太久」杀掉，但每条中继连接都在持续消耗 CPU 配额，
   * 单条超大流量连接能把账号当日额度吃穿，之后所有请求一起 503。
   * 超限时主动断连让客户端重连，比整账号被限流划算。
   */
  const traffic = new TrafficMeter((config.dataBudgetMB || 0) * 1024 * 1024)

  /** 流量超限：记诊断 + 关闭连接（1009 = 消息过大，客户端会重连） */
  const cutByTraffic = (): void => {
    const reason = `单连接流量超过 ${config.dataBudgetMB}MB 上限`
    recordDiagnostics(
      target ? `${target.hostname}:${target.port}` : '未建立出站',
      [],
      reason
    )
    closeWith(1009, reason)
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

  /**
   * 把「拨号 / 反代重拨期间」暂存的上行补写到**当前**出站。
   *
   * ## 为什么必须有
   *
   * `writer` 在反代重拨时会被置空，客户端在此期间继续发的帧只能落进 `buffer`
   * （message 处理器里 `if (!writer)` 那一支）。重拨成功后若不补写，
   * 这些字节会**永远留在 buffer 里**：出站再也收不到它们，
   * 客户端等不到响应，表现为「切换反代之后隧道静默挂起，直到超时变 -1」。
   *
   * `establish()` 里只在首次建连后补写过一次，重拨路径不走那里，
   * 因此需要这个独立入口。
   *
   * 补写前先 `retain` —— 新通路同样可能是假活（见 `retained` 注释），
   * 重放数据必须完整，不能只重放首次建连前的那些。
   */
  const flushPendingUplink = async (): Promise<void> => {
    if (!writer || buffer.byteLength === 0) return
    const pending = buffer
    buffer = new Uint8Array(0)
    retain(pending)
    await pumpUp(pending)
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
   * ## 顺序（重要，本地真机验证发现）
   *
   * **先回协议响应头，再做出站** —— 社区通用做法：
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
  const clearHandshakeTimer = (): void => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
  }

  /**
   * 握手截止到点：再解析一次（截止前可能刚好凑齐），仍失败就**关闭连接**。
   *
   * 关闭是关键 —— 早前这里只是 return，于是「协议头不完整 / 认证失败」的
   * 连接既不报错也不释放，一直挂着占资源。
   */
  const onHandshakeDeadline = async (): Promise<void> => {
    if (closed || established) return
    if (parseTarget(buffer)) {
      await establish()
      return
    }
    closeWith(
      1008,
      buffer.byteLength === 0 ? '握手超时：未收到协议头' : '握手超时：协议头不完整或认证失败'
    )
  }

  const establish = async (): Promise<void> => {
    if (closed || established) return
    const parsed = parseTarget(buffer)
    if (!parsed) {
      // 数据还不够（客户端可能分帧发送）：登记**唯一一个**截止定时器。
      //
      // ⚠️ 不能每帧都 setTimeout：旧定时器不会被清掉，会累积出多个
      // 并发的 establish/onHandshakeDeadline，最终互相踩状态。
      if (buffer.byteLength > 0 && !handshakeTimer) {
        handshakeTimer = setTimeout(() => {
          handshakeTimer = null
          void onHandshakeDeadline().catch((err) => closeWith(1011, String(err)))
        }, HANDSHAKE_DEADLINE_MS)
      }
      return
    }
    clearHandshakeTimer()
    if (established) return
    established = true
    // 同步到外层作用域：反代重拨（redialViaRelay）需要它做诊断记录
    target = parsed

    // UDP：Workers 没有 UDP socket，只有 **DNS/53** 能靠 DoH 打通。
    //
    // 判定顺序很重要：
    //   1. 开关打开 + VLESS + 端口 53 → 走 DoH（先回协议响应头，与 TCP 一致）
    //   2. 其余一律明确拒绝，并在 reason 里写清「只支持 DNS」——
    //      客户端把它显示在日志里，比一句「暂不支持」有用得多
    const udpCommand = mode === 'vless' ? VLESS_COMMAND_UDP : TROJAN_COMMAND_UDP
    if (parsed.command === udpCommand) {
      if (mode === 'vless' && config.udpDns === 'doh' && parsed.port === 53) {
        sendResponseHeader(new Uint8Array(0))
        udpSession = new DnsUdpSession({
          endpoint: config.udpDnsEndpoint,
          send,
        })
        const firstPayload = buffer.subarray(parsed.headerLength)
        if (firstPayload.byteLength > 0) udpSession.push(firstPayload)
        return
      }
      closeWith(
        1002,
        config.udpDns === 'doh'
          ? 'UDP 仅支持 DNS（53 端口）'
          : 'UDP 未启用（面板可开启 DNS over DoH）'
      )
      return
    }

    // 认证已在 parseTarget 里完成（VLESS 校验 UUID / Trojan 校验口令），
    // 失败时不会走到这里。
    //
    // ## ⚠️ 协议响应头**只有 VLESS 有**，Trojan 一个字节都不能回
    //
    // VLESS 的响应头（版本 + Addons 长度）是协议的一部分，客户端收到它才认为入站已建立。
    // 但 **Trojan 协议没有响应头** —— 服务端认证通过后直接进入透明转发，
    // 客户端收到的第一个字节就是目标站的数据。
    //
    // 2026-10-28 真机定位（用户报「Trojan 节点全部 -1」）：
    // 这里原先对两种协议都发 `[0x00, 0x00]`，于是 trojan 客户端在自己的下行流最前面
    // 吃到两个 NUL 字节 —— TLS 记录头被这两个字节顶偏，握手直接失败。
    // 真机抓到的下行开头是 `0000 485454502f312e31...`（== `\0\0HTTP/1.1`），
    // 而正确报文必须以目标站的第一个字节开头。
    if (mode === 'vless') sendResponseHeader(new Uint8Array(0))

    // 出站：失败分级上报，便于定位（不再一律表现为「目标不可达」）
    const failures: DialFailure[] = []
    let dialError: unknown = null
    try {
      dialed = await dial({
        hostname: parsed.hostname,
        port: parsed.port,
        proxies,
        timeoutMs: DIAL_TIMEOUT_MS,
        concurrent: config.concurrentDial,
        nat64: config.nat64 || undefined,
        // 代理调度模式（only / global / fallback / smart）——
        // 决定「配了代理之后按什么顺序尝试各条通道」。
        proxyMode: config.proxyMode,
        // ⚠️ 这里**不要**传 `config.add`（面板回填的优选 IP）。
        //
        // `optimizedIps` 的语义是「**目标站**的落地 IP 候选」——
        // 访问 www.youtube.com 时用哪些 IP 去连 YouTube。
        // 而面板里回填的 IP 是 **Cloudflare 边缘 IP**（客户端连 Worker 用的），
        // 两者完全不同。把边缘 IP 当目标站 IP 会让出站全部连错地方。
        //
        // 目标站的落地候选由 `resolvePreferred`（DoH 解析）负责，
        // 那才是「优选」在出站侧的正确含义。
        //
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
        `${parsed.hostname}:${parsed.port}`,
        failures,
        detail
      )
      closeWith(1011, detail)
      return
    }

    writer = dialed.writable.getWriter()

    // 通用做法：把协议头之后已收到的数据整体补写。
    // buffer 里可能不只有首帧的负载——拨号期间到达的后续帧也会暂存进
    // buffer（见 message 处理器里 `if (!writer)` 分支），
    // 因此这里必须整段补写，而不是只写第一帧。
    // 用 subarray 而不是 slice：这里只是给「协议头之后的负载」一个视图，
    // 复制一遍纯属浪费（大首包 / TLS ClientHello 有几 KB）。
    // 视图指向的 buffer 紧接着会被置空，retain 留存的是视图本身，重放时会真正复制。
    const payload =
      buffer.byteLength > parsed.headerLength ? buffer.subarray(parsed.headerLength) : new Uint8Array(0)
    if (payload.byteLength > 0) {
      // 先留存再写：直连可能假活，首字节确认前上行必须可重放
      retain(payload)
      await pumpUp(payload)
    }
    buffer = new Uint8Array(0)

    ctx?.waitUntil(pumpDown())
  }

  /**
   * 下行无数据时改走反代入口重拨。
   *
   * ## 背景
   *
   * Cloudflare Workers 的 `connect()` 对部分目标（Google / YouTube / GitHub
   * 等 443）**TCP 能建连但一个字节都收不到**。这不是我们的代码问题，
   * 是 Cloudflare 边缘出口的限制 —— 同类实现的解法都是
   * 「假活时改走反代入口」：第三方服务器按 SNI 把流量转到目标站，
   * 出口不是 Cloudflare，因而不受该限制。
   *
   * ## 与内置反代机制的关系
   *
   * `dial()` 内部已有反代逻辑，但**只在目标解析结果全是 CF 网段时才启用**
   * （见 `outbound/dial.ts` 的 `relayNeeded`）。Google / YouTube 解析到
   * `142.251.x.x`（非 CF 网段），因此走不到那条路径 —— 这正是漏洞。
   *
   * 本函数补上这条路径：**无条件**在假活时尝试反代。
   *
   * ## 数据不丢
   *
   * 重拨前已写入假活连接的上行数据目标站收不到，但 `retained` 里留有
   * 下行首字节确认前的完整上行副本 —— 反代建连成功后整体重放，
   * TLS ClientHello / HTTP 首包不会丢。（此前 buffer 被 establish 提前清空，
   * 重放恒为空 —— 是 2026-10-27 代码核实确认的致命缺陷。）
   */
  const redialViaRelay = async (): Promise<void> => {
    // target 理论上一定已解析（本函数只在 establish 成功后由静默检测触发），
    // 这里仍做空判断，避免未来重构把调用点提前。
    const targetInfo = target
    if (!targetInfo) {
      closeWith(1011, '出站无数据：目标未解析')
      return
    }
    if (relayRedialCount >= MAX_RELAY_REDIAL) {
      // 反代也试过了，仍然假活 —— 明确告知客户端，不要静默挂起
      closeWith(1011, '出站无数据：直连与反代入口均无响应')
      return
    }
    relayRedialCount++

    // 收反代入口候选：用户自配优先，其次内置表（按当前 colo 选地区）
    let endpoints: RelayEndpoint[] = []
    try {
      endpoints = await collectRelayEndpoints({
        userEntries: config.relayPool || undefined,
        useBuiltin: config.useBuiltinRelay,
        colo: typeof request.cf?.colo === 'string' ? request.cf.colo : undefined,
      })
    } catch {
      endpoints = []
    }
    // 过滤已试过的，避免同一入口反复重试
    const fresh = endpoints.filter((e) => !triedRelays.has(`${e.ip}:${e.port}`))
    if (fresh.length === 0) {
      closeWith(1011, '出站无数据：无反代入口可用')
      return
    }

    for (const endpoint of fresh.slice(0, MAX_RELAY_REDIAL)) {
      triedRelays.add(`${endpoint.ip}:${endpoint.port}`)
      // 关掉假活的旧出站（不动客户端 WS）。
      //
      // ⚠️ 必须用 `DialResult.close()`（`socket.close()`）而不是 `writable.close()`：
      // 后者的写端此时被 reader/writer 锁着，调用会直接抛错并被吞掉，
      // 旧连接实际上根本没关 —— 一直占着「单请求 6 条并发出站」里的一个槽位。
      // 旧连接关闭后它那条下行泵会退出，代号已经过期，不会连带关掉会话。
      //
      // ⚠️ 顺序不能反：必须**先** retired 旧泵，再关闭旧 socket。
      // 反过来就是真机实测到的「重拨刚发起就把会话关掉」（0 字节 + close 1000）。
      retirePump()
      if (dialed) {
        const previous = dialed
        if (previous.close) {
          try {
            void previous.close()
          } catch {
            /* 已关闭 */
          }
        }
      }
      writer = null
      downlinkBytes = 0

      try {
        const socket = await dial({
          hostname: endpoint.ip,
          port: endpoint.port,
          timeoutMs: DIAL_TIMEOUT_MS,
          // 反代路径不做 DoH 解析（入口已是解析好的 IP）
          resolvePreferred: false,
        })
        if (!socket) continue

        dialed = socket
        writer = socket.writable.getWriter()

        // 反代是「按 SNI 转发」的第三方服务器。
        //
        // ⚠️ VLESS over WS 是 TLS 透传（铁律12）：Worker 不终结出站 TLS，
        // 客户端与目标站直接完成 TLS。所以反代收到的就是客户端的原始
        // ClientHello（SNI = 目标站）—— 无需 Worker 做任何改写，直通即可。
        //
        // 重放首字节确认前的全部上行（TLS ClientHello / HTTP 首包等）。
        // ⚠️ 不在这里清空 —— 要等新通路的下行首字节确认后再释放（pumpDown）；
        // 多个反代入口依次尝试时，每个都能拿到完整的重放数据。
        if (retained.length > 0) {
          let total = 0
          for (const c of retained) total += c.byteLength
          const replay = new Uint8Array(total)
          let off = 0
          for (const c of retained) {
            replay.set(c, off)
            off += c.byteLength
          }
          await writer.write(replay)
        }

        // 重拨期间客户端继续发的帧暂存在 buffer 里 —— 这里补写，
        // 否则它们会一直留在 buffer 中等待一个永远不会到来的 establish。
        await flushPendingUplink()

        recordDiagnostics(
          `${targetInfo.hostname}:${targetInfo.port}`,
          [],
          `已切换反代入口 ${endpoint.ip}:${endpoint.port}`
        )
        // 重新启动下行泵（含新的静默检测）
        ctx?.waitUntil(pumpDown())
        return
      } catch (err) {
        recordDiagnostics(
          `${targetInfo.hostname}:${targetInfo.port}`,
          [],
          `反代入口 ${endpoint.ip}:${endpoint.port} 失败：${String(err)}`
        )
        // 继续试下一个入口
      }
    }

    // 所有入口都失败
    closeWith(1011, '出站无数据：所有反代入口均失败')
  }

  server.addEventListener('message', (event: MessageEvent) => {
    void (async () => {
      const data = event.data
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer)
      if (bytes.byteLength === 0) return

      // 数据面流量熔断：上下行都计量，超限即断（0 = 不限制）
      if (traffic.add(bytes.byteLength)) {
        cutByTraffic()
        return
      }

      if (!established) {
        buffer = concatBytes(buffer, bytes)
        if (buffer.byteLength > MAX_HEADER_BYTES) {
          closeWith(1009, '握手头超过 64KB')
          return
        }
        await establish()
        return
      }
      // DNS-over-DoH 会话：上行全部按长度前缀切帧，不走出站 socket
      if (udpSession) {
        udpSession.push(bytes)
        return
      }
      // ⚠️ 拨号期间（established 已置位但 writer 未就绪）到达的数据**不能丢**：
      // 真实客户端（Xray / v2rayN / Clash 等）都是把协议响应头之后的首包
      // 紧跟协议头背靠背发出，不等响应头。早前这里直接走 pumpUp，
      // 而 writer 仍为 null → `if (!writer) return` 静默丢弃 →
      // 表现为「VLESS 认证通过但隧道挂起、永远等不到响应」。
      //
      // 实测形态：暂存回 buffer，writer 就绪后与首包一起补写：
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
      // 首字节确认前的上行留存（假活时反代重拨要重放，见 retain 注释）
      retain(bytes)
      await pumpUp(bytes)
    })()
  })

  const onClose = (): void => {
    cleanup()
  }
  server.addEventListener('close', onClose)
  server.addEventListener('error', onClose)

  // 0-RTT：early data 里可能已是完整协议头，主动触发 establish ——
  // 客户端在收到下行前不会再发帧，不主动触发会白等到超时。
  if (buffer.byteLength > 0) {
    void establish().catch((err) => closeWith(1011, String(err)))
  }

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
