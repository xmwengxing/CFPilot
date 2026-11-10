import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * XHTTP 会话生命周期：容量淘汰与空闲回收。
 *
 * ## 这三个用例守的是什么
 *
 * 早前的实现有两个真实缺陷（都表现为「别人的连接凭空断掉」）：
 *
 * 1. **容量满时踢最早创建的会话**，不看它是否正在正常工作
 *    → 第 101 条连接能掐掉一条正在传输的隧道。
 *
 * 2. **只有一个 lastSeen，且只在会话创建/下行开始时写一次**
 *    → 纯下载会话（下行一直在流、没有新上行）在 10 分钟后被判「空闲」，
 *      而回收是在**任何一条新请求**到达时触发的。
 *
 * 修法：时间戳拆成上行/下行两项；容量满时先回收「孤儿会话」，
 * 仍满则**拒绝新会话**（503），不破坏已在工作的连接。
 */
const dialMock = vi.hoisted(() => vi.fn())
vi.mock('../src/outbound/dial', () => ({ dial: dialMock }))

const { handleXhttp, clearXhttpSessions } = await import('../src/protocols/xhttp')
const { uuidToBytes } = await import('../src/protocols/vless')
const { DEFAULT_CONFIG } = await import('../src/config')

const UUID = '11111111-2222-3333-4444-555555555555'

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** 构造一个合法的 seq 0 分包（VLESS 头 + 一点负载）。 */
function buildSeq0(payload: Uint8Array = new Uint8Array([1])): Uint8Array {
  const uuid = uuidToBytes(UUID)!
  return concat(
    new Uint8Array([0x00]),
    uuid,
    new Uint8Array([0]),
    new Uint8Array([0x01]),
    new Uint8Array([0x01, 0xbb]),
    new Uint8Array([0x02, 0x0b, ...new TextEncoder().encode('example.com')]),
    payload
  )
}

const baseConfig = {
  ...DEFAULT_CONFIG,
  uuid: UUID,
  xhttpPath: '/xhttp',
} as unknown as Parameters<typeof handleXhttp>[1]

/**
 * 起一个**永不结束**的下行流 —— 用来模拟「正在正常传输」的会话。
 *
 * 关键：readable 不 close、也不产出数据 —— 会话保持「有下行流在等」的状态，
 * 但不会触发 touchSession('downlink')（那要真的有数据流出来）。
 */
function setupDanglingDownlink(): void {
  const readable = new ReadableStream<Uint8Array>({
    start() {
      /* 不 enqueue 也不 close —— 模拟挂着的长流 */
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write() {
      /* 丢弃 */
    },
  })
  dialMock.mockResolvedValue({
    readable,
    writable,
    via: 'direct',
    endpoint: 'example.com:443',
    close: async () => {},
  })
}

/** 造一条「已经建立出站、下行流正在跑」的会话（活跃隧道）。 */
async function createActiveSession(id: string): Promise<void> {
  const post = new Request(`https://worker.test/xhttp/${id}/0`, {
    method: 'POST',
    body: Buffer.from(buildSeq0()),
  })
  const res = await handleXhttp(post, baseConfig, [])
  expect(res!.status).toBe(200)
  // 下行 GET —— 保持流打开（不读完）
  await handleXhttp(new Request(`https://worker.test/xhttp/${id}`, { method: 'GET' }), baseConfig, [])
}

/** 造一条「孤儿会话」：只 POST 了 seq>=1，没有头、没有下行。 */
async function createOrphanSession(id: string): Promise<void> {
  const post = new Request(`https://worker.test/xhttp/${id}/1`, {
    method: 'POST',
    body: Buffer.from(new Uint8Array([9, 9, 9])),
  })
  const res = await handleXhttp(post, baseConfig, [])
  expect(res!.status).toBe(200)
}

describe('XHTTP 会话容量管理', () => {
  beforeEach(() => {
    clearXhttpSessions()
    dialMock.mockReset()
  })

  it('容量满时拒绝新会话（503），且不踢掉正在工作的会话', async () => {
    setupDanglingDownlink()
    // 造满 100 条活跃会话
    for (let i = 0; i < 100; i++) {
      await createActiveSession(`sess-${i}`)
    }

    // 第 101 条 ⇒ 必须被拒绝，而不是踢掉第 1 条
    const post = new Request('https://worker.test/xhttp/sess-101/0', {
      method: 'POST',
      body: Buffer.from(buildSeq0()),
    })
    const res = await handleXhttp(post, baseConfig, [])
    expect(res).not.toBeNull()
    expect(res!.status).toBe(503)

    // ⚠️ 关键断言：被拒的**不是**「踢掉一条」——
    // 第 1 条会话必须仍然可用（再发一个分包应成功）。
    const retry = new Request('https://worker.test/xhttp/sess-0/1', {
      method: 'POST',
      body: Buffer.from(new Uint8Array([7])),
    })
    const resRetry = await handleXhttp(retry, baseConfig, [])
    expect(resRetry!.status).toBe(200)
  })

  it('容量满时先回收孤儿会话，新会话仍可建立', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = Date.now()
      setupDanglingDownlink()
      // 99 条活跃 + 1 条孤儿
      for (let i = 0; i < 99; i++) {
        await createActiveSession(`sess-${i}`)
      }
      await createOrphanSession('orphan')

      // 孤儿会话要过了「关联等待窗口」才可回收 ——
      // 正常的「先 POST seq>=1、稍后才 POST seq 0」顺序必须留够时间。
      vi.setSystemTime(new Date(base + 31 * 1000))

      const post = new Request('https://worker.test/xhttp/sess-new/0', {
        method: 'POST',
        body: Buffer.from(buildSeq0()),
      })
      const res = await handleXhttp(post, baseConfig, [])
      // 孤儿会话被回收 ⇒ 腾出位置 ⇒ 新会话成功（而不是 503）
      expect(res!.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('纯下载会话不会被「空闲 10 分钟」回收', async () => {
    // ⚠️ 必须**推进时钟**才能测出来：单靠「再发一个上行包」是测不出的 ——
    // 那个包自己就会把 lastSeen 刷新，早前的实现照样通过。
    //
    // 真正的缺陷场景：下行一直在产数据（所以会话是活的），
    // 但**没有新的上行包**到达 —— 早前只有一个 lastSeen，
    // 它冻结在下行开始的那一刻，于是 10 分钟后被判空闲。
    //
    // 只 fake Date（不动 setTimeout），避免打断流的异步推进。
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = Date.now()
      // 每次 pull 产一块数据 —— 下行持续有流量
      const readable = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([5, 5]))
          // 不 close —— 模拟长流
        },
      })
      const writable = new WritableStream<Uint8Array>({ write() {} })
      dialMock.mockResolvedValue({
        readable,
        writable,
        via: 'direct',
        endpoint: 'example.com:443',
        close: async () => {},
      })

      const post = new Request('https://worker.test/xhttp/dl/0', {
        method: 'POST',
        body: Buffer.from(buildSeq0()),
      })
      expect((await handleXhttp(post, baseConfig, []))!.status).toBe(200)

      const get = new Request('https://worker.test/xhttp/dl', { method: 'GET' })
      const resDown = (await handleXhttp(get, baseConfig, []))!
      expect(resDown.status).toBe(200)
      const reader = resDown.body!.getReader()
      await reader.read() // 第一块数据（基准时刻）

      // 推进 11 分钟 —— 期间**没有新的上行包**到这条会话
      vi.setSystemTime(new Date(base + 11 * 60 * 1000))
      await reader.read() // 下行仍在产数据 ⇒ 活动时间应被刷新

      // 用**另一个**会话 id 触发惰性清理（避免刷新 'dl' 自己的时间戳）
      const other = new Request('https://worker.test/xhttp/other/0', {
        method: 'POST',
        body: Buffer.from(buildSeq0()),
      })
      expect((await handleXhttp(other, baseConfig, []))!.status).toBe(200)

      // 判据：**再开一条下行 GET 返回 null** ⇒ 'dl' 这条会话还活着
      //（它的下行流已经开过，重复开会被拒）。
      //
      // 若 'dl' 在上一步被误判空闲而回收，这里会建一条**新**会话，
      // 返回 200 —— 早前的实现正是这个结果。
      const get2 = new Request('https://worker.test/xhttp/dl', { method: 'GET' })
      const res2 = await handleXhttp(get2, baseConfig, [])
      expect(res2).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 暂存预算的记账必须精确。
 *
 * ## 守的是什么
 *
 * 「先 reserveRetained、再判 pending 是否已满」的顺序会让额度**净泄漏**：
 * closeSession 只归还 `pending` 里的字节，而刚预留、还没进 pending 的
 * 那一段不会被归还 —— 会话又已经从 Map 里删掉了，那块额度**永久占用**。
 *
 * 反复「填满 30 包 + 再发 1 个超限包」就能把 isolate 的 32 MiB 预算打满，
 * 之后所有会话（含合法会话）一律 503 —— 表现为「跑一段时间后突然全挂」。
 */
describe('XHTTP 暂存预算记账', () => {
  beforeEach(() => {
    clearXhttpSessions()
    dialMock.mockReset()
  })

  it('「分包缓存已满」的拒绝不会泄漏暂存额度', async () => {
    // 同一个会话连发 30 个 seq 的分包（各 1 MiB）：
    // 前 30 个进 pending（占 30 MiB），第 31 个撞上「缓存已满」被拒。
    //
    // ⚠️ 早前的顺序是「先 reserve、再判满」—— 被拒的那 1 MiB 进了预算，
    // 但 closeSession 只归还 pending 里的 30 MiB ⇒ **净泄漏 1 MiB**。
    const mib = 1024 * 1024
    for (let seq = 1; seq <= 30; seq++) {
      const res = await handleXhttp(
        new Request(`https://worker.test/xhttp/budget/${seq}`, {
          method: 'POST',
          body: Buffer.from(new Uint8Array(mib)),
        }),
        baseConfig,
        []
      )
      expect(res!.status).toBe(200)
    }
    // 第 31 个 ⇒ 503（缓存已满）
    const overflow = await handleXhttp(
      new Request('https://worker.test/xhttp/budget/31', {
        method: 'POST',
        body: Buffer.from(new Uint8Array(mib)),
      }),
      baseConfig,
      []
    )
    expect(overflow!.status).toBe(503)

    // ⚠️ 判据：新会话必须能**用满整个 32 MiB 预算**。
    //
    //   泄漏时：还剩 1 MiB 被占 ⇒ 32 MiB 装不下 ⇒ 最后一块被拒（503）
    //   修好后：额度全数归还 ⇒ 32 MiB 正好装下 ⇒ 全部成功（200）
    //
    // 单 POST 上限 10 MiB，所以分 4 次发（10 + 10 + 10 + 2）。
    const pieces = [10 * mib, 10 * mib, 10 * mib, 2 * mib]
    for (let i = 0; i < pieces.length; i++) {
      const res = await handleXhttp(
        new Request(`https://worker.test/xhttp/budget2/${i + 1}`, {
          method: 'POST',
          body: Buffer.from(new Uint8Array(pieces[i]!)),
        }),
        baseConfig,
        []
      )
      expect(res!.status).toBe(200)
    }
  })

  it('未鉴权的下行 GET 不能把全部会话槽位占满', async () => {
    setupDanglingDownlink()
    // 连续发 25 个**没有协议头**的下行 GET（随机 id，不需要鉴权）。
    // 这些请求各自会创建一条会话 —— 没有独立闸门的话，
    // 它们能占满 100 个槽位，把真实用户的连接挤掉。
    for (let i = 0; i < 25; i++) {
      await handleXhttp(
        new Request(`https://worker.test/xhttp/rand-${i}`, { method: 'GET' }),
        baseConfig,
        []
      )
    }
    // 真实的会话（带协议头）必须还能建立
    const post = new Request('https://worker.test/xhttp/real/0', {
      method: 'POST',
      body: Buffer.from(buildSeq0()),
    })
    const res = await handleXhttp(post, baseConfig, [])
    expect(res!.status).toBe(200)
  })
})
