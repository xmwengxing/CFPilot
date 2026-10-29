/**
 * 优选结果排序：/16 网段多样性。
 *
 * ## 背景（GPT 优选器审计 2026-10-29）
 *
 * Cloudflare 的好 IP 高度集中在少数 /16（实测 104.16–104.19 占了大半）。
 * 直接切前 N 名，经常得到「同一个 /16 的 N 个 IP」—— 它们走同一段路由、
 * 同一个入口，一旦那段拥塞或被 QoS，用户手上整批节点同时失效，没有备选。
 *
 * 现在改为按 /16 轮流取：保速度排序的同时保证覆盖多个网段。
 */
import { describe, expect, it } from 'vitest'
import { pickWithDiversity } from '../src/scan/scan'

const item = (ip: string, speed: number): { ip: string; speed: number } => ({ ip, speed })

describe('pickWithDiversity', () => {
  it('多个 /16 时轮流取，而不是取同一个段的前 N 名', () => {
    const ranked = [
      item('104.16.0.1', 9),
      item('104.16.0.2', 8),
      item('104.16.0.3', 7),
      item('172.66.0.1', 6),
      item('172.66.0.2', 5),
      item('188.114.1.1', 4),
    ]
    const picked = pickWithDiversity(ranked, 4)
    expect(picked.map((p) => p.ip)).toEqual([
      '104.16.0.1',
      '172.66.0.1',
      '188.114.1.1',
      '104.16.0.2',
    ])
  })

  it('只有一个 /16 时行为与直接截取一致', () => {
    const ranked = [item('104.16.0.1', 9), item('104.16.0.2', 8), item('104.16.0.3', 7)]
    expect(pickWithDiversity(ranked, 2).map((p) => p.ip)).toEqual(['104.16.0.1', '104.16.0.2'])
  })

  it('候选不足时有多少给多少', () => {
    const ranked = [item('104.16.0.1', 9), item('172.66.0.1', 8)]
    expect(pickWithDiversity(ranked, 8)).toHaveLength(2)
  })

  it('top<=0 返回空列表', () => {
    expect(pickWithDiversity([item('104.16.0.1', 9)], 0)).toEqual([])
  })

  it('桶内仍按传入顺序（即速度降序）', () => {
    const ranked = [
      item('104.16.0.1', 9),
      item('104.17.0.1', 8),
      item('104.16.0.2', 7),
      item('104.17.0.2', 6),
    ]
    expect(pickWithDiversity(ranked, 4).map((p) => p.ip)).toEqual([
      '104.16.0.1',
      '104.17.0.1',
      '104.16.0.2',
      '104.17.0.2',
    ])
  })
})

// ---------------------------------------------------------------------------
// 中性采样（--neutral-sampling）
//
// 权重表是在**某一台机器**的网络下测出来的：别的网络环境里，
// 被我压低的网段同样可能出好 IP（用户实测 172.64/13 出过 9.3 MB/s）。
// 中性采样忽略权重、按网段大小等比抽取，只保留「TCP 层不可达」的 0 权重段。
// ---------------------------------------------------------------------------

import { expandCidrs, cidrWeight } from '../src/scan/ip-ranges'

describe('中性采样', () => {
  it('忽略权重：大网段拿到明显更多候选', () => {
    const weighted = expandCidrs(['104.16.0.0/13', '172.64.0.0/13'], { sample: 400, seed: 7 })
    const neutral = expandCidrs(['104.16.0.0/13', '172.64.0.0/13'], { sample: 400, seed: 7, neutral: true })
    const count64 = (list: string[]) => list.filter((ip) => ip.startsWith('172.64.') || ip.startsWith('172.6')).length
    // 两段大小相同（都是 /13），中性采样下数量应接近
    expect(Math.abs(count64(neutral) - (neutral.length - count64(neutral)))).toBeLessThan(neutral.length * 0.35)
    // 加权采样下 172.64 明显更少（权重 0.55 < 1）
    expect(count64(weighted)).toBeLessThan(count64(neutral))
  })

  it('TCP 不可达的网段仍然被排除', () => {
    const list = expandCidrs(['104.16.0.0/13', '198.41.128.0/17'], { sample: 200, seed: 3, neutral: true })
    expect(list.some((ip) => ip.startsWith('198.41.'))).toBe(false)
  })

  it('172.64 段权重已上调（实测该段可出高速节点）', () => {
    expect(cidrWeight('172.64.0.0/13')).toBeGreaterThanOrEqual(0.5)
  })
})
