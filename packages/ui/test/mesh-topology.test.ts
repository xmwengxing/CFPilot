/**
 * 拓扑展示态判定单测。
 *
 * 防什么：空态动画与浮层文案的判据被改坏 ——
 *   未启动却显示「等待对端」、或者有对端时浮层还盖在画布上。
 */
import { describe, it, expect } from 'vitest'
import { resolveTopoPhase } from '../src/mesh-topology'

describe('resolveTopoPhase', () => {
  it('未启动且无对端 → offline', () => {
    expect(resolveTopoPhase(false, 0)).toBe('offline')
  })
  it('已启动但无对端 → waiting', () => {
    expect(resolveTopoPhase(true, 0)).toBe('waiting')
  })
  it('有对端 → active（不管服务状态如何，有数据就画链路）', () => {
    expect(resolveTopoPhase(true, 2)).toBe('active')
    expect(resolveTopoPhase(false, 1)).toBe('active')
  })
})