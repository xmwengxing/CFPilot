/**
 * 出口体检（unlock）
 *
 * 重点不是「能不能连上外网」，而是**判定语义**：
 * `region`（该地区没有片源）和 `blocked`（出口被拒）必须分开 ——
 * 用户看到的处置方式完全不同（换区 vs 换出口）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { clearUnlockCache, runUnlockProbe } from '../src/unlock'

function stubFetch(handler: (url: string) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => handler(String(input)))
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  clearUnlockCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('判定语义', () => {
  it('全部 200 → ok', async () => {
    stubFetch(() => new Response('loc=JP\n', { status: 200 }))
    const report = await runUnlockProbe('NRT', 'JP')
    expect(report.targets).toHaveLength(3)
    expect(report.targets.every((t) => t.verdict === 'ok')).toBe(true)
  })

  // 2026-10-30 线上实测得出的约束：只测**非 CF 网段**的目标。
  // chatgpt / claude 在 CF 网段里，fetch 会被 CF 自己应答（实测 1~29ms），
  // 测出来的东西与真实出口无关 —— 放进列表就是假数据。
  it('不探测 Cloudflare 网段的目标', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    const report = await runUnlockProbe('SJC', 'US')
    const ids = report.targets.map((t) => t.id)
    expect(ids).not.toContain('chatgpt')
    expect(ids).not.toContain('claude')
    expect(ids).toEqual(['netflix', 'youtube', 'gemini'])
  })

  it('Netflix 404 → region（该区没片源），不是 blocked', async () => {
    stubFetch((url) =>
      url.includes('netflix') ? new Response('', { status: 404 }) : new Response('loc=US\n', { status: 200 })
    )
    const report = await runUnlockProbe('LAX', 'US')
    const nf = report.targets.find((t) => t.id === 'netflix')!
    expect(nf.verdict).toBe('region')
  })

  it('403 → blocked', async () => {
    stubFetch(() => new Response('', { status: 403 }))
    const report = await runUnlockProbe('HKG', 'HK')
    expect(report.targets.every((t) => t.verdict === 'blocked')).toBe(true)
  })

  it('网络异常 → unknown + 短码，不抛错', async () => {
    stubFetch(() => {
      throw new Error('network down')
    })
    const report = await runUnlockProbe('HKG', 'HK')
    expect(report.targets.every((t) => t.verdict === 'unknown')).toBe(true)
    expect(report.targets.every((t) => t.error === 'fetch-failed')).toBe(true)
  })

  it('超时被归类为 timeout', async () => {
    stubFetch(() => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    })
    const report = await runUnlockProbe('HKG', 'HK')
    expect(report.targets.every((t) => t.error === 'timeout')).toBe(true)
  })
})

describe('缓存', () => {
  it('同一机房第二次调用命中缓存，不再打外部请求', async () => {
    const fn = stubFetch(() => new Response('loc=SG\n', { status: 200 }))
    const first = await runUnlockProbe('SIN', 'SG')
    expect(first.cached).toBe(false)
    const callsAfterFirst = fn.mock.calls.length
    expect(callsAfterFirst).toBe(3)

    const second = await runUnlockProbe('SIN', 'SG')
    expect(second.cached).toBe(true)
    expect(fn.mock.calls.length).toBe(callsAfterFirst)
  })

  it('不同机房各自独立缓存', async () => {
    const fn = stubFetch(() => new Response('loc=US\n', { status: 200 }))
    await runUnlockProbe('LAX', 'US')
    await runUnlockProbe('SJC', 'US')
    expect(fn.mock.calls.length).toBe(6)
  })
})
