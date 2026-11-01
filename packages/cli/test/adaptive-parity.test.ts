import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { exploreBudget, learnedPrefixWeight, prefixCap } from '../src/scan/candidates_adaptive'
import type { ProfileStoreDocument } from '../src/scan/network-profile'

/**
 * 跨语言一致性校验（CLI 一侧）。
 *
 * 夹具 testdata/adaptive-parity.json 同时被桌面版
 * （packages/desktop/internal/scan/adaptive_parity_test.go）使用：
 * 两端必须对同一份输入算出**同一组权重**，
 * 否则同一个网络档案在两端会得出不同的网段权重，历史就失去意义。
 */
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'testdata', 'adaptive-parity.json')

interface ParityFixture {
  profileId: string
  now: string
  halfLifeHours: number
  observations: Array<{
    prefix: string
    stage: 'tcp' | 'tls' | 'ws' | 'speed'
    attempts: number
    successes: number
    updatedAt: string
  }>
  prefixes: string[]
  contract: {
    sampleCount: number
    explorationRate: number
    maxPrefixShare: number
    exploreBudget: number
    capPerPrefix: number
  }
  expectedWeights: Record<string, number>
}

describe('自适应采样跨语言一致性', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ParityFixture
  const store: ProfileStoreDocument = {
    version: 1,
    profiles: {
      [fixture.profileId]: {
        id: fixture.profileId,
        isp: 'ct',
        region: '福建',
        access: 'fixed',
        family: 'ipv4',
        source: 'manual',
        confidence: 1,
        updatedAt: Date.parse(fixture.now),
      },
    },
    observations: Object.fromEntries(
      fixture.observations.map((item) => [
        `${fixture.profileId}|${item.prefix}|${item.stage}`,
        { profileId: fixture.profileId, prefix: item.prefix, stage: item.stage, attempts: item.attempts, successes: item.successes, failures: {}, updatedAt: Date.parse(item.updatedAt) },
      ]),
    ),
  }
  const now = Date.parse(fixture.now)
  const halfLifeMs = fixture.halfLifeHours * 60 * 60 * 1000

  it('两端对同一份档案算出同一组权重', () => {
    for (const prefix of fixture.prefixes) {
      const weight = learnedPrefixWeight(prefix, store, fixture.profileId, now, halfLifeMs)
      expect(weight, prefix).toBeCloseTo(fixture.expectedWeights[prefix]!, 6)
    }
  })

  it('两端的采样策略口径一致（探索配额 / 集中度上限）', () => {
    expect(exploreBudget(fixture.contract.sampleCount, fixture.contract.explorationRate)).toBe(fixture.contract.exploreBudget)
    expect(prefixCap(fixture.contract.sampleCount, fixture.contract.maxPrefixShare)).toBe(fixture.contract.capPerPrefix)
  })
})
