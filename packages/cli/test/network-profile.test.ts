import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyFailureDetailed, createNetworkProfile, loadNetworkProfile, mergeProfileStores, networkBucket, normalizeNetworkProfile, normalizeRegion, OBSERVATION_CAPACITY, saveNetworkProfile, updateNetworkProfile } from '../src/scan/network-profile'
import { adaptivePool, learnedPrefixWeight } from '../src/scan/candidates_adaptive'
import { resolveCandidates } from '../src/scan/candidates'
import { expandCidrs } from '../src/scan/ip-ranges'
const observation = (store: ReturnType<typeof createNetworkProfile>) => Object.values(store.observations)[0]!
const temporary = async () => join(await mkdtemp(join(tmpdir(), 'cfpilot-profile-')), 'network.json')

describe('本地网络档案', () => {
  it('规范化网络身份并使用标准前缀桶', () => {
    expect(networkBucket('104.16.1.2')).toBe('104.16.1.0/24')
    expect(networkBucket('[2606:4700:10::1]')).toBe('2606:4700:10::/48')
    expect(networkBucket('2606:4700::1')).toBe(networkBucket('2606:4700:0:0:0:0:0:1'))
    expect(networkBucket('999.1.2.3')).toBe('')
    expect(networkBucket('edge.example')).toBe('')
    expect(normalizeNetworkProfile({ isp: ' ISP ', region: ' CN ', access: 'WiFi', confidence: 2 }).id).toBe(normalizeNetworkProfile({ isp: 'isp', region: 'cn', access: 'wifi', source: 'manual' }).id)
  })
  it('地区归一化：不同写法落到同一个档案', () => {
    expect(normalizeRegion('福建')).toBe('福建')
    expect(normalizeRegion(' 福建 ')).toBe('福建')
    expect(normalizeRegion('福建省')).toBe('福建')
    expect(normalizeRegion('闽')).toBe('福建')
    expect(normalizeRegion('内蒙古自治区')).toBe('内蒙古')
    expect(normalizeRegion('')).toBe('')
    // 不同写法必须得到同一个档案 ID，否则历史被切碎
    expect(normalizeNetworkProfile({ isp: 'ct', region: '福建省', access: 'fixed', family: 'ipv4' }).id)
      .toBe(normalizeNetworkProfile({ isp: 'ct', region: '闽', access: 'fixed', family: 'ipv4' }).id)
  })
  it('合并另一个档案库的样本（桌面版与 CLI 互通）', () => {
    const base = updateNetworkProfile(createNetworkProfile('ct-福建-fixed', 1000), [
      { ip: '104.16.1.1', ok: true, stage: 'ws', at: 1000 },
    ], 1000)
    const extra = updateNetworkProfile(createNetworkProfile('ct-广东-fixed', 2000), [
      { ip: '104.16.2.1', ok: true, stage: 'ws', at: 2000 },
    ], 2000)
    const merged = mergeProfileStores(base, extra)
    expect(Object.keys(merged.profiles).length).toBe(2)
    expect(Object.keys(merged.observations).length).toBe(2)
    // 同键时取较新的一条（updatedAt 更晚的那条胜出）
    const newer = updateNetworkProfile(base, [
      { ip: '104.16.1.1', ok: false, stage: 'ws', at: 5000 },
    ], 5000)
    const merged2 = mergeProfileStores(base, newer)
    const sameKey = Object.values(merged2.observations).find((item) => item.prefix === '104.16.1.0/24')!
    expect(sameKey.updatedAt).toBe(5000)
  })
  it('失败分类提供稳定类型和重试建议', () => {    expect(classifyFailureDetailed('socket timed out')).toMatchObject({ kind: 'timeout', retryable: true })
    expect(classifyFailureDetailed('ECONNREFUSED')).toMatchObject({ kind: 'refused', retryable: false })
    expect(classifyFailureDetailed('', 503)).toMatchObject({ kind: 'http', retryable: true })
  })
  it('真正半衰减计数与失败，不反复衰减同一段时间', () => {
    const first = updateNetworkProfile(createNetworkProfile('wifi', 1000), [{ ip: '104.16.1.2', ok: false, error: 'timeout', at: 1000 }], 1000)
    const second = updateNetworkProfile(first, [{ ip: '104.16.1.3', ok: true, at: 2000 }], 2000, 1000)
    expect(observation(second)).toMatchObject({ attempts: 1.5, successes: 1, failures: { timeout: 0.5 }, updatedAt: 2000 })
    const third = updateNetworkProfile(second, [{ ip: '104.16.1.4', ok: true, at: 2000 }], 2000, 1000)
    expect(observation(third).attempts).toBe(2.5)
    const late = updateNetworkProfile(third, [{ ip: '104.16.1.5', ok: true, at: 1000 }], 1500, 1000)
    expect(observation(late).updatedAt).toBe(2000)
    expect(observation(late).attempts).toBe(3)
    expect(Object.values(late.profiles)[0]!.updatedAt).toBe(2000)
  })
  it('阶段只记录已执行的尝试，取消与非法地址不计数', () => {
    const store = updateNetworkProfile(createNetworkProfile('wifi', 0), [
      { ip: '104.16.1.1', stage: 'tcp', ok: true, at: 0 },
      { ip: '104.16.1.1', stage: 'tls', ok: false, at: 0 },
      { ip: '104.16.1.1', stage: 'ws', ok: false, failure: classifyFailureDetailed('cancelled'), at: 0 },
      { ip: '999.1.1.1', ok: true },
    ], 0)
    expect(Object.values(store.observations).map((item) => item.stage).sort()).toEqual(['tcp', 'tls'])
  })
  it('失败历史随半衰期回到静态先验，零探索严格生效', () => {
    const store = updateNetworkProfile(createNetworkProfile('wifi', 0), Array.from({ length: 100 }, () => ({ ip: '104.16.1.1', ok: false, at: 0 })), 0)
    const profileId = Object.keys(store.profiles)[0]!
    // 104.16.1.0/24 静态权重 0.9，被历史判死后权重应明显低于没有历史的 104.24.0.0/24（0.95）
    const fresh = learnedPrefixWeight('104.16.1.0/24', store, profileId, 0, 1000)
    const clean = learnedPrefixWeight('104.24.0.0/24', store, profileId, 0, 1000)
    expect(fresh).toBeLessThan(clean / 5)
    // 半衰期过后历史淡出 → 权重回到静态先验
    const faded = learnedPrefixWeight('104.16.1.0/24', store, profileId, 100000, 1000)
    expect(faded).toBeGreaterThan(fresh)
    expect(faded).toBeCloseTo(0.9, 6)
  })
  it('零权重只占显式探索预算且不会重复抽样', () => {
    const profile = createNetworkProfile('wifi', 0)
    const profileId = Object.keys(profile.profiles)[0]!
    // 103.22.200.0/24 在权重表里是 0（实测 TCP 层就不通）
    const zero = '103.22.200.0/24'
    const picked = adaptivePool([zero, '104.16.2.0/24'], 2, false, false, () => 0, profile, {
      explorationRate: 0, now: 0, profileId,
    })
    expect(picked.every((item) => !item.ip.startsWith('103.22.'))).toBe(true)

    const explored = adaptivePool([zero, '104.16.2.0/24'], 2, true, false, () => 0, profile, {
      explorationRate: 1, now: 0, profileId,
    })
    expect(new Set(explored.map((item) => item.ip)).size).toBe(explored.length)
    expect(explored).toHaveLength(2)
  })
  it('只写统一 envelope 并完成原子保存往返', async () => {
    const file = await temporary(), store = updateNetworkProfile(createNetworkProfile('wifi', 1), [{ ip: '104.16.1.1', ok: true, at: 1 }], 1)
    await saveNetworkProfile(file, store)
    expect(await loadNetworkProfile(file, 'other-network')).toEqual(store)
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort()).toEqual(['observations', 'profiles', 'version'])
  })
  it('迁移旧 CLI 并拒绝损坏或未知版本，不重新标记其它网络', async () => {
    const file = await temporary()
    await writeFile(file, JSON.stringify({ version: 1, networkKey: 'old-wifi', updatedAt: 20, buckets: { 'v4:104.16.1/24': { attempts: 4, successes: 1, updatedAt: 10 } } }))
    const store = await loadNetworkProfile(file, 'new-wifi')
    expect(Object.values(store.profiles)[0]!.isp).toBe('old-wifi')
    expect(observation(store)).toMatchObject({ prefix: '104.16.1.0/24', stage: 'tcp', attempts: 4, successes: 1, failures: { unknown: 3 } })
    await writeFile(file, '{')
    await expect(loadNetworkProfile(file, 'wifi')).rejects.toThrow()
    await writeFile(file, JSON.stringify({ version: 99 }))
    await expect(loadNetworkProfile(file, 'wifi')).rejects.toThrow('版本')
  })
  it('迁移旧阶段聚合档案而不伪造未执行阶段', async () => {
    const file = await temporary(), profile = Object.values(createNetworkProfile('wifi', 0).profiles)[0]!
    await writeFile(file, JSON.stringify({ profiles: { [profile.id]: profile }, observations: { old: { profileId: profile.id, prefix: '104.16.1.0/24', tcpAttempts: 5, tcpSuccess: 4, tlsAttempts: 2, tlsSuccess: 1, lastTestAt: '2026-01-01T00:00:00Z' } } }))
    const loaded = await loadNetworkProfile(file, 'wifi')
    expect(Object.values(loaded.observations).map((item) => item.stage).sort()).toEqual(['tcp', 'tls'])
  })
  it('载入清洗坏值、孤儿、重复记录并限制容量', async () => {
    const file = await temporary(), store = createNetworkProfile('wifi', 0), profileId = Object.keys(store.profiles)[0]!
    const observations = Object.fromEntries(Array.from({ length: OBSERVATION_CAPACITY + 2 }, (_, index) => [String(index), { profileId, prefix: `104.${Math.floor(index / 256)}.${index % 256}.0/24`, stage: 'tcp', attempts: 4, successes: 50, failures: { timeout: 10, bad: 4 }, latencyMs: -1, updatedAt: index }]))
    observations.orphan = { ...observations['1']!, profileId: 'missing' }
    await writeFile(file, JSON.stringify({ ...store, observations }))
    const loaded = await loadNetworkProfile(file, 'wifi'), values = Object.values(loaded.observations)
    expect(values).toHaveLength(OBSERVATION_CAPACITY)
    expect(values.every((item) => item.successes === 4 && Object.keys(item.failures).length === 0 && item.latencyMs === undefined)).toBe(true)
    expect(Math.min(...values.map((item) => item.updatedAt))).toBe(2)
  })
  it('多网络档案不自动混用历史', () => {
    const store = updateNetworkProfile(createNetworkProfile('wifi', 0), [{ ip: '104.16.1.1', ok: true, at: 0 }], 0)
    const other = Object.values(createNetworkProfile('other', 0).profiles)[0]!
    store.profiles[other.id] = other
    // 只用「wifi」档案的历史：104.16.1.0/24 有成功记录，权重应高于无记录的 104.16.2.0/24
    const profileId = Object.keys(store.profiles).find((id) => id !== other.id)!
    const picked = adaptivePool(['104.16.1.0/24', '104.16.2.0/24'], 1, false, false, () => 0, store, {
      explorationRate: 0, now: 0, profileId,
    })
    expect(picked[0]!.ip.startsWith('104.16.1.')).toBe(true)
  })
})

describe('自适应候选集', () => {
  it('默认候选路径完全保持原 expandCidrs 行为', async () => {
    const cidr = ['104.16.1.0/28', '104.16.1.0/29']
    expect(await resolveCandidates({ cidr, sample: 10, seed: 42, family: 'v4' })).toEqual(expandCidrs(cidr, { sample: 10, seed: 42, neutral: false }))
  })
  it('自适应合并重叠网段、保留小网段范围且填满有限容量', async () => {
    const opts = { cidr: ['104.16.1.0/30', '104.16.1.0/31', '104.16.1.0/30'], sample: 20, seed: 42, profile: createNetworkProfile('wifi', 0) }
    const selected = await resolveCandidates(opts)
    // 与桌面版一致：剔除 .0 与 .255 结尾的地址（网络号 / 广播号的通用规则）
    expect(selected.sort()).toEqual(['104.16.1.1', '104.16.1.2', '104.16.1.3'])
    expect(await resolveCandidates(opts)).toEqual(await resolveCandidates(opts))
  })
  it('零权重网段必须显式开启探索且不占利用预算', async () => {
    const opts = { cidr: ['103.22.200.0/30', '104.16.1.0/30'], sample: 8, seed: 42, profile: createNetworkProfile('wifi', 0) }
    expect((await resolveCandidates(opts)).every((ip) => ip.startsWith('104.16.'))).toBe(true)
    const selected = await resolveCandidates({ ...opts, adaptiveSampling: { includeZeroWeight: true, explorationRate: 0.5 } })
    expect(selected.some((ip) => ip.startsWith('103.22.'))).toBe(true)
    expect(new Set(selected).size).toBe(selected.length)
  })
})
