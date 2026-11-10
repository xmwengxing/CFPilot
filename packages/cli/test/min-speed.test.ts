/**
 * 下行速度下限（`--min-speed`）的淘汰逻辑。
 *
 * CLI 是权威实现（AGENTS.md §2.2），Go 版
 * packages/desktop/internal/scan/scan.go 用同一组输入做对照。
 *
 * 核心约束：
 *   1. 判据是**稳态**速度（`speed`），不是峰值（`peakMBps`）；
 *   2. 过滤发生在「取前 N」**之前** —— 被淘汰的候选本可以补位；
 *   3. 下限为 0 时不过滤（默认行为完全不变）。
 */
import { describe, expect, it } from 'vitest'
import { filterByMinSpeed } from '../src/scan/scan'

interface Row {
  ip: string
  speed: number
  peakMBps?: number
}

const rows = (list: Row[]): Row[] => list

describe('filterByMinSpeed', () => {
  it('下限为 0 时原样返回（不过滤）', () => {
    const input = rows([
      { ip: '104.16.0.1', speed: 0.05 },
      { ip: '104.16.0.2', speed: 12.3 },
    ])
    expect(filterByMinSpeed(input, 0)).toEqual(input)
  })

  it('淘汰稳态速度低于下限的候选', () => {
    const input = rows([
      { ip: '104.16.0.1', speed: 0.4 },
      { ip: '104.16.0.2', speed: 3.2 },
      { ip: '104.16.0.3', speed: 0.9 },
    ])
    expect(filterByMinSpeed(input, 1).map((r) => r.ip)).toEqual(['104.16.0.2'])
  })

  it('恰好等于下限的候选保留（闭区间）', () => {
    const input = rows([{ ip: '104.16.0.1', speed: 1 }])
    expect(filterByMinSpeed(input, 1)).toHaveLength(1)
  })

  it('用稳态值判定，不被峰值带偏', () => {
    // 稳态 0.5 但峰值 12 —— 偶然冲高，不能因此留下
    const input = rows([{ ip: '104.16.0.1', speed: 0.5, peakMBps: 12 }])
    expect(filterByMinSpeed(input, 1)).toHaveLength(0)
  })

  it('负下限视为不过滤', () => {
    const input = rows([{ ip: '104.16.0.1', speed: 0 }])
    expect(filterByMinSpeed(input, -1)).toEqual(input)
  })

  it('全部低于下限时返回空数组（不是保留原列表）', () => {
    const input = rows([{ ip: '104.16.0.1', speed: 0.1 }])
    expect(filterByMinSpeed(input, 5)).toHaveLength(0)
  })
})
