/**
 * Workers 数据面部署原语的单元测试。
 *
 * 只测**纯逻辑**（zone 归属判定）：
 * 真正上传 / 绑域名要打真实 API，放在 live 测试里做，
 * 否则单测会变成「网络抖动即失败」的噪声源。
 */
import { describe, expect, it } from 'vitest'
import type { CloudflareClient } from '../src/deploy/cf-api'
import { resolveZoneForHost, WORKERS_COMPAT_DATE } from '../src/deploy/workers-deploy'

/** 只实现 listZones 的最小假客户端 */
function fakeClient(zones: Array<{ id: string; name: string }>): CloudflareClient {
  return { listZones: async () => zones } as unknown as CloudflareClient
}

const ZONES = [
  { id: 'z-example', name: 'example.com' },
  { id: 'z-sub', name: 'b.example.com' },
  { id: 'z-other', name: 'other.net' },
]

describe('resolveZoneForHost', () => {
  it('精确匹配顶点域名', async () => {
    const zone = await resolveZoneForHost(fakeClient(ZONES), 'example.com')
    expect(zone).toEqual({ id: 'z-example', name: 'example.com' })
  })

  it('子域按最长后缀匹配（不能命中更短的顶点域）', async () => {
    const zone = await resolveZoneForHost(fakeClient(ZONES), 'w1.b.example.com')
    expect(zone?.id).toBe('z-sub')
  })

  it('单层子域命中顶点域', async () => {
    const zone = await resolveZoneForHost(fakeClient(ZONES), 'w1.example.com')
    expect(zone?.id).toBe('z-example')
  })

  it('大小写与空白不影响判定', async () => {
    const zone = await resolveZoneForHost(fakeClient(ZONES), '  W1.Example.COM ')
    expect(zone?.id).toBe('z-example')
  })

  it('不在任何 zone 下时返回 null（调用方据此拒绝绑定）', async () => {
    const zone = await resolveZoneForHost(fakeClient(ZONES), 'w1.unknown.org')
    expect(zone).toBeNull()
  })

  it('相似但不同后缀的域名不能被误判', async () => {
    // notexample.com 以 example.com 结尾但不是它的子域
    const zone = await resolveZoneForHost(fakeClient(ZONES), 'notexample.com')
    expect(zone).toBeNull()
  })
})

describe('WORKERS_COMPAT_DATE', () => {
  it('必须是可复现的固定日期（不能是当天）', () => {
    expect(WORKERS_COMPAT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(WORKERS_COMPAT_DATE).not.toBe(new Date().toISOString().slice(0, 10))
  })
})
