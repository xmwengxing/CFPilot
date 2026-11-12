/**
 * 并发池。
 *
 * 抽成独立模块是为了能单独测它 —— 扫描模块会拉进真实网络探测，
 * 单测里跑不动那些。
 */

/**
 * 并发池。
 *
 * @param shouldStop 可选的提前终止判定。返回 true 时不再领取新任务
 *   （已在跑的任务会跑完）。用于「已经拿到足够多的目标结果就收工」。
 *
 * ## ⚠️ 提前收工时会有**没跑到的项**
 *
 * 收工后那些项的槽位是空的。返回前必须过滤掉 ——
 * 否则调用方拿到的是带空洞的数组，一读元素属性就炸
 * （曾经真的炸过：`Cannot read properties of undefined (reading 'probe')`）。
 *
 * 过滤后**顺序不变**（第 i 个结果仍对应第 i 个输入），
 * 只是没跑到的项不再出现 —— 调用方只做遍历，不受影响。
 */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean
): Promise<R[]> {
  const slots: (R | undefined)[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (shouldStop?.()) return
      const index = cursor++
      if (index >= items.length) return
      slots[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  // 提前收工 → 有槽位是空的 → 过滤掉，别把 undefined 交给调用方
  return slots.filter((r): r is R => r !== undefined)
}
