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

/**
 * 单连接同时在飞的 DoH 查询上限。
 *
 * 完全串行会让浏览器一次解析十几个域名时的响应延迟逐个累加；
 * 但也不能无限并发 —— 那正是客户端一次灌几百个查询打满 CPU 的形态。
 * DNS 响应自带 16-bit Transaction ID，乱序返回是协议允许的。
 */
export const MAX_CONCURRENT_QUERIES = 4

/** 等待队列长度上限，超出直接丢弃并计数 */
export const MAX_QUEUED_QUERIES = 32

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
 * **有界并发**：同时最多 `MAX_CONCURRENT_QUERIES` 条 DoH 在飞，其余进有界等待队列。
 * 早期用一条串行 Promise 链做限流，虽然绝对安全，但慢查询会把后面所有查询
 * 一起拖住（队头阻塞）。现在保留限流语义，同时让并发查询互不等待。
 */
export class DnsUdpSession {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private waiting: Uint8Array[] = []
  private inflight = 0
  private dropped = 0
  /** 连接是否已关闭（关闭后在飞请求要中止、回写要停止） */
  private closed = false
  /** 在飞 DoH 请求的取消器（关闭时统一 abort，别让后台继续吃子请求配额） */
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly options: DnsUdpOptions) {}

  /**
   * 关闭会话：清空队列并中止在飞查询。
   *
   * WebSocket 断开后必须调用 —— 否则后台 DoH 请求会继续消耗子请求配额，
   * 回写也会打到一个已经关闭的 WebSocket 上。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting.length = 0
    this.pending = new Uint8Array(0)
    for (const controller of this.controllers) {
      try {
        controller.abort()
      } catch {
        /* 已中止 */
      }
    }
    this.controllers.clear()
  }

  /** 收到一段上行字节（可能是半帧、一帧或多帧） */
  push(bytes: Uint8Array): void {
    if (this.closed || bytes.byteLength === 0) return
    this.pending = concat(this.pending, bytes)
    if (this.pending.byteLength > MAX_BUFFER) {
      // 不像 DNS 流量：整段丢弃，别让它把内存吃掉
      this.pending = new Uint8Array(0)
      return
    }
    this.drain()
  }

  /** 已丢弃的异常帧 / 超出队列上限的帧数（诊断用） */
  get droppedCount(): number {
    return this.dropped
  }

  /** 当前在飞的 DoH 查询数（诊断与回归测试用） */
  get activeQueries(): number {
    return this.inflight
  }

  /** 当前排队等待的帧数 */
  get queuedCount(): number {
    return this.waiting.length
  }

  /** 按长度前缀切帧，放进有界等待队列 */
  private drain(): void {
    while (this.pending.byteLength >= 2) {
      const len = (this.pending[0]! << 8) | this.pending[1]!
      if (len === 0 || len > MAX_PACKET) {
        this.dropped += 1
        this.pending = this.pending.subarray(2)
        continue
      }
      if (this.pending.byteLength < 2 + len) {
        this.pump()
        return
      }
      const packet = this.pending.slice(2, 2 + len)
      this.pending = this.pending.subarray(2 + len)
      if (this.waiting.length >= MAX_QUEUED_QUERIES) {
        this.dropped += 1
        continue
      }
      this.waiting.push(packet)
    }
    this.pump()
  }

  /** 在不越过并发上限的前提下，尽量把等待队列里的帧发出去 */
  private pump(): void {
    if (this.closed) return
    while (this.inflight < MAX_CONCURRENT_QUERIES && this.waiting.length > 0) {
      const packet = this.waiting.shift()!
      this.inflight += 1
      // resolve() 内部已吞掉所有异常，只会正常结束
      void this.resolve(packet).finally(() => {
        this.inflight -= 1
        this.pump()
      })
    }
  }

  /** 一条查询 → DoH → 回写 */
  private async resolve(packet: Uint8Array): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
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
      // 超过 DNS/TCP 报文上限的响应不是合法 DNS 应答（也挡住畸形体吃内存）。
      if (body.byteLength === 0 || body.byteLength > MAX_PACKET) {
        this.reply(servfail(packet))
        return
      }
      this.reply(this.filterAaaa(body))
    } catch {
      this.reply(servfail(packet))
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
    }
  }

  /**
   * 过滤 DoH 响应里的 AAAA 记录（type 28）。
   *
   * `outbound/doh.ts` 已停查 AAAA（铁律 20：Workers 的 connect() 出站不支持
   * IPv6，查了只会产出不可用候选）；但这里走的是 **DNS 二进制报文**直通，
   * 客户端问 AAAA 时上游会正常返回 AAAA —— 不滤的话客户端拿到 IPv6 地址
   * 去连，而连接仍走本隧道出站，必然失败。与 doh.ts 同口径（P2 #17）。
   *
   * DNS 报文解析：跳过 12 字节头 + Question 段，逐条遍历 RR，
   * 丢弃 type=28 的并重算 ANCOUNT/NSCOUNT/ARCOUNT。
   */
  /**
   * 跳过 DNS 报文里的 NAME 字段，返回其后的偏移；非法或越界返回 -1。
   *
   * 三种形态都必须认（RFC 1035 / 3597）：
   *   - 普通标签序列：`... 0x00`
   *   - 压缩指针：`0xc0 xxxx`（NAME 到此结束，指针本身占 2 字节）
   *   - **复合形态**：若干普通标签 + 结尾压缩指针（如 `03 'www' 0xc0 0x0c`）
   *
   * ⚠️ 早前实现在非指针分支末尾多跳了 4 字节（把 Question 段的 QTYPE+QCLASS
   * 偏移误用到 RR 段），且把 0xc0 当成 192 字节的普通标签长度 → 直接越界。
   */
  private skipName(packet: Uint8Array, offset: number): number {
    let pos = offset
    while (pos < packet.byteLength) {
      const len = packet[pos]!
      if (len === 0) return pos + 1
      if ((len & 0xc0) === 0xc0) return pos + 2 <= packet.byteLength ? pos + 2 : -1
      // 0x40 / 0x80 两个高位是保留值；标签长度上限 63
      if ((len & 0xc0) !== 0 || len > 63) return -1
      pos += 1 + len
    }
    return -1
  }

  private filterAaaa(packet: Uint8Array): Uint8Array {
    if (packet.byteLength < 12) return packet
    const qd = (packet[4]! << 8) | packet[5]!
    const an = (packet[6]! << 8) | packet[7]!
    const ns = (packet[8]! << 8) | packet[9]!
    const ar = (packet[10]! << 8) | packet[11]!
    if (qd === 0 && an === 0 && ns === 0 && ar === 0) return packet

    // 跳过 Question 段（QNAME 变长 + QTYPE 2 + QCLASS 2）
    let pos = 12
    for (let q = 0; q < qd; q++) {
      pos = this.skipName(packet, pos)
      if (pos < 0 || pos + 4 > packet.byteLength) return packet
      pos += 4
    }

    /**
     * ⚠️ 必须**预分配与原件等长**的缓冲再按 writePos 追加：
     * 早前用 `packet.slice(0, pos)` 建定长数组，随后 `out.set(rr, out.byteLength)`
     * 写入必然抛 `RangeError`，被 resolve() 的 catch 吞成 SERVFAIL ——
     * 于是**任何含 A / CNAME 记录的正常应答都变成 SERVFAIL**。
     */
    const out = new Uint8Array(packet.byteLength)
    out.set(packet.subarray(0, pos), 0)
    let writePos = pos
    let removed = 0
    // 三个区段**按索引**遍历 —— 用记录数（an/ns/ar）的值相等来区分区段不可靠
    const counts = [an, ns, ar]
    const kept = [0, 0, 0]
    for (let sec = 0; sec < 3; sec++) {
      const total = counts[sec]!
      for (let r = 0; r < total; r++) {
        const rrStart = pos
        // 每条 RR = NAME + TYPE2 + CLASS2 + TTL4 + RDLEN2 + RDATA
        const afterName = this.skipName(packet, pos)
        if (afterName < 0 || afterName + 10 > packet.byteLength) return packet
        const type = (packet[afterName]! << 8) | packet[afterName + 1]!
        const rdlen = (packet[afterName + 8]! << 8) | packet[afterName + 9]!
        const rrEnd = afterName + 10 + rdlen
        if (rrEnd > packet.byteLength) return packet
        if (type === 28) {
          removed += 1
        } else {
          const len = rrEnd - rrStart
          out.set(packet.subarray(rrStart, rrEnd), writePos)
          writePos += len
          kept[sec]! += 1
        }
        pos = rrEnd
      }
    }
    if (removed === 0) return packet
    out[6] = (kept[0]! >> 8) & 0xff
    out[7] = kept[0]! & 0xff
    out[8] = (kept[1]! >> 8) & 0xff
    out[9] = kept[1]! & 0xff
    out[10] = (kept[2]! >> 8) & 0xff
    out[11] = kept[2]! & 0xff
    return out.subarray(0, writePos)
  }

  /** 加 2 字节长度前缀后回写 */
  private reply(packet: Uint8Array): void {
    if (this.closed) return
    if (packet.byteLength === 0 || packet.byteLength > MAX_PACKET) return
    const framed = new Uint8Array(2 + packet.byteLength)
    framed[0] = (packet.byteLength >> 8) & 0xff
    framed[1] = packet.byteLength & 0xff
    framed.set(packet, 2)
    this.options.send(framed)
  }
}
