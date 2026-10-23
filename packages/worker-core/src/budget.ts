/**
 * Free CPU 预算保护
 *
 * Cloudflare Workers 免费版对单次请求有 CPU 时间限制（历史配额为 10ms）。
 * Workers 运行时未暴露真实 CPU 时间，这里用 `performance.now()` 的墙钟增量做近似，
 * 用于在订阅生成、CSV 解析等重活上提前中止，避免触发 503。
 */
export class CpuBudget {
  private readonly start = performance.now()
  private readonly limitMs: number

  constructor(limitMs = 8) {
    this.limitMs = limitMs
  }

  get elapsedMs(): number {
    return performance.now() - this.start
  }

  get exhausted(): boolean {
    return this.elapsedMs > this.limitMs
  }

  /** 剩余预算（毫秒），可能为负 */
  get remainingMs(): number {
    return this.limitMs - this.elapsedMs
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
   * 现象是「握手成功但永远收不到数据」（2026-10-23 真机发现，影响 XHTTP 入站）。
   *
   * 对普通 TransformStream（如 HTTP 响应体）保持默认 true 即可 ——
   * 那正是「流结束」的语义。
   */
  closeTarget = true
): Promise<void> {
  const reader = a.getReader()
  const writer = b.getWriter()
  try {
    for (;;) {
      if (budget?.exhausted) break
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
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
