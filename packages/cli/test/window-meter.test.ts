/**
 * 吞吐窗口计量（WindowMeter）—— 测速口径的回归测试。
 *
 * ## 这个测试在防什么
 *
 * 老口径是「总字节 ÷ 从拨号起算的总耗时」，把 TLS/TTFB 与 TCP 慢启动全算进去。
 * 2026-10-28 真机实测同一条链路：
 *   - 逐秒速率：0.19 → 0.25 → 0.29 → 0.20 → 0.50 → 0.47 → 0.52 → 0.81 → 0.87 MB/s
 *   - 整段平均 0.42 MB/s，稳态 0.87 MB/s —— 低估一倍以上
 * 再叠加阶段三默认 4 路并行测候选（4 条流分摊带宽），最终报出 0.1~0.2 MB/s。
 * 用户看到的就是「优选出来的 IP 全都只有 0.1~0.9 MB/s」。
 *
 * ## 三个口径的关系（必须钉住）
 *
 *   avg（含预热与握手） < steady（丢预热后时长加权均值） < peak（单窗口峰值）
 *
 * 对外报 steady；peak 只作诊断（真机实测单窗口突发能把峰值翻倍：2.46 vs 1.14）。
 */
import { describe, expect, it } from 'vitest'
import { WindowMeter } from '../src/scan/true-probe'

/** 按「每窗口给一批字节」模拟一条慢启动 + 稳态的链路 */
function feedCurve(meter: WindowMeter, startAt: number, curve: number[], windowMs = 500): number {
  let now = startAt
  for (const mbps of curve) {
    meter.add(Math.round((mbps * 1024 * 1024 * windowMs) / 1000))
    now += windowMs
    meter.tick(now)
  }
  return now
}

describe('WindowMeter（测速口径）', () => {
  it('稳态均值略高于整段平均、明显低于窗口峰值（预热被丢弃）', () => {
    const startAt = 1_000_000
    const meter = new WindowMeter({ startedAt: startAt, warmupMs: 1000, windowMs: 500 })
    // 前 4 窗口（2s）慢启动 0.2~0.3，后 8 窗口稳态 1.0
    const curve = [0.2, 0.25, 0.3, 0.25, 0.6, 0.8, 0.9, 1.0, 1.0, 1.0, 1.0, 1.0]
    const endNow = feedCurve(meter, startAt, curve)
    meter.finish(endNow)

    const avg = meter.totalBytes / 1024 / 1024 / ((endNow - startAt) / 1000)
    expect(avg).toBeLessThan(0.75) // 老口径 ≈ 0.69
    // 预热只占整段 1/6，所以「丢预热」的收益是个位数百分比 ——
    // 真正把数值抬起来的是「串行化 + 多连接」，这里只钉住方向正确。
    expect(meter.steadyMBps).toBeGreaterThan(avg)
    expect(meter.steadyMBps).toBeLessThan(meter.peakMBps) // 但不过度乐观
    expect(meter.peakMBps).toBeGreaterThan(0.95)
  })

  it('单个窗口突发不会把稳态值拉高（这正是用 steady 而不用 peak 的原因）', () => {
    const startAt = 0
    const meter = new WindowMeter({ startedAt: startAt, warmupMs: 1000, windowMs: 500 })
    // 预热 2 窗口，之后 10 个稳态窗口都是 0.5，只有一个是 2.5 的突发
    const curve = [0.2, 0.2, 0.5, 0.5, 2.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    const endNow = feedCurve(meter, startAt, curve)
    meter.finish(endNow)

    // 峰值被突发顶到 2.5，但稳态应该停留在 ~0.7（(2.5+0.5*9)/10）
    expect(meter.peakMBps).toBeGreaterThan(2.0)
    expect(meter.steadyMBps).toBeGreaterThan(0.6)
    expect(meter.steadyMBps).toBeLessThan(0.9)
  })

  it('快速链路在预热期内就传完：用整段速率兜底，不能是 0', () => {
    const startAt = 0
    const meter = new WindowMeter({ startedAt: startAt, warmupMs: 1000, windowMs: 500 })
    // 300ms 内下完 15MB（≈50 MB/s），一个完整窗口都没结算
    meter.add(15 * 1024 * 1024)
    const peak = meter.finish(startAt + 300)
    expect(peak).toBeGreaterThan(40)
    expect(peak).toBeLessThan(60)
    // 稳态没有样本 → 退回峰值，绝不能报 0（否则会被当成「测速失败」）
    expect(meter.steadyMBps).toBe(peak)
  })

  it('没有任何数据时峰值为 0（不能被兜底逻辑编出数字）', () => {
    const meter = new WindowMeter({ startedAt: 0, warmupMs: 1000, windowMs: 500 })
    expect(meter.finish(2000)).toBe(0)
    expect(meter.steadyMBps).toBe(0)
    expect(meter.totalBytes).toBe(0)
  })

  it('总字节累计不受窗口结算影响', () => {
    const startAt = 0
    const meter = new WindowMeter({ startedAt: startAt, warmupMs: 0, windowMs: 500 })
    meter.add(1024)
    meter.tick(500)
    meter.add(2048)
    meter.tick(1000)
    expect(meter.totalBytes).toBe(3072)
    expect(meter.peakMBps).toBeGreaterThan(0)
  })

  it('实测曲线（真机 3 流 400ms 窗口）报稳态 ≈1.1 而非峰值 2.46', () => {
    const startAt = 0
    const meter = new WindowMeter({ startedAt: startAt, warmupMs: 1000, windowMs: 400 })
    // 2026-10-28 真机逐窗速率（3 条并行连接、400ms 窗口）
    const realCurve = [0.38, 0.42, 0.91, 0.43, 1.05, 1.63, 1.04, 1.05, 1.49, 1.4, 1.11, 2.46, 0.66]
    const endNow = feedCurve(meter, startAt, realCurve, 400)
    meter.finish(endNow)

    expect(meter.peakMBps).toBeGreaterThan(2.3) // 峰值被最后一个突发顶高
    expect(meter.steadyMBps).toBeGreaterThan(0.9)
    expect(meter.steadyMBps).toBeLessThan(1.5)
  })
})
