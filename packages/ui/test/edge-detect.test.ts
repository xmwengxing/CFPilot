/**
 * 「检测部署状态」的实例选择逻辑单测。
 *
 * 防什么：
 *   1. 用户已经填了域名，检测却回填到另一个实例（改错对象比不改更糟）；
 *   2. 多实例时静默挑第一个、界面不给选择器（用户以为只有这一个）；
 *   3. 域名大小写 / 尾部点差异导致匹配失败。
 */
import { describe, it, expect } from 'vitest'
import { edgeInstanceLabel, pickEdgeInstance } from '../src/edge-detect'

const instances = [
  { workerName: 'relay-a', domain: 'a.example.com' },
  { workerName: 'relay-b', domain: 'b.example.com' },
]

describe('pickEdgeInstance', () => {
  it('域名优先：大小写与尾部点都不影响匹配', () => {
    expect(pickEdgeInstance(instances, { domain: 'B.Example.com.' }).instance?.workerName).toBe('relay-b')
  })

  it('域名匹配不到时按 Worker 名匹配', () => {
    expect(pickEdgeInstance(instances, { domain: 'nope.example.com', workerName: 'relay-a' }).instance?.workerName).toBe(
      'relay-a'
    )
  })

  it('只有一个实例时直接选中，不算歧义', () => {
    const one = [instances[0]!]
    expect(pickEdgeInstance(one)).toEqual({ instance: one[0], ambiguous: false })
  })

  it('多个实例且无提示时取第一个并标记 ambiguous', () => {
    const r = pickEdgeInstance(instances)
    expect(r.instance?.workerName).toBe('relay-a')
    expect(r.ambiguous).toBe(true)
  })

  it('空列表返回 null', () => {
    expect(pickEdgeInstance([])).toEqual({ instance: null, ambiguous: false })
  })
})

describe('edgeInstanceLabel', () => {
  it('带域名 / 不带域名两种文案', () => {
    expect(edgeInstanceLabel({ workerName: 'w', domain: 'r.example.com' })).toBe('w · r.example.com')
    expect(edgeInstanceLabel({ workerName: 'w', domain: '' })).toBe('w · 未绑定域名')
  })
})