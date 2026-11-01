import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNetworkProfile,
  loadNetworkProfile,
  normalizeNetworkProfile,
  saveNetworkProfile,
  updateNetworkProfile,
  type ProfileStoreDocument,
} from '../src/scan/network-profile'
import { resolveCandidates } from '../src/scan/candidates'

const temporary = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'cfpilot-adaptive-')), 'network.json')

describe('自适应采样（实验性）', () => {
  it('默认不启用时行为与旧路径一致', async () => {
    const cidr = ['104.16.1.0/30']
    const { expandCidrs } = await import('../src/scan/ip-ranges')
    expect(await resolveCandidates({ cidr, sample: 10, seed: 42, family: 'v4' })).toEqual(
      expandCidrs(cidr, { sample: 10, seed: 42, neutral: false }),
    )
  })

  it('开启后学习到的成功率会影响网段分配', async () => {
    // 104.16.1.0/24 历史上一直失败 → 权重下降；104.24.0.0/24 一直成功 → 权重上升。
    const profile = normalizeNetworkProfile({ isp: 'ct', region: '福建', access: 'fixed', family: 'ipv4' })
    const observations: ProfileStoreDocument['observations'] = {}
    // 池子要够大：集中度上限是「每个 /24 最多取 候选数 × 5%」，
    // 网段太少时上限会把两边都卡成一样多，权重就看不出差别了。
    const good: string[] = [], bad: string[] = []
    for (let index = 0; index < 64; index++) {
      const goodPrefix = `104.24.${index}.0/24`
      const badPrefix = `104.16.${index}.0/24`
      good.push(goodPrefix)
      bad.push(badPrefix)
      observations[`g${index}`] = { profileId: profile.id, prefix: goodPrefix, stage: 'ws', attempts: 100, successes: 100, failures: {}, updatedAt: Date.now() }
      observations[`b${index}`] = { profileId: profile.id, prefix: badPrefix, stage: 'ws', attempts: 100, successes: 0, failures: { timeout: 100 }, updatedAt: Date.now() }
    }
    const store: ProfileStoreDocument = { version: 1, profiles: { [profile.id]: profile }, observations }
    const picked = await resolveCandidates({
      cidr: [...good, ...bad],
      sample: 4000,
      seed: 7,
      family: 'v4',
      profile: store,
      adaptiveSampling: { profileId: profile.id, explorationRate: 0.1 },
    })
    const goodCount = picked.filter((ip) => ip.startsWith('104.24.')).length
    const badCount = picked.filter((ip) => ip.startsWith('104.16.')).length
    expect(goodCount).toBeGreaterThan(badCount * 3)
  })

  it('零权重网段默认不进候选，显式开启探索才会出现', async () => {
    const profile = normalizeNetworkProfile({ isp: 'cu', region: '广东', access: 'fixed', family: 'ipv4' })
    const store: ProfileStoreDocument = { version: 1, profiles: { [profile.id]: profile }, observations: {} }
    const opts = {
      cidr: ['103.22.200.0/24', '104.16.1.0/24'],
      sample: 200,
      seed: 11,
      family: 'v4' as const,
      profile: store,
      adaptiveSampling: { profileId: profile.id, explorationRate: 0.2 },
    }
    const normal = await resolveCandidates(opts)
    expect(normal.every((ip) => !ip.startsWith('103.22.'))).toBe(true)
    const explored = await resolveCandidates({ ...opts, adaptiveSampling: { ...opts.adaptiveSampling, includeZeroWeight: true } })
    expect(explored.some((ip) => ip.startsWith('103.22.'))).toBe(true)
  })

  it('观测写回档案并能再次读出（本地文件往返）', async () => {
    const file = await temporary()
    const store = createNetworkProfile('ct-福建-fixed', 1000)
    const profileId = Object.keys(store.profiles)[0]!
    const updated = updateNetworkProfile(
      store,
      [
        { ip: '104.16.1.2', ok: true, latencyMs: 42, at: 1000 },
        { ip: '104.16.1.3', ok: false, error: 'timeout', at: 1000 },
      ],
      1000,
    )
    await saveNetworkProfile(file, updated)
    const loaded = await loadNetworkProfile(file, 'ct-福建-fixed')
    const observations = Object.values(loaded.observations)
    expect(observations.length).toBeGreaterThan(0)
    expect(observations.some((item) => item.prefix === '104.16.1.0/24')).toBe(true)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['observations', 'profiles', 'version'])
  })
})
