/**
 * Free CPU 预算保护
 *
 * Cloudflare Workers 免费版对单次请求有 CPU 时间限制（历史配额为 10ms）。
 * Workers 运行时未暴露真实 CPU 时间，这里用 `performance.now()` 的墙钟增量做近似，
 * 用于在订阅生成、CSV 解析等重活上提前中止，避免触发 503。
 *
 * ## 为什么需要 pause / resume
 *
 * 墙钟包含 **I/O 等待**（KV 读、fetch 远程池），而这些等待几乎不消耗 CPU。
 * 早期实现把整段请求时间都算进预算，导致 `/api/v1/nodes`（面板节点预览）
 * 出现假阳性：两次 KV 读就能吃穿 8ms，远程池被无谓跳过，
 * 预览里一直显示"CPU 预算不足，已跳过部分远程拉取"——
 * 而真实订阅（`/sub` 不带预算）完全正常，两边行为不一致。
 *
 * 因此把计时改成**只累加活跃段**：
 *   - `pause()`：进入 await I/O 前调用，等待时间不再计入
 *   - `resume()`：I/O 返回后调用，继续累计
 *
 * 纯同步的 CPU 密集工作（IP 生成、CSV 解析、base64 编码）不调用 pause，
 * 因此仍被完整计量——预算保护对这些段依然有效。
 */
export class CpuBudget {
  private readonly limitMs: number
  /** 当前活跃段起点；暂停期间无意义 */
  private anchor = performance.now()
  /** 已累计的活跃时长（ms） */
  private accumulated = 0
  /** 是否处于暂停（I/O 等待）状态 */
  private paused = false

  constructor(limitMs = 8) {
    this.limitMs = limitMs
  }

  /** 已消耗的活跃 CPU 近似值（ms），不含 I/O 等待 */
  get elapsedMs(): number {
    return this.accumulated + (this.paused ? 0 : performance.now() - this.anchor)
  }

  get exhausted(): boolean {
    return this.elapsedMs > this.limitMs
  }

  /** 剩余预算（毫秒），可能为负 */
  get remainingMs(): number {
    return this.limitMs - this.elapsedMs
  }

  /** 进入 I/O 等待：暂停计时（重复调用安全） */
  pause(): void {
    if (this.paused) return
    this.accumulated += performance.now() - this.anchor
    this.paused = true
  }

  /** I/O 结束：恢复计时（未暂停时调用安全） */
  resume(): void {
    if (!this.paused) return
    this.anchor = performance.now()
    this.paused = false
  }

  /** 超过预算则抛出 */
  check(): void {
    if (this.exhausted) {
      throw new Error(`CPU 预算超限（${this.limitMs}ms），已提前中止`)
    }
  }
}

/** 默认预算上限（毫秒） */
export const DEFAULT_CPU_BUDGET_MS = 8

/**
 * 单条连接的流量计量器（数据面硬熔断用）。
 *
 * ## 为什么需要
 *
 * `CpuBudget` 只管**控制面**的同步计算（订阅生成 / CSV 解析），
 * 数据面完全不受约束：一条中继连接可以持续转发任意大小的流量。
 * 免费套餐下的 CPU 配额是账号级的，单条超大流量连接能把当天的额度吃穿，
 * 之后所有请求一起 503 —— 而且没有任何一条错误指向「是这条连接害的」。
 *
 * ## 语义边界
 *
 * - 上限为 **0 表示不限制**（默认），行为与引入该功能之前完全一致；
 * - 计量的是**单条连接**的累计字节（上行 + 下行），不是 per-request 总量；
 * - 超限后由调用方主动结束连接（`close` / `error`），不是在这里抛异常 ——
 *   数据面没有可以捕获异常的调用栈，异常只会变成未处理拒绝。
 */
export class TrafficMeter {
  private total = 0

  /**
   * @param limitBytes 上限字节数；<= 0 表示不限制
   */
  constructor(private readonly limitBytes: number) {}

  /** 是否设置了上限 */
  get enabled(): boolean {
    return this.limitBytes > 0
  }

  /** 已计量字节数 */
  get bytes(): number {
    return this.total
  }

  /**
   * 记录一块流量。
   *
   * @returns true 表示**本次记录后已超限**，调用方应立即结束连接
   */
  add(bytes: number): boolean {
    if (this.limitBytes <= 0 || bytes <= 0) return false
    this.total += bytes
    return this.total > this.limitBytes
  }
}

/**
 * 双向字节流中继。
 * 任一端结束或出错时关闭另一端；超过 CPU 预算时优雅收尾而不是硬崩。
 */
export async function relay(
  a: ReadableStream<Uint8Array>,
  b: WritableStream<Uint8Array>,
  budget?: CpuBudget,
  /**
   * 是否在源流结束时**关闭**目标写流。
   *
   * ⚠️ 对 `cloudflare:sockets` 的 writable 必须传 `false`：
   * `close()` 会关闭整个 TCP 连接（表现为 RST），
   * 目标站可能来不及把响应发回来 ——
   * 现象是「握手成功但永远收不到数据」。
   *
   * 对普通 TransformStream（如 HTTP 响应体）保持默认 true 即可 ——
   * 那正是「流结束」的语义。
   */
  closeTarget = true,
  /**
   * 每块字节的回调；返回 true 表示要求**立即中止**（数据面流量熔断）。
   *
   * 中止只是停止中继，**不由这里关闭目标** —— 关闭动作留给调用方，
   * 因为「目标」可能是 socket 写流（不该 close，见 `closeTarget` 的说明）。
   */
  onChunk?: (bytes: number) => boolean
): Promise<void> {
  const reader = a.getReader()
  const writer = b.getWriter()
  try {
    for (;;) {
      if (budget?.exhausted) break
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (onChunk?.(value.byteLength)) break
      await writer.write(value)
    }
  } catch {
    /* 忽略传输错误 */
  } finally {
    if (closeTarget) {
      try {
        await writer.close()
      } catch {
        /* 目标已关闭 */
      }
    } else {
      // 不关闭目标写流：只释放锁，让底层（socket）保持可写。
      // 关闭 socket 写流等于关闭整个连接，目标站会收到 RST 而来不及回数据。
      try {
        writer.releaseLock()
      } catch {
        /* 已释放 */
      }
    }
    try {
      reader.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
}
