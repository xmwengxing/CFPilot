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
import { parseVlessBuffer, validateVlessHeader, vlessAuthFailed, VLESS_COMMAND_UDP } from '../protocols/vless'
import { parseTrojanBuffer, TROJAN_COMMAND_UDP, trojanAuthFailed } from '../protocols/trojan'
import { DnsUdpSession } from './udp-dns'
import { concatBytes, DownlinkPacer, normalizeWsMessage } from '../protocols/stream'
import { canSwitchToBuiltinRelay } from './relay-guard'
import { UplinkQueue } from './uplink-queue'
import { dial, type DialResult } from '../outbound/dial'
import {
  confirmRelaySuccess,
  endpointKey,
  penalizeRelayEndpoint,
  sortByEndpointHealth,
} from '../outbound/endpoint-health'
import { buildDialOptions } from '../outbound/dial-options'
import { TrafficMeter } from '../budget'
import { truncate } from '../util'
import {
  classifyDialFailure,
  explainDialFailure,
  isCloudflareIpv4,
  isPublicDnsIpv4,
  type DialFailure,
} from '../outbound/route'
import { collectRelayEndpoints, type RelayEndpoint } from '../outbound/relay'
import { hostPolicyFor, type HostPolicy } from '../outbound/pinned'

export type WsMode = 'vless' | 'trojan'

/**
 * 时序参数已迁移到配置层（P1 #11：`config.dialStallMs` /
 * `config.relayRedialMax` / `config.dialConnectMs`），由 `buildDialOptions`
 * 与这里的使用点统一读取。模块级只保留「重拨单入口的拨号上限」这一个
 * 与配置无关的安全帽：重拨不能比常规拨号更久。
 */
const REDIAL_DIAL_TIMEOUT_MS = 3000

/**
 * 下行静默检测窗口与假活换入口上限（P1 #11 起从配置层读取）。
 *
 * ## 背景（真机实测）
 *
 * Cloudflare Workers 的 `connect()` **只保证 TCP 能建连，不保证能收到数据**：
 * `github.com:443` / `www.youtube.com:443` TCP+TLS 都成功但 0 字节下行，
 * 客户端表现为「连着但永远等不到响应」，超时后 -1。通用解法是
 * **直连成功后若下行无数据，自动重拨到反代入口**重试一次；用 NAT64 同理。
 *
 * 窗口值来自 `config.dialStallMs`（默认 2500ms），换入口上限来自
 * `config.relayRedialMax`（默认 2）。重拨后的确认窗口取静默窗口的一半
 * （下限 400ms）—— 那是「已知上一个入口假活」后的确认，不该再等满全程。
 * 全部可在 KV / 环境变量里调整，无需改源码发版。
 */

/**
 * 判断首块下行字节是否为 **TLS Fatal Alert**（7 字节：`15 03 0x 00 02 02 <desc>`）。
 *
 * ## 为什么要识别它（2026-11-21 真机定位）
 *
 * 实测大量老化反代入口在收到目标站 SNI 的 ClientHello 后，不是超时/断连，
 * 而是由反代自己的 TLS 栈直接回 7 字节 Fatal Alert：
 *   - `alert 40`（handshake_failure）：反代不识别该 SNI 或证书不匹配；
 *   - `alert 80`（internal_error）：反代后端转发失败；
 *   - `alert 112`（unrecognized_name）：反代拒绝该 SNI。
 *
 * 若不识别这 7 字节，下行泵会把它们当成「首字节确认」直接转发给客户端并
 * 清空重放缓冲 —— 既不触发假活换入口，又把该坏反代锁进「成功记忆」，
 * 导致 x.com / api.x.com / cloudflare.com 每次请求都秒败。
 */
export function isTlsFatalAlert(chunk: Uint8Array): boolean {
  return (
    chunk.byteLength >= 7 &&
    chunk[0] === 0x15 &&
    chunk[1] === 0x03 &&
    chunk[3] === 0x00 &&
    chunk[4] === 0x02 &&
    chunk[5] === 0x02
  )
}

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
 * 拨号窗口暂存（pendingUplink）的 isolate 级总量（审计 L5）。
 *
 * retained 有 isolate 总预算，但拨号期间（writer 未就绪）的暂存原先只有单连接
 * 8MiB 上限、无总量闸门 —— 并发 20 条拨号连接各留 8MiB 就是 160MiB，顶穿 128MiB。
 * 这里给 pendingUplink 独立的 isolate 总量上限；drain 进 retained 时把额度从
 * 本计数转交给 retainedTotalBytes（retain 重新计入），两池不重复计数。
 */
const MAX_PENDING_TOTAL_BYTES = 32 * 1024 * 1024
/** 拨号暂存池只允许通过属性更新，避免增加模块级可变 let（作用域护栏测试）。 */
const pendingBudget = { bytes: 0 }

/** 拨号暂存池当前占用（诊断与回归测试用，只读） */
export function pendingBudgetBytes(): number {
  return pendingBudget.bytes
}

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

/**
 * isolate 级诊断计数（纯内存，绝不写 KV）。
 *
 * `/__diag` 的 `recent` 只记录异常路径，正常连接不进；
 * 这些计数器补上「重拨 / 护栏拦截 / 首包超时 / 下行让步」的发生次数，
 * 让故障切换在真机上可观测、可对比。
 */
const DIAG_COUNTERS = {
  stallRedials: 0,
  eofRedials: 0,
  /** 下行读取报错次数（区分「上游 Reset」与「正常 EOF」，见 pumpDown 的 catch） */
  downlinkReadErrors: 0,
  guardedRedials: 0,
  firstPacketTimeouts: 0,
  downlinkYields: 0,
}

/**
 * 计数器起点 —— **首次读取时惰性初始化**，不在模块顶层捕获。
 *
 * ⚠️ 真机实测（`/__diag`，2026-11-18）：workerd 在 isolate 初始化阶段
 * （模块顶层执行）的 `Date.now()` 会返回 **0**。早前写的是
 * `const DIAG_SINCE = Date.now()`，于是线上 `/__diag` 恒定显示
 * `since: 0`、`uptimeMs: <当前 epoch>` —— 看起来像「从 1970 年跑到现在」，
 * 完全失去「计数器是 1 分钟还是 10 小时累积」的诊断价值。
 * （本地 Node 直接 import 产物时模块顶层 `Date.now()` 正常，所以单测
 * 抓不到，只有真机能暴露 —— 与 close reason 那个坑同类。）
 *
 * 惰性初始化把取时机的动作挪到第一次 `/__diag` 请求里，此时一定处于
 * 请求上下文中，`Date.now()` 返回真实时间。
 *
 * 用属性而不是模块级 `let`：本文件的连接级状态作用域护栏
 * （`connection-state-scope.test.ts`）明确规定模块级 `let` 只允许 isolate
 * 配额计数器；这里同样是 isolate 级状态，沿用 `pendingBudget` 的对象写法。
 */
const diagClock = { since: 0 }

export function diagnosticCounters(): Readonly<typeof DIAG_COUNTERS> & { since: number; uptimeMs: number } {
  if (diagClock.since <= 0) diagClock.since = Date.now()
  return {
    ...DIAG_COUNTERS,
    since: diagClock.since,
    uptimeMs: Math.max(0, Date.now() - diagClock.since),
  }
}

/**
 * 每条会话的**收尾快照**（纯内存，绝不写 KV）。
 *
 * ## 为什么单独一份缓冲，而不是往 RECENT_DIAGNOSTICS 里塞
 *
 * `closeWith()` 是会话结束的唯一收口，但此前有十几条错误路径
 * （认证失败 / 握手超时 / UDP 拒绝 / 反代四终态 / 未预期内部异常）
 * 在 `closeWith` 之前**没有** `recordDiagnostics`，`/__diag recent` 完全看不到。
 * 若让 `closeWith` 统一往 `recent` 补记，又会挤占 20 条上限、把详细失败链顶掉。
 *
 * 因此这里独立记录**结构化收尾**：每条 close 一行、包含出口与计数，
 * 与 `recent`（详细失败链）互补。全部复用现有变量，不新增依赖。
 */
const RECENT_CLOSES: Array<{
  at: number
  code: number
  reason: string
  via: string
  endpoint: string
  dl: number
  ret: number
  rd: number
}> = []

export function recentCloses(): typeof RECENT_CLOSES {
  return RECENT_CLOSES
}

/**
 * 每条会话的**结构化收尾**（P2 #13，纯内存，绝不写 KV）。
 *
 * `/__diag` 此前只有 `recent`（详细失败链）与 `routes`（出口），两者没有
 * 关联 id，回答不了「刚才那条连接为什么 -1」。这里把协议类型、目标、
 * 出口、上下行字节、重拨次数、关闭码串成一行，全部复用现有变量。
 * 上限沿用 20 条环形缓冲。
 */
const RECENT_SESSIONS: Array<{
  at: number
  mode: string
  transport: 'ws'
  target: string
  via: string
  endpoint: string
  ulBytes: number
  dlBytes: number
  redials: number
  closeCode: number
  reason: string
}> = []

export function recentSessions(): typeof RECENT_SESSIONS {
  return RECENT_SESSIONS
}

function recordSession(entry: (typeof RECENT_SESSIONS)[number]): void {
  RECENT_SESSIONS.unshift(entry)
  if (RECENT_SESSIONS.length > RECENT_DIAGNOSTICS_LIMIT) {
    RECENT_SESSIONS.length = RECENT_DIAGNOSTICS_LIMIT
  }
}

function recordClose(
  code: number,
  reason: string,
  via: string,
  endpoint: string,
  dl: number,
  ret: number,
  rd: number
): void {
  RECENT_CLOSES.unshift({ at: Date.now(), code, reason, via, endpoint, dl, ret, rd })
  if (RECENT_CLOSES.length > RECENT_DIAGNOSTICS_LIMIT) {
    RECENT_CLOSES.length = RECENT_DIAGNOSTICS_LIMIT
  }
}

/**
 * 最近若干次出站的**实际落地路由**（纯内存，不写 KV）。
 *
 * `/__diag` 的 `recent` 只记异常路径，正常连接完全看不到走了哪条出口。
 * 判定表重建后需要一条能区分「直连 / 反代」的真机判据，这里补上：
 * `via` + `endpoint` + 目标是否落在 CF 网段 + 是否属于公共 DNS。
 * 端点与目标含用户访问信息，因此只在要求完整 UUID 的 `/__diag` 里返回。
 */
const RECENT_ROUTES: Array<{
  at: number
  target: string
  via: string
  endpoint: string
  cfTarget: boolean
  publicDns: boolean
  phase: 'initial' | 'redial'
}> = []

export function recentRoutes(): typeof RECENT_ROUTES {
  return RECENT_ROUTES
}

/** 从「host:port」标签里取 IP 部分；IPv6 字面量是「[v6]:port」或裸 v6，不能用 split(':')[0] */
function ipPartOf(targetLabel: string): string {
  const trimmed = targetLabel.trim()
  const bracket = trimmed.indexOf(']:')
  if (bracket >= 0) return trimmed.slice(1, bracket)
  const last = trimmed.lastIndexOf(':')
  return last > 0 ? trimmed.slice(0, last) : trimmed
}

function recordRoute(
  targetLabel: string,
  result: DialResult,
  phase: 'initial' | 'redial'
): void {
  RECENT_ROUTES.unshift({
    at: Date.now(),
    target: targetLabel,
    via: result.via,
    endpoint: result.endpoint,
    cfTarget: isCloudflareIpv4(ipPartOf(targetLabel)),
    publicDns: isPublicDnsIpv4(ipPartOf(targetLabel)),
    phase,
  })
  if (RECENT_ROUTES.length > 20) RECENT_ROUTES.length = 20
}

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

/**
 * WS 建立后等待**第一个字节**的上限。
 *
 * 与 `HANDSHAKE_DEADLINE_MS` 分层：后者只在「已收到字节但协议头不完整」时起，
 * 覆盖不了「连上之后一个字节都不发」的连接（扫描器 / 僵死客户端）。
 * 收到任意首字节即清除，established 之后绝不重启 —— 它不是空闲超时，
 * SSH / 远程桌面这类正常长连接不能被误关。
 */
const FIRST_PACKET_TIMEOUT_MS = 8000

interface WsTarget {
  command: number
  port: number
  hostname: string
  /** 协议头占用的字节数，其后即为负载 */
  headerLength: number
  /** 协议头明确不支持时的拒绝原因（version / command / flow），由 establish 立即关闭 */
  reject?: string
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
  /**
   * 0-RTT：early data 确实来自 `sec-websocket-protocol` 头时，101 响应
   * 要**原样回显**该头（Xray 服务端 `hub.go` 的行为）。对严格校验子协议的
   * 客户端/浏览器 dialer 是兼容性缺口（P2 #18）。普通客户端的非 early-data
   * 子协议头（如 `graphql-ws`）不回显 —— decodeEarlyData 返回空。
   */
  let earlyProtocolEcho: string | undefined
  {
    const raw = (request.headers.get('sec-websocket-protocol') ?? '').trim()
    if (raw && buffer.byteLength > 0) earlyProtocolEcho = raw || undefined
  }
  /**
   * 拨号 / 换出站期间暂存的上行**分块**（协议头之后、writer 就绪之前到达的帧）。
   *
   * ⚠️ 必须是分块数组，不能「每帧 concatBytes 到一块」：
   * `concatBytes` 每次都会新分配「旧长度 + 新长度」并整段复制，逐帧拼接就是 O(n²)。
   * 实测（16 KiB/帧，本机）：1 MiB → 12.9 ms、2 MiB → 56.7 ms、8 MiB → 668 ms。
   * 免费版单请求 CPU 只有 10 ms —— 客户端在拨号窗口里传 1 MB 就会被判超限，
   * 表现为连接莫名其妙地断（客户端只看到 -1）。
   *
   * 合并推迟到真正写入时（见 `drainPendingUplink`），复杂度回到线性。
   */
  let pendingUplink: Uint8Array[] = []
  let pendingUplinkBytes = 0
  let established = false
  let dialed: DialResult | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  /**
   * 上行写入串行链（见 `uplink-queue.ts`）。
   *
   * 常规路径的写入本身按调用顺序入队，但**换出站**时「重放 + 补写缓存」
   * 与「切换期间新到的帧」会互相插队 —— 必须全部走同一条链。
   */
  const uplink = new UplinkQueue({
    // 队列只保证顺序，不保证容量：目标站读得慢时客户端仍在灌帧，
    // 单连接积压超过上限说明对端已经不读 —— 主动断开让客户端重连。
    onOverflow: () => closeWith(1009, '上行积压过多（目标侧不读）'),
  })
  /** 握手截止定时器（**唯一一个**：绝不在每帧里新建） */
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** 首包等待定时器（WS 建立后零字节时关闭连接） */
  let firstPacketTimer: ReturnType<typeof setTimeout> | null = null
  const clearFirstPacketTimer = (): void => {
    if (firstPacketTimer) {
      clearTimeout(firstPacketTimer)
      firstPacketTimer = null
    }
  }
  /**
   * 重拨流程是否**正在执行**（不是「这条会话是否已经重拨过」）。
   *
   * ⚠️ 语义修正（2026-11-15）：此前这是「一次性闩锁」——置 true 后从不复位，
   * 于是第二个假活反代触发的 stall / EOF 会被入口直接 return，旧泵的
   * reader.read() 挂在假活连接上、stallTimer 已置 null、首包/握手定时器早已清掉，
   * 会话**永久静默挂起**直到客户端自己超时（真机表现为一直转圈）。
   * 现在每轮重拨流程结束时都会复位（见 redialViaRelay 的 finally），
   * 让「假活 → 换下一个入口」可以链式推进；入口的 `if (redialStarted) return`
   * 仍负责挡住 stall 与 EOF 的并发重入。
   */
  let redialStarted = false
  /** 下行主动让步节流器（不依赖运行时不存在的 bufferedAmount） */
  const downlinkPacer = new DownlinkPacer()
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
  /** 该目标域名命中的出站策略（P2 #12，与 pinnedHosts 共用字段） */
  let hostPolicy: HostPolicy | undefined

  /**
   * 本次会话的下行静默判定窗口。
   * 按域名策略 > 配置层默认值；重拨后的确认窗口取一半（下限 400ms）。
   */
  const effectiveStallMs = (confirm: boolean): number => {
    const base = hostPolicy?.stallMs ?? config.dialStallMs
    return confirm ? Math.max(400, Math.round(base / 2)) : base
  }

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
    // 幂等：客户端断开 / 读错误 / 拨号超时 / 正常结束可能抢着收尾。
    if (closed) return
    closed = true

    // 错误关闭：把「失败时走了哪条出口」**前置**到 close reason 开头。
    // truncateCloseReason 按字节从前往后截 123 字节，前缀必然存活；
    // 客户端/抓包因此能区分「直连失败」与「反代失败」。
    //
    // ⚠️ 前缀只放 via / ep 两项（约 30 字节）—— dl/ret/rd 等计数放进
    // RECENT_CLOSES 的结构化字段里。前缀若照搬正常收尾的完整格式串，
    // 会把中文失败原因挤出 123 字节，反而丢掉最有用的信息。
    // 正常收尾（code 1000）保持原有 `done via=...` 原文，不改客户端可见语义。
    const used = dialed
    const errorPrefix = code >= 1008 && used ? `via=${used.via} ep=${used.endpoint} ` : ''
    recordClose(
      code,
      reason,
      used?.via ?? '',
      used?.endpoint ?? '',
      downlinkBytes,
      retainedBytes,
      relayRedialCount
    )
    recordSession({
      at: Date.now(),
      mode,
      transport: 'ws',
      target: target ? `${target.hostname}:${target.port}` : '',
      via: used?.via ?? '',
      endpoint: used?.endpoint ?? '',
      ulBytes: sessionUlBytes,
      dlBytes: downlinkBytes,
      redials: relayRedialCount,
      closeCode: code,
      reason,
    })
    try {
      server.close(code, truncateCloseReason(errorPrefix + reason))
    } catch {
      /* 已关闭 */
    }
    cleanup()
  }

  /**
   * 静默关闭一条出站结果（幂等、绝不外抛）。
   *
   * 优先 `DialResult.close()`：它会同时关读写两端并立即释放并发连接槽位；
   * 只有写端时退回 `writable.close()`（对 sockets 来说同样会关掉整条连接）。
   * 调用方负责保证「这条连接不该再被使用」。
   */
  const closeDialResult = (result: DialResult): void => {
    try {
      const close = result.close
      void Promise.resolve(close ? close() : result.writable.close()).catch(() => {})
    } catch {
      /* 已关闭 */
    }
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
    // 归还拨号暂存的 isolate 额度（审计 L5），再清空缓冲。
    pendingBudget.bytes = Math.max(0, pendingBudget.bytes - pendingUplinkBytes)
    pendingUplink = []
    pendingUplinkBytes = 0
    clearFirstPacketTimer()
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
    // DNS-over-DoH 会话：断开后必须中止在飞查询，否则后台继续吃子请求配额
    udpSession?.close()
    if (dialed) closeDialResult(dialed)
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

  /** 反代重拨**轮数**（stall/EOF 触发的次数；用于诊断的 rd 字段） */
  let relayRedialCount = 0

  /**
   * 本会话累计尝试过的**反代入口个数**。
   *
   * `config.relayRedialMax` 约束的是入口数，不是轮数：一轮里若前几个入口
   * connect 直接失败会继续试下一个，而「connect 成功但零下行」的假活
   * 入口会 return 启动新泵、由下一轮接着换。两种形态都在这里计数，
   * 达到上限就明确 close 1011，绝不静默挂起。
   */
  let relayEndpointsTried = 0

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

  const retain = (bytes: Uint8Array): boolean => {
    if (bytes.byteLength === 0 || downlinkBytes > 0) return true // 通路已确认，无需留存
    if (retainedBytes + bytes.byteLength > MAX_RELAY_BUFFER_BYTES) {
      closeWith(1009, '未确认通路的上行数据过多')
      return false
    }
    // 单连接上限之外还要看 isolate 总预算：并发连接各留几 MB 就能把内存吃穿
    if (retainedTotalBytes + bytes.byteLength > MAX_RETAINED_TOTAL_BYTES) {
      closeWith(1009, '实例内存预算已满，请重试')
      return false
    }
    retained.push(bytes)
    retainedBytes += bytes.byteLength
    retainedTotalBytes += bytes.byteLength
    return true
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

  /**
   * 下行：出站 → 客户端。
   *
   * @param stallMs 静默判定窗口。首次建连用 `config.dialStallMs`（默认 2.5s）；
   *   假活重拨后换上的新入口用其一半（下限 400ms）——
   *   那是「已知上一个入口假活」后的确认，没必要再等满 2.5s，
   *   否则 4 轮换入口会累积到 10s+，超过多数客户端的网络超时。
   */
  const pumpDown = async (stallMs: number = effectiveStallMs(false)): Promise<void> => {
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
      // 一个字节都没收到：交给统一重拨入口做护栏判定与诊断。
      // 静默定时器与秒级 EOF 两条触发路径必须共用同一套护栏，否则会漏。
      //
      // 重拨流程进行中（redialStarted=true）时这次事件会被入口挡下 ——
      // 这是**预期**的：那一轮正在拨新入口，新入口成功后会启动带
      // 短确认窗口的新泵，由新泵的下行确认决定是否继续换。
      // redialStarted 现在会在每轮流程结束时复位（见 redialViaRelay 的 finally），
      // 因此不会再出现「第二次假活永远挂在旧泵上、无任何定时器」的死锁。
      void redialViaRelay('stall')
    }, stallMs)
    stallTimer = stall

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          const firstByte = downlinkBytes === 0
          // 反代首包直接回 TLS Fatal Alert（如 7 字节 alert 40/80/112）：
          // 说明该反代入口自身无法按此 SNI 转发，绝不能当成「通路确认」发给客户端 ——
          // 必须保留 retained 缓冲、熔断该坏反代，并在剩余重拨配额内立即切换下一个入口。
          if (
            firstByte &&
            dialed?.isRelay &&
            retainedBytes > 0 &&
            isTlsFatalAlert(value) &&
            relayRedialCount < config.relayRedialMax &&
            !redialStarted
          ) {
            if (target?.hostname && dialed.endpoint) {
              penalizeRelayEndpoint(target.hostname, dialed.endpoint, true)
            }
            void redialViaRelay('alert')
            return
          }
          downlinkBytes += value.byteLength
          if (firstByte) {
            clearRetained() // 通路确认，释放重放留存
            if (dialed?.isRelay && target?.hostname && dialed.endpoint) {
              confirmRelaySuccess(target.hostname, dialed.endpoint)
            }
          }
          // 流量熔断：超限立即结束，不再把这块数据发给客户端
          if (traffic.add(value.byteLength)) {
            cutByTraffic()
            return
          }
          // 平台不提供 bufferedAmount / drain，无法做响应式背压；
          // 按累计字节周期性让出一次事件循环（见 DownlinkPacer）。
          const beforeYields = downlinkPacer.yieldCount
          await downlinkPacer.onChunk(value.byteLength)
          if (downlinkPacer.yieldCount > beforeYields) DIAG_COUNTERS.downlinkYields++
          send(value)
        }
      }
    } catch (err) {
      // 传输错误：留痕（原因会进 close reason 与 /__diag 计数器）
      downReadError = err
      DIAG_COUNTERS.downlinkReadErrors++
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
      if (generation !== pumpGeneration || closed) return
      // 上游秒级 EOF / Reset：已发过上行却一个字节都没回，静默窗口
      // 根本没到就结束了。此时不能按正常结束收尸（close 1000 done），
      // 否则反代重拨永远没机会触发 —— 真机采样里 6 个目标有 2 个命中这条。
      //
      // `!redialStarted` 在这里是**防并发**而非一次性闩锁：重拨流程进行中
      // 时旧泵的 finally 会走到这里，必须让位给那一轮；流程结束后
      // redialStarted 已复位，新泵若再秒级 EOF 会在这里正常触发下一轮。
      if (
        downlinkBytes === 0 &&
        retainedBytes > 0 &&
        relayRedialCount < config.relayRedialMax &&
        !redialStarted
      ) {
        void redialViaRelay('eof')
        return
      }
      // 把实际出口写进 close reason。
      //
      // `/__diag` 的 routes / counters 都是 isolate 级，跨请求可能落在别的
      // isolate 上读不到；而 close frame 客户端每次都能收到。判定表重建后
      // 「这条连接到底走了直连还是反代」需要一个可靠的真机判据，这里就是。
      // reason 会被统一截断到 123 字节，超长不会丢掉整个 close frame。
      const used = dialed
      // `dl/ret/rd`：下行字节 / 未确认留存 / 重拨次数，定位「零下行直接 done」时区分
      // 「上行没发出去」与「发了但目标没回」。
      // `err=`：下行读错误。只在零下行时前置（有下行时说明通路已确认，
      // 末尾的错误不该挤掉 via/ep 这两项判据）。
      const readErr =
        downReadError && downlinkBytes === 0
          ? ` err=${truncate(String(downReadError), 40)}`
          : ''
      closeWith(
        1000,
        used
          ? `done${readErr} via=${used.via} ep=${used.endpoint} dl=${downlinkBytes} ret=${retainedBytes} rd=${relayRedialCount}`
          : `done${readErr}`
      )
    }
  }

  /** 已收到的下行字节数（用于静默检测） */
  let downlinkBytes = 0
  /**
   * 下行读取的异常（上游 Reset / 连接被重置）。
   *
   * 早前 `catch { 传输错误 }` 把它整个吞掉，正常收尾仍按
   * `close 1000 done` —— 客户端与 /__diag 都分不清「目标站正常结束」
   * 与「上游连接被重置」，自动重连与故障定位都缺判据。
   */
  let downReadError: unknown = null
  /** 本会话累计上行字节（供 /__diag 的结构化会话快照；TrafficMeter 在无限额时不计数） */
  let sessionUlBytes = 0

  /**
   * 单连接流量计量（上下行合计）。
   *
   * 上限来自配置 `dataBudgetMB`，**默认 512MB**；显式设为 0 才表示不限制。
   * 数据面本身不会被「跑太久」杀掉，但每条中继连接都在持续消耗 CPU 配额，
   * 单条超大流量连接能把账号当日额度吃穿，之后所有请求一起 503。
   * 超限时主动断连让客户端重连（CPU 随新 invocation 归零），比整账号被限流划算。
   */
  const traffic = new TrafficMeter((config.dataBudgetMB || 0) * 1024 * 1024)

  /**
   * 流量超限：记诊断 + 关闭连接。
   *
   * 用 **1013（Try Again Later）** 而不是 1009：1009 的语义是「消息过大」，
   * 客户端会当成协议错误、可能直接报错停用该节点；1013 明确表达
   * 「现在不行，稍后重连」——支持断点续传的客户端据此续传，
   * 而不是把节点判死。内存类熔断（缓冲/积压）仍用 1009，那是真的帧太大。
   */
  const cutByTraffic = (): void => {
    const reason = `单连接流量超过 ${config.dataBudgetMB}MB 上限`
    recordDiagnostics(
      target ? `${target.hostname}:${target.port}` : '未建立出站',
      [],
      reason
    )
    closeWith(1013, reason)
  }

  /** 上行：客户端 → 出站（经串行链，顺序 = 调用顺序） */
  const pumpUp = async (bytes: Uint8Array): Promise<void> => {
    const sink = writer
    if (!sink) return
    try {
      // 执行时若 writer 已被换掉（反代重拨），就跳过这一段：
      // 重拨只在「下行未收到任何字节」时发生，此时 `retained` 包含上述全部字节，
      // 新连接会整体重放它们 —— 再写一遍就是重复发送。
      await uplink.write(() => (writer === sink ? sink : null), bytes)
    } catch (err) {
      // ⚠️ 写失败必须留痕：此前这里只 cleanup()，`/__diag` 看不到任何记录，
      // 真机上表现为「close 1000 done + 0 字节下行」，看起来像目标站没响应，
      // 实际上是我们自己的出站写入被拒绝（对端已关闭 / 流已 errored）。
      recordDiagnostics(
        target ? `${target.hostname}:${target.port}` : '未建立出站',
        [],
        `上行写入失败：${String(err)}`
      )
      cleanup()
    }
  }

  /**
   * 把「拨号 / 反代重拨期间」暂存的上行补写到指定出站。
   *
   * ## 为什么必须有
   *
   * `writer` 在反代重拨时会被置空，客户端在此期间继续发的帧只能落进
   * `pendingUplink`（message 处理器里 `if (!writer)` 那一支）。重拨成功后若不补写，
   * 这些字节会**永远留在暂存区里**：出站再也收不到它们，
   * 客户端等不到响应，表现为「切换反代之后隧道静默挂起，直到超时变 -1」。
   *
   * ## 为什么只能在串行链内部调用
   *
   * 本函数是「重放 + 补写」那个队列任务的一部分，直接写传入的 writer 而不走
   * `pumpUp`：再入队会排到自己后面，`await` 就永远等不到（自死锁）。
   *
   * 补写前先 `retain` —— 新通路同样可能是假活（见 `retained` 注释），
   * 重放数据必须完整，不能只重放首次建连前的那些。
   */
  const drainPendingUplink = async (
    target: WritableStreamDefaultWriter<Uint8Array>
  ): Promise<void> => {
    if (pendingUplink.length === 0) return
    // 先摘链再写：写入期间新到的帧会看到 `writer` 已就绪而走 `pumpUp`，
    // 排在本任务之后（顺序由 `UplinkQueue` 保证），不会被本次循环再写一遍。
    const pending = pendingUplink
    const totalBytes = pendingUplinkBytes
    pendingUplink = []
    pendingUplinkBytes = 0
    // ⚠️ isolate 额度**一次性**归还，不能逐块还：
    // 逐块还时只要循环在中途抛错（`retain` 超限已 close、`target.write` 被对端重置），
    // 后面没遍历到的分块字节就永远留在 `pendingBudget.bytes` 里 ——
    // `cleanup()` 扣的是已经清零的 `pendingUplinkBytes`，补不回来。
    // 攒到 32 MiB 后本 isolate 所有新连接在拨号期间收数据都会被 1009 拒掉。
    pendingBudget.bytes = Math.max(0, pendingBudget.bytes - totalBytes)
    for (const chunk of pending) {
      // 已关闭就别再写了：`retain` 失败会触发 closeWith，继续写只会制造一次注定失败的写入。
      if (closed) return
      // 额度从「拨号暂存池」转交给「留存池」（retain 重新计入 retainedTotalBytes），
      // 两池不重复计数（审计 L5）；留存由 cleanup 的 clearRetained 兜底归还。
      if (!retain(chunk)) return
      await target.write(chunk)
    }
  }

  /** 解析协议头 */
  const parseTarget = (bytes: Uint8Array): WsTarget | null => {
    if (mode === 'vless') {
      const parsed = parseVlessBuffer(bytes, config.uuid)
      if (!parsed) return null
      // 明确拒绝「版本 / Mux / flow 不支持」的客户端，而不是继续攒包到超时、
      // 或把 smux 首字节当 addressType 解析出一个畸形目标。
      const reject = validateVlessHeader(parsed.header)
      return {
        command: parsed.header.command,
        port: parsed.header.port,
        hostname: parsed.header.hostname,
        headerLength: parsed.consumed,
        ...(reject ? { reject } : {}),
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

  /**
   * 协议头已够判凭据、但凭据不匹配 —— 应立即关闭，而不是等握手截止。
   *
   * 早前 `parseXxxBuffer` 对「半包」与「认证失败」都返回 null，
   * 这里误当成半包：启动 2 秒截止定时器，期间还允许对端继续灌最多 64KB
   * （扫描器与错误 UUID 客户端白占资源）。
   */
  const credentialMismatch = (bytes: Uint8Array): boolean =>
    mode === 'vless'
      ? vlessAuthFailed(bytes, config.uuid)
      : trojanAuthFailed(bytes, config.trojanPassword)

  const establish = async (): Promise<void> => {
    if (closed || established) return
    const parsed = parseTarget(buffer)
    if (!parsed) {
      if (credentialMismatch(buffer)) {
        recordDiagnostics('', [], '认证失败：凭据不匹配（立即关闭，不等握手截止）')
        closeWith(1008, '认证失败或协议头非法')
        return
      }
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
    clearFirstPacketTimer()
    if (established) return
    established = true
    // 同步到外层作用域：反代重拨（redialViaRelay）需要它做诊断记录
    target = parsed
    // 按目标域名的出站策略（stall 窗口 / 禁止假活重拨）与固定落地映射
    // 共用 pinnedHosts 字段，解析器对两种值形态分池处理
    hostPolicy = config.pinnedHosts ? hostPolicyFor(config.pinnedHosts, parsed.hostname) : undefined

    if (parsed.reject) {
      // 协议头校验不通过：立即明确关闭并留痕，不要拖到握手截止定时器。
      recordDiagnostics(`${parsed.hostname}:${parsed.port}`, [], `协议头拒绝：${parsed.reject}`)
      closeWith(1011, parsed.reject)
      return
    }

    // UDP：Workers 没有 UDP socket，只有 **DNS/53** 能靠 DoH 打通。
    //
    // 判定顺序很重要：
    //   1. 开关打开 + VLESS + 端口 53 → 走 DoH（先回协议响应头，与 TCP 一致）
    //   2. 其余一律明确拒绝，并在 reason 里写清「只支持 DNS」——
    //      客户端把它显示在日志里，比一句「暂不支持」有用得多
    const udpCommand = mode === 'vless' ? VLESS_COMMAND_UDP : TROJAN_COMMAND_UDP
    if (parsed.command === udpCommand) {
      // Trojan 的 UDP 帧格式（ATYP+ADDR+PORT+LEN+DATA）与 VLESS 不同，
      // DnsUdpSession 只有 VLESS 帧 framer —— 故 Trojan 仍不支持 UDP（P2 #17 评估后维持原状）。
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
      // DialOptions 统一由工厂装配（P1 #9）：时序参数来自配置层，
      // 4 个入站调用点不再各写一套。onFailure 是本路径特有的诊断收集。
      dialed = await dial(
        buildDialOptions(
          config,
          { hostname: parsed.hostname, port: parsed.port },
          proxies,
          {
            onFailure: (failure) => {
              failures.push(failure)
              diagnostics?.failures.push(failure)
            },
          }
        )
      )
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

    // ⚠️ 拨号期间客户端可能已经断开（`onClose` 会置 `closed` 并 cleanup）。
    // 这时刚建好的 Socket 既没有归属也没有关闭者，必须在这里丢掉 ——
    // 否则它会一直占着「单请求 6 条并发出站」里的一个槽位等到运行时超时。
    if (closed) {
      closeDialResult(dialed)
      recordDiagnostics(`${parsed.hostname}:${parsed.port}`, [], '入站已关闭，丢弃拨号结果')
      return
    }

    const establishedWriter = dialed.writable.getWriter()
    writer = establishedWriter
    recordRoute(`${parsed.hostname}:${parsed.port}`, dialed, 'initial')

    // 通用做法：把协议头之后已收到的数据补写。
    //
    // 首帧的负载仍在 `buffer` 里（协议头与它是连续字节，≤ `MAX_HEADER_BYTES`）；
    // 拨号期间到达的后续帧在 `pendingUplink` 里（见 message 处理器的 `if (!writer)` 分支）。
    //
    // ⚠️ 「首包 + 暂存帧」必须写在**同一个串行任务**里：拆成两次排队时，
    // 两者之间到达的新帧会插到暂存帧前面，TLS 分片一换序就是 bad_record_mac。
    //
    // 用 slice 而不是 subarray：subarray 与 `buffer` 共享底层 ArrayBuffer，
    // 留存期间整块（最多 64KB 握手缓冲）都无法回收；这里只复制负载本身。
    const payload =
      buffer.byteLength > parsed.headerLength ? buffer.slice(parsed.headerLength) : new Uint8Array(0)
    buffer = new Uint8Array(0)
    try {
      await uplink.run(async () => {
        if (payload.byteLength > 0) {
          // 先留存再写：直连可能假活，首字节确认前上行必须可重放
          if (!retain(payload)) return
          await establishedWriter.write(payload)
        }
        await drainPendingUplink(establishedWriter)
      })
    } catch (err) {
      // 与 `pumpUp` 一致：写失败视为出站不可用，交给清理 + 下行泵走重拨判定。
      // 同样必须留痕（否则真机上只看到 close 1000 + 0 字节，无法与「目标站不回数据」区分）。
      recordDiagnostics(
        `${parsed.hostname}:${parsed.port}`,
        [],
        `上行首包写入失败：${String(err)}`
      )
      cleanup()
    }

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
  const redialViaRelay = async (trigger: 'stall' | 'eof' | 'alert'): Promise<void> => {
    // 幂等：静默定时器与 EOF 分支可能几乎同时命中，只允许一个重放流程在跑。
    // ⚠️ 这不是「一次性闩锁」：流程结束会在 finally 里复位，允许下一轮
    // 在「新入口也假活」时接着换入口。旧实现置 true 后永不复位，
    // 导致第二个假活反代永久静默挂起（本次修复的核心）。
    if (closed || redialStarted) return
    // target 理论上一定已解析（本函数只在 establish 成功后触发），
    // 这里仍做空判断，避免未来重构把调用点提前。
    const targetInfo = target
    if (!targetInfo) {
      closeWith(1011, '出站无数据：目标未解析')
      return
    }
    // P2 #12：该域名显式禁止假活重拨（例如「只走用户指定出口」、
    // 或重拨会重复提交非幂等请求）—— 直接明确失败，绝不静默切出口。
    if (hostPolicy?.noRedial) {
      recordDiagnostics(
        `${targetInfo.hostname}:${targetInfo.port}`,
        [],
        '按域名策略禁止假活重拨（noredial）'
      )
      closeWith(1011, '出站无数据：该域名已禁止自动切换反代入口')
      return
    }
    // 当前这条失败连接若是反代入口，立刻从成功记忆清除并拉入熔断冷却，
    // 防止下一条并发连接继续命中同一个坏反代（即便已到本次重拨上限也要记账）。
    if (dialed?.isRelay && dialed.endpoint) {
      penalizeRelayEndpoint(targetInfo.hostname, dialed.endpoint, true)
    }
    if (relayEndpointsTried >= config.relayRedialMax) {
      // 反代入口也试够了，仍然假活 —— 明确告知客户端，不要静默挂起
      closeWith(1011, '出站无数据：直连与反代入口均无响应')
      return
    }
    redialStarted = true
    // 下面的主体保持原有缩进（最小 diff）；try 只负责在**所有**退出路径
    // 复位 redialStarted，避免漏掉任何一条 return。
    try {

    // 统一护栏：读的是**旧连接**的出口类型（此时 dialed 还没被覆盖）。
    // 用户显式指定出口时，静默切到内置反代会绕过它且没有任何报错。
    const verdict = canSwitchToBuiltinRelay({
      via: dialed?.via,
      port: targetInfo.port,
      userProxyConfigured: proxies.length > 0 || Boolean(config.proxyIp),
      aggressive: config.aggressiveRedial === true,
    })
    if (!verdict.allowed) {
      DIAG_COUNTERS.guardedRedials++
      recordDiagnostics(
        `${targetInfo.hostname}:${targetInfo.port}`,
        [],
        `出站无数据：${verdict.reason}；未切换反代（可开启 aggressiveRedial）`
      )
      closeWith(1011, `出站无数据：${verdict.reason}`)
      return
    }

    relayRedialCount++
    if (trigger === 'stall') DIAG_COUNTERS.stallRedials++
    else DIAG_COUNTERS.eofRedials++
    recordDiagnostics(
      `${targetInfo.hostname}:${targetInfo.port}`,
      [],
      trigger === 'stall'
        ? '下行静默无数据，改走反代入口'
        : trigger === 'alert'
          ? '反代入口返回 TLS 致命告警，立即切换下一个反代入口'
          : '出站零下行即 EOF/Reset，立即改走反代入口'
    )

    // 收反代入口候选：用户自配优先，其次内置表（按表顺序取前 N 个）
    let endpoints: RelayEndpoint[] = []
    try {
      endpoints = await collectRelayEndpoints({
        userEntries: config.relayPool || undefined,
        useBuiltin: config.useBuiltinRelay,
      })
    } catch {
      endpoints = []
    }
    // 当前这条假活连接若本身就是反代入口，先记入已试集合，避免重拨时原地重试。
    if (dialed?.endpoint) triedRelays.add(dialed.endpoint)
    // 过滤已试过的，再按健康记忆排序（把已被冷却的坏反代压到末尾）
    const fresh = sortByEndpointHealth(
      endpoints.filter((e) => !triedRelays.has(`${e.ip}:${e.port}`)),
      (e) => endpointKey('relay', e.ip, e.port),
      Date.now()
    )
    if (fresh.length === 0) {
      closeWith(1011, '出站无数据：无反代入口可用')
      return
    }

    // 本轮最多再试到总上限。
    // 「connect 成功但零下行」的假活入口会 return 启动新泵，由新泵的
    // 短静默窗口触发下一轮（triedRelays 已去重，会挑下一个入口）；
    // 「connect 直接失败」的入口则在本轮循环里继续试下一个。
    const remaining = Math.max(1, config.relayRedialMax - relayEndpointsTried)
    for (const endpoint of fresh.slice(0, remaining)) {
      relayEndpointsTried++
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
        // 重拨连的是**反代入口 IP**，不是目标域名：关掉 DoH / 目标地址策略 /
        // 固定映射 / 反代池，避免把入口 IP 当成目标站再解析一遍。
        const socket = await dial(
          buildDialOptions(
            config,
            { hostname: endpoint.ip, port: endpoint.port },
            config.aggressiveRedial ? proxies : [],
            {
              timeoutMs: Math.min(config.dialConnectMs, REDIAL_DIAL_TIMEOUT_MS),
              resolvePreferred: false,
              skipTargetPolicy: true,
              proxyMode: config.aggressiveRedial ? config.proxyMode : undefined,
              relayPool: undefined,
              pinnedIps: undefined,
              pinnedRelays: undefined,
            }
          )
        )
        if (!socket) continue
        // 标记为反代连接：这样若它继续假活或回 TLS Fatal Alert，下一轮重拨才会熔断它
        socket.isRelay = true
        // 拨号期间客户端已断开：这条入口的 Socket 也不能留（同 establish 的收口）。
        if (closed) {
          closeDialResult(socket)
          return
        }

        dialed = socket
        recordRoute(`${targetInfo.hostname}:${targetInfo.port}`, socket, 'redial')
        const nextWriter = socket.writable.getWriter()

        // 反代是「按 SNI 转发」的第三方服务器。
        //
        // ⚠️ VLESS over WS 是 TLS 透传（铁律12）：Worker 不终结出站 TLS，
        // 客户端与目标站直接完成 TLS。所以反代收到的就是客户端的原始
        // ClientHello（SNI = 目标站）—— 无需 Worker 做任何改写，直通即可。
        //
        // 重放首字节确认前的全部上行（TLS ClientHello / HTTP 首包等）。
        // ⚠️ 不在这里清空 —— 要等新通路的下行首字节确认后再释放（pumpDown）；
        // 多个反代入口依次尝试时，每个都能拿到完整的重放数据。
        let replayBytes = 0
        for (const chunk of retained) replayBytes += chunk.byteLength
        const replay = new Uint8Array(replayBytes)
        let replayOffset = 0
        for (const chunk of retained) {
          replay.set(chunk, replayOffset)
          replayOffset += chunk.byteLength
        }

        // ⚠️ 重放与补写必须**在同一个队列任务里**完成，且 `writer` 要**推迟到
        // 重放完成后**才对外开放：
        //
        // 早前实现在 `uplink.run` 之前就 `writer = nextWriter`。于是重放写挂起的那段
        // 微任务窗口里到达的新帧会看到 writer 非空 → 先 `retain`、再排进队列；
        // 而随后 `drainPendingUplink` 又把**重拨期间**积压的旧帧追加到 retained 末尾。
        // retained 的字节顺序变成「首包, 新帧, 旧帧」—— 这条入口若也假活、进入
        // 下一轮重拨，重放给下一个入口的 TLS 密文流顺序彻底错乱（bad_record_mac）。
        //
        // 现在：重放 + 补写全部完成后才开放 writer，期间到达的新帧继续进
        // `pendingUplink`；开放后再补一次 drain，覆盖「补写期间新到」的尾部帧。
        await uplink.run(async () => {
          if (replay.byteLength > 0) await nextWriter.write(replay)
          // 重拨期间客户端继续发的帧暂存在 `pendingUplink` 里 —— 这里补写，
          // 否则它们会一直留在暂存区等待一个永远不会到来的 establish。
          await drainPendingUplink(nextWriter)
          if (closed) return
          writer = nextWriter
          // 补写期间可能又有新帧进了暂存区（它们比「开放 writer 后排队」的帧更早到达）
          await drainPendingUplink(nextWriter)
        })
        // 重放期间客户端断开：Socket 已由 cleanup 关闭，不再起新泵。
        if (closed) return

        recordDiagnostics(
          `${targetInfo.hostname}:${targetInfo.port}`,
          [],
          `已切换反代入口 ${endpoint.ip}:${endpoint.port}`
        )
        // 重新启动下行泵：重拨后的入口用**更短的确认窗口**。
        // 若这个入口也假活，1.2s 后的 stall 会再次进入本函数
        // （redialStarted 已由 finally 复位），由 triedRelays 挑下一个未试入口，
        // 形成「假活 → 换入口」的链式推进，最多 config.relayRedialMax 个入口。
        ctx?.waitUntil(pumpDown(effectiveStallMs(true)))
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

    // 本轮所有可试入口都 connect 失败（没有一条能启动新泵）——
    // 明确关闭，绝不留一个没有定时器的会话在那里静默挂起。
    closeWith(1011, '出站无数据：所有反代入口均失败')
    } finally {
      // ⚠️ 核心修复：复位「重拨进行中」标志。
      // 旧实现置 true 后永不复位，第二个假活反代的 stall/EOF 会在入口被
      // return；旧泵的 reader.read() 挂在假活连接上，stallTimer 已 null、
      // 首包/握手定时器早已清掉 —— 会话永久静默挂起（真机一直转圈）。
      // 复位后，新泵自己的 stall 能正常驱动下一轮换入口。
      redialStarted = false
    }
  }

  /**
   * 一条入站消息的完整处理（**只做同步状态变更**，异步工作放到链外）。
   *
   * ## 为什么要归一化「在链内」完成
   *
   * 早前每条 message 都各自起一个 async IIFE：`Blob` 分支要先 `await
   * arrayBuffer()`，而 `ArrayBuffer` 分支不 await —— 两类消息混发时，
   * 后到的 ArrayBuffer 帧可能先完成归一化，字节顺序就乱了
   * （TLS 分片换序 = bad_record_mac）。这里把「归一化 + 状态变更」放进
   * 严格顺序链，异步工作（拨号 / 写入）**不 await**，避免把它们的长延迟
   * 串进后续帧的处理顺序。
   */
  let inboundChain: Promise<void> = Promise.resolve()

  const handleMessage = async (data: unknown): Promise<void> => {
    // ⚠️ 不能再直接 `new Uint8Array(data as ArrayBuffer)`：CF 运行时下
    // event.data 也可能是 Blob，那样会得到长度 0 的视图、每条消息被
    // 静默丢弃（101 成功但隧道全 -1）。复用 stream.ts 的四分支归一化。
    const normalized = normalizeWsMessage(data)
    const bytes = normalized instanceof Promise ? await normalized : normalized
    if (!bytes || bytes.byteLength === 0) return
    // 收到任意首字节即解除首包等待；established 之后不再重启这个定时器
    clearFirstPacketTimer()

    // 数据面流量熔断：上下行都计量，超限即断（0 = 不限制）
    sessionUlBytes += bytes.byteLength
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
      // 不 await：拨号可能要好几秒，等它会把后续帧堵在顺序链里
      void establish().catch((err) => closeWith(1011, String(err)))
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
    // 处理方式：按帧暂存（**不拼接**），writer 就绪后与首包一起补写。
    // ⚠️ 不能写成 `concatBytes(buffer, bytes)`：那会把已有全部字节每帧重拷一遍，
    // 是 O(n²)，拨号窗口里传 1 MB 就会撞穿 10 ms CPU 预算（见 `pendingUplink` 注释）。
    if (!writer) {
      // isolate 级总预算（审计 L5）：并发拨号连接各留几 MiB 就能把内存吃穿。
      if (pendingBudget.bytes + bytes.byteLength > MAX_PENDING_TOTAL_BYTES) {
        closeWith(1009, '实例内存预算已满，请重试')
        return
      }
      pendingUplink.push(bytes)
      pendingUplinkBytes += bytes.byteLength
      pendingBudget.bytes += bytes.byteLength
      // 兜底防内存膨胀：拨号期间暂存上限（协议头之后就是负载，允许较大值）
      if (pendingUplinkBytes > MAX_RELAY_BUFFER_BYTES) {
        closeWith(1009, '拨号期间数据过多')
        return
      }
      return
    }
    // 首字节确认前的上行留存（假活时反代重拨要重放，见 retain 注释）。
    // retain 返回 false 表示已超预算并 closeWith，此时不能再写入（流已关）。
    if (!retain(bytes)) return
    // 写入由 UplinkQueue 串行化，不在这里 await（顺序由队列保证，块内的
    // 长写入不应阻塞后续帧的接收与留存）
    void pumpUp(bytes)
  }

  server.addEventListener('message', (event: MessageEvent) => {
    inboundChain = inboundChain
      .then(() => handleMessage(event.data))
      .catch(() => {
        /* 单条消息的错误不打断整条链 */
      })
  })

  /**
   * 客户端断开 / 传输错误。
   *
   * ⚠️ 必须**先**置终止状态再清理：`cleanup()` 只会关掉当时已存在的 `dialed`，
   * 而 `establish()` 可能正 `await dial()`。不置 `closed` 的话，拨号稍后成功时
   * 那条 `if (closed)` 判定看不到「客户端已经走了」，仍会建 writer、起泵，
   * 留下一条无人持有也无人关闭的出站连接，直到运行时超时才释放槽位。
   */
  const onClose = (): void => {
    closed = true
    cleanup()
  }
  server.addEventListener('close', onClose)
  server.addEventListener('error', onClose)

  // 0-RTT：early data 里可能已是完整协议头，主动触发 establish ——
  // 客户端在收到下行前不会再发帧，不主动触发会白等到超时。
  if (buffer.byteLength > 0) {
    void establish().catch((err) => closeWith(1011, String(err)))
  } else {
    // 零字节会话既不会进 establish，也不会启动协议头截止定时器。
    // 没有这个定时器，连上 WS 却一个字节都不发的连接会一直占资源。
    firstPacketTimer = setTimeout(() => {
      firstPacketTimer = null
      if (closed || established || buffer.byteLength > 0) return
      DIAG_COUNTERS.firstPacketTimeouts++
      closeWith(1008, '首包超时：未收到协议头')
    }, FIRST_PACKET_TIMEOUT_MS)
  }

  // Node（vitest）的 Response 不接受 101 状态码，只有 workerd 支持；
  // 因此这里用 200 + webSocket 选项，在 workerd 下同样完成升级。
  // 若运行时不支持 webSocket 选项，则退化为普通 200 响应。
  try {
    const init: ResponseInit = { status: 101, webSocket: client } as ResponseInit
    if (earlyProtocolEcho) {
      init.headers = { 'Sec-WebSocket-Protocol': earlyProtocolEcho }
    }
    return new Response(null, init)
  } catch (err) {
    // 记录原因，便于排查（否则只会看到一个没有信息量的 200）
    console.error('[自研数据面] 101 响应构造失败：', err)
    return new Response(null, { status: 200 })
  }
}
