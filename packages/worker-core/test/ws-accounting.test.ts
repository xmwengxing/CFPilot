/**
 * 数据面「拨号窗口」记账与生命周期 —— 回归测试。
 *
 * 守护三件事（2026-11-18 审计核实）：
 *
 * 1. **暂存额度必须配平**：`drainPendingUplink` 早前先清零 `pendingUplinkBytes`
 *    再逐块扣 `pendingBudget.bytes`。只要循环在中途抛错（写入被对端重置、
 *    `retain` 触发 1009 关闭），后面没遍历到的分块字节就永久留在 isolate 计数里，
 *    攒到 32 MiB 后本 isolate 所有新连接都会被 1009 拒绝。
 *
 * 2. **拨号途中客户端断开的收口**：`onClose` 早前只 cleanup、不置 `closed`，
 *    于是 `establish()` 在 `await dial()` 返回后仍会建 writer / 起泵，
 *    留下一条无人持有也无人关闭的出站连接（占满 6 条并发出站槽位）。
 *
 * 3. **重拨期间 writer 的开放时机**：`writer` 若在「重放 + 补写」之前就公开，
 *    重放窗口内到达的新帧会先进入留存、旧帧后被追加 —— retained 顺序错乱，
 *    下一轮重拨重放的 TLS 密文流跟着乱序（bad_record_mac）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const dialMock = vi.hoisted(() => vi.fn())
const relayMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))
vi.mock('../src/outbound/relay', () => ({ collectRelayEndpoints: relayMock }))

const { handleWebSocket, recentCloses, pendingBudgetBytes } = await import(
  '../src/protocols/websocket-self'
)

const UUID = '11111111-2222-3333-4444-555555555555'
const PASSWORD = 'trojan-pass-accounting'

class FakeWebSocket {
  sent: Uint8Array[] = []
  closed: { code: number; reason: string } | null = null
  binaryType = ''
  private listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {}
  accept(): void {}
  send(bytes: Uint8Array): void {
    this.sent.push(bytes)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code: code ?? 1005, reason: reason ?? '' }
  }
  addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  emit(type: string, ev: { data: unknown }): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

class FakePair {
  client = new FakeWebSocket()
  server = new FakeWebSocket()
}

let lastPair: FakePair | null = null
class RecordingPair extends FakePair {
  constructor() {
    super()
    lastPair = this
  }
}

function buildTrojanHeader(hostname: string, port: number): Uint8Array {
  const digest = createHash('sha224').update(PASSWORD).digest('hex')
  const name = new TextEncoder().encode(hostname)
  return new Uint8Array([
    ...new TextEncoder().encode(`${digest}\r\n`),
    0x01,
    0x03,
    name.length,
    ...name,
    (port >> 8) & 0xff,
    port & 0xff,
    ...new TextEncoder().encode('\r\n'),
  ])
}

/** 协议头 + 3 字节负载 */
function messageWithPayload(hostname = 'example.com', payload = [1, 2, 3]): Uint8Array {
  const header = buildTrojanHeader(hostname, 443)
  const out = new Uint8Array(header.byteLength + payload.length)
  out.set(header, 0)
  out.set(payload, header.byteLength)
  return out
}

/** 假活上游：下行永不产出、永不休止 */
function stallResult(endpoint: string) {
  return {
    readable: new ReadableStream<Uint8Array>({
      pull() {
        /* 永不产出 */
      },
    }),
    writable: new WritableStream<Uint8Array>(),
    via: 'direct' as const,
    endpoint,
    close: vi.fn(),
  }
}

/** 写入即失败的上游（模拟对端已重置） */
function failingWriteResult() {
  const chunks: Uint8Array[] = []
  return {
    chunks,
    result: {
      readable: new ReadableStream<Uint8Array>({
        pull() {
          /* 永不产出 */
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk)
          throw new Error('upstream reset')
        },
      }),
      via: 'direct' as const,
      endpoint: '203.0.113.9:443',
      close: vi.fn(),
    },
  }
}

/**
 * 可手动放行的上游：每次 `write()` 挂起，测试按顺序 `release()`。
 * 用来在「重放写入挂起」的窗口里安排新帧到达。
 */
function controlledResult(endpoint: string) {
  const chunks: Uint8Array[] = []
  const pending: Array<() => void> = []
  let readController: ReadableStreamDefaultController<Uint8Array> | null = null
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      readController = c
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
      return new Promise<void>((resolve) => {
        pending.push(resolve)
      })
    },
  })
  return {
    result: { readable, writable, via: 'direct' as const, endpoint, close: vi.fn() },
    chunks,
    release(): boolean {
      const next = pending.shift()
      if (!next) return false
      next()
      return true
    },
    get pendingWrites(): number {
      return pending.length
    },
    eof(): void {
      try {
        readController?.close()
      } catch {
        /* 已关闭 */
      }
    },
  }
}

/** 立即接受写入并记录的上游 */
function recordingResult(endpoint: string) {
  const chunks: Uint8Array[] = []
  return {
    chunks,
    result: {
      readable: new ReadableStream<Uint8Array>({
        pull() {
          /* 永不产出 */
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk)
        },
      }),
      via: 'direct' as const,
      endpoint,
      close: vi.fn(),
    },
  }
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const request = new Request('https://dp.example.com/t', { headers: { upgrade: 'websocket' } })

const baseConfig = {
  uuid: UUID,
  trojanPassword: PASSWORD,
  enableTrojan: true,
  wsPath: '/t',
  trojanPath: '/trojan',
  concurrentDial: 1,
  resolvePreferred: false,
  aggressiveRedial: false,
  dialConnectMs: 5000,
  dialBudgetMs: 15000,
  dohBudgetMs: 1200,
  dialStallMs: 2500,
  relayRedialMax: 4,
} as unknown as Parameters<typeof handleWebSocket>[2]

const ctxStub = { waitUntil: (_p: Promise<unknown>): void => {} }

/** 跑完已排队的微任务（不依赖定时器，避免被 fake timers 拦下） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

async function open(): Promise<FakeWebSocket> {
  ;(globalThis as { WebSocketPair?: unknown }).WebSocketPair = RecordingPair
  lastPair = null
  await handleWebSocket(request, 'trojan', baseConfig, [], ctxStub)
  // 构造器里赋的值 TS 看不到（跨函数副作用），这里显式收窄
  const pair = lastPair as FakePair | null
  if (!pair) throw new Error('handleWebSocket 尚未创建 WebSocketPair')
  return pair.server
}

beforeEach(() => {
  dialMock.mockReset()
  relayMock.mockReset()
  relayMock.mockResolvedValue([
    { ip: '198.51.100.1', port: 443, label: 'relay-1' },
    { ip: '198.51.100.2', port: 443, label: 'relay-2' },
  ])
  recentCloses().length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('拨号暂存额度配平', () => {
  it('补写过程中写入失败 → 暂存额度归零（不再残留到 isolate 预算）', async () => {
    const failing = failingWriteResult()
    let resolveDial: ((value: unknown) => void) | null = null
    dialMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDial = resolve
      })
    )
    const server = await open()

    // 首包只含协议头（payload 为空）→ establish 直接进入 drainPendingUplink，
    // 让「写入失败」发生在**补写循环内部**（这正是额度泄漏的那条路径）。
    const headerOnly = buildTrojanHeader('example.com', 443)
    server.emit('message', { data: headerOnly.buffer })
    server.emit('message', { data: new Uint8Array([4, 5, 6]).buffer })
    server.emit('message', { data: new Uint8Array([7, 8, 9]).buffer })
    await flush()
    expect(pendingBudgetBytes()).toBeGreaterThan(0)

    // 拨号这时才成功：补写第一块即抛错 → 循环中断
    resolveDial!(failing.result)
    await flush()
    // 后面没写出的分块必须已归还（否则额度会残留到 isolate 预算）
    expect(pendingBudgetBytes()).toBe(0)
  })

  it('正常补写完成后额度同样归零', async () => {
    const recording = recordingResult('203.0.113.5:443')
    dialMock.mockResolvedValue(recording.result)
    const server = await open()

    server.emit('message', { data: messageWithPayload().buffer })
    server.emit('message', { data: new Uint8Array([4, 5, 6]).buffer })
    await flush()

    expect(pendingBudgetBytes()).toBe(0)
    // 首包与暂存帧都写到了出站，且顺序不变
    expect(recording.chunks).toHaveLength(2)
    expect(joinChunks(recording.chunks)).toEqual(
      joinChunks([messageWithPayload().subarray(buildTrojanHeader('example.com', 443).byteLength), new Uint8Array([4, 5, 6])])
    )
  })
})

describe('拨号途中客户端断开', () => {
  it('迟到的拨号结果会被关闭，不会留下无人持有的 Socket', async () => {
    let resolveDial: ((value: unknown) => void) | null = null
    dialMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDial = resolve
      })
    )
    const server = await open()

    server.emit('message', { data: messageWithPayload().buffer })
    await flush()
    expect(dialMock).toHaveBeenCalledTimes(1)

    // 客户端在出站建连完成前断开
    server.emit('close', { data: null })
    await flush()

    const recording = recordingResult('203.0.113.7:443')
    resolveDial!(recording.result)
    await flush()

    expect(recording.result.close).toHaveBeenCalledTimes(1)
    // 入站已关闭 → 不应再写出任何上行
    expect(recording.chunks).toHaveLength(0)
  })
})

describe('重拨期间 writer 的开放时机', () => {
  it('重放窗口内到达的帧仍按到达顺序留存（二次重拨不丢序）', async () => {
    vi.useFakeTimers()
    try {
      // 直连假活 → 反代 #1（拨号与写入都手动放行）→ 反代 #2（记录重放内容）
      const controlled = controlledResult('198.51.100.1:443')
      const recorded = recordingResult('198.51.100.2:443')
      let resolveRelayDial: ((value: unknown) => void) | null = null
      dialMock
        .mockResolvedValueOnce(stallResult('203.0.113.10:443'))
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveRelayDial = resolve
          })
        )
        .mockResolvedValueOnce(recorded.result)

      const server = await open()
      const first = messageWithPayload('example.com', [1, 2, 3])
      const payload = first.subarray(buildTrojanHeader('example.com', 443).byteLength)
      const pendingA = new Uint8Array([4, 5, 6])
      const duringReplayB = new Uint8Array([7, 8, 9])

      server.emit('message', { data: first.buffer })
      await vi.advanceTimersByTimeAsync(10)
      // 下行静默窗口到点 → 进入第一轮重拨（writer 被置空，反代拨号挂起）
      await vi.advanceTimersByTimeAsync(2600)
      expect(dialMock).toHaveBeenCalledTimes(2)

      // ① 反代还在拨号 → 帧 A 进暂存池
      server.emit('message', { data: pendingA.buffer })
      await vi.advanceTimersByTimeAsync(1)

      // ② 拨号完成、重放写入挂起 → 此时到达的帧 B（关键窗口）
      resolveRelayDial!(controlled.result)
      await flush()
      expect(controlled.pendingWrites).toBe(1)
      server.emit('message', { data: duringReplayB.buffer })
      await flush()

      // 放行重放 → 补写 A → 补写 B（每写一块都挂一次）
      for (let i = 0; i < 4; i++) {
        controlled.release()
        await flush()
      }

      // 反代 #1 也零下行：EOF 触发第二轮重拨，重放 retained 给反代 #2
      controlled.eof()
      await flush()
      await vi.advanceTimersByTimeAsync(10)
      expect(dialMock).toHaveBeenCalledTimes(3)

      await flush()
      expect(recorded.chunks.length).toBeGreaterThan(0)
      expect(joinChunks(recorded.chunks)).toEqual(joinChunks([payload, pendingA, duringReplayB]))
      // 会话仍在（假活链路，未收尸）
      expect(server.closed).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
