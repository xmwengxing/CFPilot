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
