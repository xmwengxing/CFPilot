/**
 * `/__edge_probe` 实例级预算 —— 回归测试。
 *
 * ## 为什么必须有这条约束
 *
 * 探针端点**必须保持免鉴权**（铁律 5：WS 101 校验与流式测速是优选的核心），
 * 所以不能靠令牌挡滥用。单次上限只管「一口能吃多少」：
 * 循环请求 `?bytes=8388608` 就能持续拉走边缘带宽。
 *
 * 现在按「每 isolate 每 10 分钟约 6 GiB」累计，超出直接 429。
 * 测试直接调 `chargeProbeBudget` 构造耗尽状态 —— 真跑 6 GiB 不现实，
 * 而预算的判定与累加是同一个模块级状态，这样测的仍是真实分支。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { chargeProbeBudget, handleEdgeProbe, resetProbeBudget } from '../src/probe'

/** 与 probe.ts 的 PROBE_WINDOW_BYTES 一致（6 GiB） */
const WINDOW_BYTES = 6 * 1024 * 1024 * 1024

function probeUrl(bytes?: number): string {
  const base = 'https://edge.test/__edge_probe'
  return bytes === undefined ? base : `${base}?bytes=${bytes}`
}

function probeRequest(bytes?: number): Request {
  return new Request(probeUrl(bytes), { method: 'GET' })
}

beforeEach(() => {
  resetProbeBudget()
})

describe('/__edge_probe 实例级预算', () => {
  it('预算未耗尽时正常返回测速流', async () => {
    const res = await handleEdgeProbe(probeRequest(1024))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-probe-bytes')).toBe('1024')
    // 只读一小段就断开：预算按**实际发出**计量，不该被整份请求占满
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    expect(value!.byteLength).toBeGreaterThan(0)
    await reader.cancel()
  })

  it('预算耗尽后返回 429，且带 Cache-Control: no-store', async () => {
    chargeProbeBudget(WINDOW_BYTES)
    const res = await handleEdgeProbe(probeRequest(1024))
    expect(res.status).toBe(429)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('budget')
  })

  it('Retry-After 是剩余窗口而不是整个窗口', async () => {
    // 窗口开始于 100 秒前 → 剩余 500 秒
    resetProbeBudget(Date.now() - 100_000)
    chargeProbeBudget(WINDOW_BYTES, Date.now())
    const res = await handleEdgeProbe(probeRequest(1024))
    const retry = Number(res.headers.get('retry-after'))
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(500)
  })

  it('窗口过期后预算自动恢复', async () => {
    // 11 分钟前就把预算用光 —— 现在应视为新窗口
    resetProbeBudget(Date.now() - 11 * 60 * 1000)
    chargeProbeBudget(WINDOW_BYTES, Date.now() - 11 * 60 * 1000)
    const res = await handleEdgeProbe(probeRequest(1024))
    expect(res.status).toBe(200)
    await res.body!.cancel()
  })
})
