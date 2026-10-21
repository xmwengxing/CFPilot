/**
 * 字节流工具：从 WebSocket / HTTP 请求体中精确读取协议头
 */

export class ByteStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private chunks: Uint8Array[] = []
  private size = 0
  private done = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
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
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  ws.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    try {
      if (typeof data === 'string') {
        controller?.enqueue(new TextEncoder().encode(data))
      } else if (data instanceof ArrayBuffer) {
        controller?.enqueue(new Uint8Array(data))
      } else if (ArrayBuffer.isView(data)) {
        controller?.enqueue(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      }
    } catch {
      /* 客户端可能已断开 */
    }
  })

  ws.addEventListener('close', () => {
    try {
      controller?.close()
    } catch {
      /* 已关闭 */
    }
  })

  ws.addEventListener('error', () => {
    try {
      controller?.close()
    } catch {
      /* 已关闭 */
    }
  })

  return stream
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
