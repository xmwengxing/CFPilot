/**
 * `/__diag` 限流桶：窗口重置必须同时清空 FIFO 数组。
 *
 * ## 守护的缺陷（Gemini 审计 P2-2）
 *
 * `diagBucket` 在 60 秒窗口到期时只 `diagFailuresByIp.clear()`，没有清
 * `diagBucketOrder`。历史上千个 IP 会一直留在数组里，之后每来一个新 IP
 * 都会先弹出早已过期的旧键 —— 淘汰顺序与当前窗口的活跃计数不再对应，
 * 正常运维请求会被误判 / 误删。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearDiagBuckets, diagBucketOrderSize, routeDataPlane } from '../src/routes/data'
import type { Env } from '../src/types'

const UUID = '11111111-2222-3333-4444-555555555555'
const env = { UUID } as Env

function badTokenReq(ip: string): Request {
  return new Request('https://dp.example.com/__diag', {
    headers: { 'x-cfpilot-token': 'wrong', 'CF-Connecting-IP': ip },
  })
}

beforeEach(() => {
  clearDiagBuckets()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('诊断限流窗口重置', () => {
  it('窗口到期后 FIFO 数组一并清空（不残留历史 IP）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      await routeDataPlane(badTokenReq(ip), env)
    }
    expect(diagBucketOrderSize()).toBe(3)

    // 跨过一个完整窗口
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    await routeDataPlane(badTokenReq('4.4.4.4'), env)

    // 新窗口里只应有本轮这一个桶（旧实现会残留 3 个 + 新增 1 个 = 4）
    expect(diagBucketOrderSize()).toBe(1)
  })

  it('同一窗口内同一 IP 只占一个桶', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    for (let i = 0; i < 3; i++) await routeDataPlane(badTokenReq('5.5.5.5'), env)
    expect(diagBucketOrderSize()).toBe(1)
  })
})
