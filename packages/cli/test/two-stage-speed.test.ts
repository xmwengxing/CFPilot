/**
 * 两轮测速：「全量短测粗排 → 前 N 精测」的选人逻辑。
 *
 * CLI 是权威实现（AGENTS.md §2.2），Go 版
 * packages/desktop/internal/scan/two_stage_test.go 用同一组输入做对照。
 *
 * 核心约束：粗测数值只用于排序，绝不写进 ScanEntry —— 对外速度必须由
 * 后续的 6s × 8 连接精测给出，否则两轮口径混在一起不可比。
 */
import { describe, expect, it } from 'vitest'
import { COARSE_SPEED_DEFAULTS, rankByCoarseSpeed } from '../src/scan/scan'

const item = (ip: string) => ({ ip })
const ips = (rows: Array<{ ip: string }>) => rows.map((r) => r.ip)

describe('rankByCoarseSpeed', () => {
  it('按粗测速度降序，而不是阶段二的 TLS / 延迟顺序', () => {
    const candidates = [item('104.16.0.1'), item('172.66.0.1'), item('188.114.1.1')]
    const coarse = new Map([
      ['104.16.0.1', 0.2],
      ['172.66.0.1', 2.5],
      ['188.114.1.1', 1.1],
    ])
    expect(ips(rankByCoarseSpeed(candidates, coarse, 3))).toEqual([
      '172.66.0.1',
      '188.114.1.1',
      '104.16.0.1',
    ])
  })

  it('粗测全失败时保持阶段二顺序（候选不足上限则整批返回）', () => {
    const candidates = [item('104.16.0.1'), item('104.16.0.2'), item('172.66.0.1')]
    expect(ips(rankByCoarseSpeed(candidates, new Map(), 3))).toEqual([
      '104.16.0.1',
      '104.16.0.2',
      '172.66.0.1',
    ])
  })

  it('未粗测 / 粗测失败的候选排在有速度候选之后，不会挤掉好 IP', () => {
    const candidates = [item('104.16.0.1'), item('172.66.0.1')]
    const coarse = new Map([['172.66.0.1', 1.0]])
    expect(ips(rankByCoarseSpeed(candidates, coarse, 2))).toEqual([
      '172.66.0.1',
      '104.16.0.1',
    ])
  })

  it('保持 /16 多样性：同段四条最快也不会独占精测名额', () => {
    const candidates = [
      item('104.16.0.1'), item('104.16.0.2'), item('104.16.0.3'), item('104.16.0.4'),
      item('172.66.0.1'), item('188.114.1.1'),
    ]
    const coarse = new Map([
      ['104.16.0.1', 9], ['104.16.0.2', 8], ['104.16.0.3', 7], ['104.16.0.4', 6],
      ['172.66.0.1', 2], ['188.114.1.1', 1],
    ])
    expect(ips(rankByCoarseSpeed(candidates, coarse, 3))).toEqual([
      '104.16.0.1',
      '172.66.0.1',
      '188.114.1.1',
    ])
  })

  it('limit 大于候选数时返回全部', () => {
    const candidates = [item('104.16.0.1'), item('172.66.0.1')]
    expect(rankByCoarseSpeed(candidates, new Map(), 30)).toHaveLength(2)
  })

  it('粗筛默认参数与 Go 版 defCoarse* 逐项一致', () => {
    expect(COARSE_SPEED_DEFAULTS).toMatchObject({
      limit: 120,
      durationMs: 1200,
      warmupMs: 300,
      windowMs: 300,
      connections: 2,
      timeoutMs: 3000,
      budgetMs: 240000,
    })
  })
})
