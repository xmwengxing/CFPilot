/**
 * 阶段二「提前收工」不能崩 —— 回归测试。
 *
 * ## 症状
 *
 * 带 `--countries` 跑扫描，阶段二跑到一半直接崩掉，没有任何结果输出：
 *
 * ```
 *   101 校验 108/500
 * 出错：Cannot read properties of undefined (reading 'probe')
 * ```
 *
 * ## 根因
 *
 * 带国家筛选时会**提前收工**：命中数够了就不再领新任务。
 * 而并发池预分配了 `items.length` 个槽位 —— 没跑到的项，槽位是空的。
 * 随后 `for (const item of wsAll)` 遍历时，**空洞会被当成 undefined 迭代出来**，
 * 读它的 `.probe` 就炸了。
 *
 * ⚠️ 洞口只有 `for...of` / `for` 索引遍历才会踩到 ——
 *    `filter` / `forEach` / `map` 会**跳过空洞** ✓（所以只测 filter 会漏掉这个 bug）。
 *
 * 触发条件很挑：必须带 `--countries`（才有提前收工），
 * 且必须真的提前收工（探测超时放宽后更容易凑够阈值）——
 * 所以默认参数下跑一百次都不一定碰到。
 */
import { describe, expect, it } from 'vitest'
import { pool } from '../src/scan/pool'

describe('阶段二提前收工', () => {
  it('提前收工后遍历结果不该出现 undefined（否则读属性就炸）', async () => {
    const items = Array.from({ length: 500 }, (_, i) => i)
    let matched = 0
    const earlyExitTarget = 45

    const results = await pool(
      items,
      8,
      async () => {
        // 前 45 个命中，其余不命中
        if (matched < earlyExitTarget) matched++
        return { probe: { ok: matched <= earlyExitTarget } }
      },
      () => matched >= earlyExitTarget
    )

    // ⚠️ 用 for...of 遍历 —— 空洞只有这种遍历才会踩到
    const seen: Array<{ probe?: { ok: boolean } }> = []
    for (const item of results) {
      expect(item).not.toBeUndefined()
      seen.push(item)
    }
    expect(seen.length).toBeGreaterThan(0)
    // 读属性不能炸 —— 这正是崩溃点
    expect(() => {
      for (const item of seen) {
        if (item.probe?.ok) continue
      }
    }).not.toThrow()
    expect(seen.filter((r) => r.probe?.ok).length).toBeGreaterThan(0)
  })

  it('不提前收工时结果数量与输入一致（顺序也不变）', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    const results = await pool(items, 4, async (item) => ({ probe: { ok: true }, item }))
    expect(results.length).toBe(items.length)
    // 第 i 个结果对应第 i 个输入
    expect(results.map((r) => r.item)).toEqual(items)
  })
})
