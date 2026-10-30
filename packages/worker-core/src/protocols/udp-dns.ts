/**
 * UDP over WebSocket —— **仅 DNS（UDP/53）**
 *
 * ## 为什么只有 DNS
 *
 * Cloudflare Workers 只提供 `connect()`（TCP），**没有任何 UDP socket API**。
 * 因此「把 UDP 包转发到任意目标」在边缘上物理不可能：
 * 游戏、QUIC、STUN、WebRTC 全部无解 —— 除非引入外部落地，
 * 而那已经不属于「内核能力」了。
 *
 * 唯一能打通的是 DNS：把查询改写成 **DoH**（HTTPS 上的 DNS，本质是 TCP），
 * 再把响应封回 UDP 帧还给客户端。
 *
 * ## 为什么值得做
 *
 * 客户端把 DNS 走代理时（Clash 的 `dns.nameserver` 指向代理、Xray 的 DNS outbound），
 * 历史上这里直接 `close(1002)` —— 表现是「能连上、能测速、但网页打不开」，
 * 是排查成本最高的一类故障。
 *
 * ## 帧格式（VLESS，RFC 无、以 Xray 实现为准）
 *
 * ```
 * [长度 2 字节 大端][DNS 报文 N 字节][长度][报文]…
 * ```
 *
 * ⚠️ 必须按帧解析，不能把整段流当成一个包 —— 客户端会把多个查询背靠背发过来。
 *
 * ## 端点选择
 *
 * 端点必须是**非 Cloudflare** 的 DoH：Worker 连回 CF 自家网段会被拒
 * （`TCP Loop detected`，见 AGENTS 铁律 9）。所以不能用 `1.1.1.1` /
 * `cloudflare-dns.com`，默认走 `dns.google`。
 */

/** 单次查询的 DoH 超时 */
const QUERY_TIMEOUT_MS = 5000

/** 单条 DNS 报文上限（TCP DNS 的 2 字节长度上限就是 65535） */
const MAX_PACKET = 65535

/** 缓冲上限：超过说明对端不是 DNS，直接丢弃，避免内存被撑爆 */
const MAX_BUFFER = 256 * 1024

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b
  if (b.byteLength === 0) return a
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

/**
 * 构造 SERVFAIL 响应（把查询原样回显，只改标志位）。
 *
 * 为什么不是「静默丢弃」：客户端等不到响应会挂 5 秒才超时，
 * 而一个明确的 SERVFAIL 能让它立刻换下一个解析器。
 * 只改前 4 字节是保守做法 —— 问题段/附加段原样带回，
 * 主流客户端（Xray / sing-box 内置 DNS）都能正确处理。
 */
export function servfail(query: Uint8Array): Uint8Array {
  if (query.byteLength < 12) return new Uint8Array(0)
  const out = query.slice()
  // byte2: QR=1（响应），保留 Opcode 与 RD
  out[2] = 0x80 | (query[2]! & 0x01)
  // byte3: RA=1，RCODE=2（SERVFAIL）
  out[3] = 0x80 | 0x02
  return out
}

export interface DnsUdpOptions {
  /** DoH 端点（必须是非 Cloudflare 域名） */
  endpoint: string
  /** 回写一帧（调用方负责封装成 WS 消息） */
  send: (bytes: Uint8Array) => void
  /** 查询超时（ms） */
  timeoutMs?: number
}

/**
 * 一条 WebSocket 连接上的 DNS 会话。
 *
 * 串行处理：DNS 查询之间没有顺序要求，但串行能天然限流，
 * 避免客户端一次灌 100 个查询把 CPU 打满（单连接并发上限就是 1）。
 */
export class DnsUdpSession {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private queue: Promise<void> = Promise.resolve()
  private dropped = 0

  constructor(private readonly options: DnsUdpOptions) {}

  /** 收到一段上行字节（可能是半帧、一帧或多帧） */
  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    this.pending = concat(this.pending, bytes)
    if (this.pending.byteLength > MAX_BUFFER) {
      // 不像 DNS 流量：整段丢弃，别让它把内存吃掉
      this.pending = new Uint8Array(0)
      return
    }
    this.drain()
  }

  /** 已丢弃的异常帧数（诊断用） */
  get droppedCount(): number {
    return this.dropped
  }

  /** 按长度前缀切帧，逐帧排队解析 */
  private drain(): void {
    while (this.pending.byteLength >= 2) {
      const len = (this.pending[0]! << 8) | this.pending[1]!
      if (len === 0 || len > MAX_PACKET) {
        this.dropped += 1
        this.pending = this.pending.subarray(2)
        continue
      }
      if (this.pending.byteLength < 2 + len) return
      const packet = this.pending.slice(2, 2 + len)
      this.pending = this.pending.subarray(2 + len)
      this.queue = this.queue
        .then(() => this.resolve(packet))
        .catch(() => {
          /* 单帧失败不影响后续帧 */
        })
    }
  }

  /** 一条查询 → DoH → 回写 */
  private async resolve(packet: Uint8Array): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? QUERY_TIMEOUT_MS)
    try {
      const res = await fetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/dns-message',
          Accept: 'application/dns-message',
        },
        // `slice()` 产出独立的 ArrayBuffer：Workers 的 BodyInit 不接受
        // `Uint8Array<ArrayBufferLike>`（类型上可能是 SharedArrayBuffer）
        body: packet.slice().buffer,
        signal: controller.signal,
      })
      if (!res.ok) {
        this.reply(servfail(packet))
        return
      }
      const body = new Uint8Array(await res.arrayBuffer())
      if (body.byteLength === 0) {
        this.reply(servfail(packet))
        return
      }
      this.reply(body)
    } catch {
      this.reply(servfail(packet))
    } finally {
      clearTimeout(timer)
    }
  }

  /** 加 2 字节长度前缀后回写 */
  private reply(packet: Uint8Array): void {
    if (packet.byteLength === 0 || packet.byteLength > MAX_PACKET) return
    const framed = new Uint8Array(2 + packet.byteLength)
    framed[0] = (packet.byteLength >> 8) & 0xff
    framed[1] = packet.byteLength & 0xff
    framed.set(packet, 2)
    this.options.send(framed)
  }
}
