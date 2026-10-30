/**
 * 自适应并发的边界。
 *
 * 成功率 < 40% 时并发减半，但**下限不能突破用户设置的最大并发** ——
 * 用户指定并发 2，结果自动升到 8，既是逻辑错误也是行为反直觉
 * （网络越差反而压得越狠）。
 */
import { describe, expect, it } from 'vitest'

import { poolAdaptive } from '../src/scan/scan'

interface ProbeResult {
  ok: boolean
}

/** 跑一批全失败的探测，返回观察到的峰值并发 */
async function peakFor(limit: number, ok: boolean): Promise<number> {
  let active = 0
  let peak = 0
  const items = Array.from({ length: 40 }, (_, i) => i)
  const out = await poolAdaptive<number, ProbeResult>(
    items,
    limit,
    async () => {
      active += 1
      peak = Math.max(peak, active)
      // 让出事件循环，确保并发真的重叠
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return { ok }
    },
    10
  )
  expect(out).toHaveLength(items.length)
  return peak
}

describe('poolAdaptive 并发边界', () => {
  it('成功率低时降并发，但不超过用户设置', async () => {
    for (const limit of [1, 2, 4, 6, 8, 16]) {
      const peak = await peakFor(limit, false)
      expect(peak, `并发上限 ${limit} 时峰值 ${peak}`).toBeLessThanOrEqual(limit)
    }
  })

  it('成功率低时确实至少保留 1 条并发', async () => {
    expect(await peakFor(1, false)).toBe(1)
  })

  it('成功率高时升并发，但不超过用户设置', async () => {
    for (const limit of [2, 4, 8]) {
      const peak = await peakFor(limit, true)
      expect(peak, `并发上限 ${limit} 时峰值 ${peak}`).toBeLessThanOrEqual(limit)
    }
  })
})
