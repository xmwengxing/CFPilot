/**
 * 字节流工具：从 WebSocket / HTTP 请求体中精确读取协议头
 */

/** 拼接两个字节数组 */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.byteLength === 0) return b as Uint8Array<ArrayBuffer>
  if (b.byteLength === 0) return a as Uint8Array<ArrayBuffer>
  const out = new Uint8Array(new ArrayBuffer(a.byteLength + b.byteLength))
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

export class ByteStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private chunks: Uint8Array[] = []
  private size = 0
  private done = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  /**
   * 取消底层读取并丢弃缓冲（幂等）。
   *
   * ## 为什么不能由调用方 `body.cancel()`
   *
   * 构造函数已经 `stream.getReader()` **锁定了原始流**。
   * 锁定的流再调 `cancel()` 会抛 `TypeError`（被 try/catch 吞掉），
   * 底层的 `reader.read()` 仍然挂起 —— 请求体没有真正取消，
   * 要等运行时超时才回收。
   *
   * 因此超时 / 解析失败必须由持有 reader 的这一方取消。
   */
  async cancel(reason?: unknown): Promise<void> {
    if (this.done) return
    this.done = true
    this.chunks = []
    this.size = 0
    try {
      await this.reader.cancel(reason)
    } catch {
      /* 流已结束或已取消 */
    }
  }

  /**
   * 从底层读取一个数据块进入内部缓冲（不消费）。
   *
   * 返回新到达的字节数；底层流结束返回 null。
   * 调用方配合 `peek()` + `skip()` 实现「按块扫描、精确消费」——
   * 对比逐字节 `readExactly(1)`，一次读取解析整段协议头（省上百次 Promise/Timer）。
   */
  async fill(): Promise<number | null> {
    for (;;) {
      if (this.done) return null
      const { done, value } = await this.reader.read()
      if (done) {
        this.done = true
        return null
      }
      if (value && value.byteLength > 0) {
        this.chunks.push(value)
        this.size += value.byteLength
        return value.byteLength
      }
    }
  }

  /** 精确读取 n 字节；流结束则返回 null */
  async readExactly(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0)
    while (this.size < n) {
      if (this.done) return null
      const { done, value } = await this.reader.read()
      if (done) {
        this.done = true
        return this.size >= n ? this.take(n) : null
      }
      if (value && value.byteLength > 0) {
        this.chunks.push(value)
        this.size += value.byteLength
      }
    }
    return this.take(n)
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let offset = 0
    while (offset < n) {
      const head = this.chunks[0]!
      const need = n - offset
      if (head.byteLength <= need) {
        out.set(head, offset)
        offset += head.byteLength
        this.chunks.shift()
      } else {
        out.set(head.subarray(0, need), offset)
        this.chunks[0] = head.subarray(need)
        offset += need
      }
    }
    this.size -= n
    return out
  }

  /** 预读 n 字节（不消费）；缓冲不足或流结束返回 null */
  async peekExactly(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0)
    while (this.size < n) {
      if (this.done) return null
      const { done, value } = await this.reader.read()
      if (done) {
        this.done = true
        return this.size >= n ? this.slice(n) : null
      }
      if (value && value.byteLength > 0) {
        this.chunks.push(value)
        this.size += value.byteLength
      }
    }
    return this.slice(n)
  }

  /** 消费 n 字节（数据不足时返回 null） */
  skip(n: number): Uint8Array | null {
    if (this.size < n) return null
    return this.take(n)
  }

  private slice(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let offset = 0
    for (const c of this.chunks) {
      if (offset >= n) break
      const take = Math.min(c.byteLength, n - offset)
      out.set(c.subarray(0, take), offset)
      offset += take
    }
    return out
  }

  /** 剩余字节（可能是协议头之后紧跟的首包数据） */
  peek(): Uint8Array {
    if (this.chunks.length === 0) return new Uint8Array(0)
    // 首包解析完通常只剩一块：直接返回视图，省掉一次整块复制。
    // 调用方（release / HTTP 代理响应头解析）都只读，不会改写它。
    if (this.chunks.length === 1) return this.chunks[0]!
    const total = this.chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of this.chunks) {
      out.set(c, offset)
      offset += c.byteLength
    }
    return out
  }

  /** 把剩余内容（以及后续数据）包装为新的可读流 */
  release(): ReadableStream<Uint8Array> {
    const leftover = this.peek()
    this.chunks = []
    this.size = 0
    const reader = this.reader
    const self = this
    let emitted = false
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!emitted) {
          emitted = true
          if (leftover.byteLength > 0) {
            controller.enqueue(leftover)
            return
          }
        }
        if (self.done) {
          controller.close()
          return
        }
        try {
          const { done, value } = await reader.read()
          if (done) {
            self.done = true
            controller.close()
          } else if (value && value.byteLength > 0) {
            controller.enqueue(value)
          }
        } catch (err) {
          controller.error(err)
        }
      },
      cancel(reason) {
        void reader.cancel(reason)
      },
    })
  }
}

/** 将 WebSocket 消息转换为字节流 */
export function wsToByteStream(ws: WebSocket): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  // 串行化：Blob 的读取是异步的，必须保证入队顺序
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (bytes: Uint8Array): void => {
    if (closed || bytes.byteLength === 0) return
    try {
      controller?.enqueue(bytes)
    } catch {
      /* 客户端可能已断开 */
    }
  }

  /**
   * 把任意形态的消息体归一成 Uint8Array。
   *
   * 真机实测：Cloudflare 运行时下 `event.data` **不一定是 ArrayBuffer**，
   * 也可能是 Blob（只有 `.arrayBuffer()`）。早期实现只处理了 ArrayBuffer，
   * 结果每条消息都被静默丢弃，表现为「101 成功但永远收不到数据」，客户端全部 -1。
   */
  const normalize = (data: unknown): Uint8Array | Promise<Uint8Array> | null => {
    if (data === null || data === undefined) return null
    if (typeof data === 'string') return new TextEncoder().encode(data)
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    const maybeBlob = data as { arrayBuffer?: () => Promise<ArrayBuffer> }
    if (typeof maybeBlob.arrayBuffer === 'function') {
      return maybeBlob.arrayBuffer().then((buf) => new Uint8Array(buf))
    }
    return null
  }

  const flush = (data: unknown): void => {
    const result = normalize(data)
    if (result === null) return
    chain = chain
      .then(() => (result instanceof Promise ? result : result))
      .then((bytes) => enqueue(bytes))
      .catch(() => {
        /* 忽略单条消息错误 */
      })
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  ws.addEventListener('message', (event: MessageEvent) => {
    flush(event.data)
  })

  ws.addEventListener('close', () => {
    closed = true
    void chain.then(() => {
      try {
        controller?.close()
      } catch {
        /* 已关闭 */
      }
    })
  })

  ws.addEventListener('error', () => {
    closed = true
    try {
      controller?.close()
    } catch {
      /* 已关闭 */
    }
  })

  return stream
}

/**
 * 下行发送的「让步点」。
 *
 * ## 平台事实
 *
 * Workers 的 `WebSocketPair` server 端**不提供 `bufferedAmount`**，也没有 drain
 * 事件；`send()` 无返回值、无背压信号（官方类型声明与运行时实测一致）。
 * 因此下面的 `awaitSendCapacity` 在真实运行时读到的恒为 `undefined`，
 * 等价于一个空 return —— 保留它只是为了不破坏既有回归用例，
 * **转发路径已不再调用**，改用 `DownlinkPacer`。
 *
 * ## 现在的做法
 *
 * `DownlinkPacer` 按「自上次让步以来累计发送字节」周期性让出一次事件循环，
 * 给运行时机会把已排队的帧刷出去。这是**主动让步**，不是响应式背压：
 * 它感知不到客户端是否真的消费了数据，也不会把压力回传到上游 TCP。
 * 真正防内存膨胀仍靠单连接流量上限与 isolate 级预算。
 */
export const DOWNLINK_HIGH_WATER = 4 * 1024 * 1024

/** 兼容用：缓冲超阈值时让出一次事件循环。转发路径已改用 DownlinkPacer。 */
export async function awaitSendCapacity(
  ws: { readonly bufferedAmount?: number },
  highWater: number = DOWNLINK_HIGH_WATER
): Promise<void> {
  const buffered = ws.bufferedAmount
  if (typeof buffered !== 'number') return
  if (buffered <= highWater) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * 每累计这么多下行字节，让出一次事件循环。
 *
 * 与 `DOWNLINK_HIGH_WATER` 对齐（4 MiB）。原先取 1 MiB 时，
 * 一次 4 MiB 下载会在 1032 个 4 KiB 帧之间插入 4 次无条件让步；
 * 平台并没有可观测的发送队列（没有 bufferedAmount / drain），
 * 这种「按字节数拍脑袋」的让出既挡不住慢客户端，也可能打断上游预读节奏。
 * 放大到 4 MiB 把无条件打扰降到 1 次，同时保留一个让步点作为兜底。
 *
 * ⚠️ 这是保守的主动让步，不是响应式背压；真正的条件背压在本平台无法实现。
 */
export const DOWNLINK_YIELD_BYTES = 4 * 1024 * 1024

/**
 * 不依赖运行时属性的下行节流器（每条连接一个实例）。
 *
 * `yieldOnce` 可注入，便于在不依赖定时器的单测里验证让步次数。
 */
export class DownlinkPacer {
  private sinceYield = 0
  private yields = 0

  constructor(
    private readonly threshold: number = DOWNLINK_YIELD_BYTES,
    private readonly yieldOnce: () => Promise<void> = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
  ) {}

  async onChunk(bytes: number): Promise<void> {
    this.sinceYield += bytes
    if (this.sinceYield < this.threshold) return
    this.sinceYield = 0
    this.yields += 1
    await this.yieldOnce()
  }

  get yieldCount(): number {
    return this.yields
  }
}

/** 字节流 → WebSocket 发送 */
export async function pipeToWebSocket(
  source: ReadableStream<Uint8Array>,
  ws: WebSocket
): Promise<void> {
  const reader = source.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      ws.send(value)
    }
  } catch {
    /* 忽略写入错误 */
  } finally {
    try {
      ws.close(1000, 'done')
    } catch {
      /* 已关闭 */
    }
  }
}
