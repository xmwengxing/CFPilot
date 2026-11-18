/**
 * 诊断计数器的「since / uptimeMs」时钟 —— 真机缺陷回归。
 *
 * ## 守护的缺陷（2026-11-18 真机 /__diag 实测）
 *
 * `websocket-self.ts` 早前在模块顶层写 `const DIAG_SINCE = Date.now()`。
 * workerd 在 **isolate 初始化阶段（模块顶层）** 的 `Date.now()` 返回 **0**，
 * 于是线上 `/__diag` 恒定显示：
 *
 *   "since": 0, "uptimeMs": 1794966906987
 *
 * 即「从 1970 年跑到现在」。本地 Node 直接 import 产物时模块顶层时钟正常，
 * 单测抓不到 —— 必须在**导入前**把时钟打桩成 0 才能复现真机条件。
 *
 * 同类问题也存在于 `probe.ts` 的 `probeWindowStart`，一并修正为惰性初始化。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('诊断计数器起点', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('模块加载时 Date.now()=0 → 首次读取仍得到真实 since 与合理 uptime', async () => {
    const RealDate = Date
    class ZeroClockDate extends RealDate {
      static override now(): number {
        return 0
      }
    }
    vi.resetModules()
    // 模拟 workerd 的模块顶层时钟：导入期间 Date.now() 恒为 0
    vi.stubGlobal('Date', ZeroClockDate)
    const { diagnosticCounters } = await import('../src/protocols/websocket-self')
    // 回到真实时钟后再第一次读取（对应真机第一次 /__diag 请求）
    vi.stubGlobal('Date', RealDate)

    const before = RealDate.now()
    const counters = diagnosticCounters()
    const after = RealDate.now()

    expect(counters.since).toBeGreaterThan(0)
    expect(counters.since).toBeGreaterThanOrEqual(before)
    expect(counters.since).toBeLessThanOrEqual(after)
    expect(counters.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(counters.uptimeMs).toBeLessThan(2000)
  })

  it('多次读取 since 固定、uptime 单调不减', async () => {
    vi.resetModules()
    const { diagnosticCounters } = await import('../src/protocols/websocket-self')
    const first = diagnosticCounters()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = diagnosticCounters()

    expect(second.since).toBe(first.since)
    expect(second.uptimeMs).toBeGreaterThanOrEqual(first.uptimeMs)
  })
})
