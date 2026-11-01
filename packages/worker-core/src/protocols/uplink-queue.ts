/**
 * 上行写入的串行队列。
 *
 * ## 为什么需要它
 *
 * WebSocket 的 `message` 回调是异步函数，写入出站 `WritableStream` 时可能有多段
 * 数据同时处于「已排队、未落盘」的状态。`WritableStream` 的写请求本身按**调用顺序**
 * 入队，所以常规路径不会乱序；**切换出站**（直连假活 → 反代重拨）才有一个真空档：
 *
 * | 时刻 | 事件 | 结果 |
 * |---|---|---|
 * | t0 | 重拨开始，`writer = null` | — |
 * | t1 | 客户端帧 D 到达 | 进缓存 `buffer = [D]` |
 * | t2 | 新 socket 建好，开写重放数据（`await` 未完成） | 重放写请求排队中 |
 * | t3 | 客户端帧 E 到达，看到 `writer` 非空 | **E 直接排队** |
 * | t4 | 补写缓存 D | **D 排在 E 之后** |
 *
 * 于是上行字节顺序变成「重放, E, D」。若 D/E 是同一条 TLS 记录的相邻分片，
 * 目标站收到的是损坏的密文流（`bad_record_mac` / 连接被重置），
 * 而这恰好发生在假活重拨这种本就脆弱的时刻。
 *
 * 因此所有上行写入（含「换 writer + 重放 + 补写缓存」这一整段）都排进**同一条链**：
 * 顺序由链保证，而不是由「谁先 await」保证。
 *
 * 本模块刻意只依赖 Promise，不触碰 WebSocket / socket，便于单测。
 */

/** 队列执行写入时需要的写入器形状（`WritableStreamDefaultWriter` 满足它） */
export interface UplinkWriter {
  write(chunk: Uint8Array): Promise<void>
}

export class UplinkQueue {
  /**
   * 链尾。始终以「已结算」状态收尾 —— 一次写失败不能让后续写入被整体跳过，
   * 否则会出现「一次抖动之后隧道再也发不出数据」。
   */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * 把一个任务排到链尾。
   *
   * 返回的 Promise 反映**本次任务自身**的成败，调用方负责处理；
   * 内部链尾单独吞掉异常，只用于串行化。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }

  /**
   * 排入一次写入。
   *
   * 写入器在**执行时**才解析：重拨期间 `writer` 可能已经从旧出站换到新出站，
   * 过早捕获会把数据写给已经关闭的 socket。
   */
  write(current: () => UplinkWriter | null, bytes: Uint8Array): Promise<void> {
    return this.run(async () => {
      const writer = current()
      if (!writer) return
      await writer.write(bytes)
    })
  }
}
