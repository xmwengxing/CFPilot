import { describe, expect, it } from 'vitest'
import { detectIPv6Env, isGlobalUnicastIPv6 } from '../src/scan/ipv6-env'

const LOCAL = { address: '240e:37c:1c18:7d01::4bf', interfaceName: '以太网' }
const CANARY = ['2606:4700:3035:1111::1', '2606:4700:3030:2222::1']

describe('isGlobalUnicastIPv6', () => {
  it('放行公网全局单播', () => {
    expect(isGlobalUnicastIPv6('240e:37c:1c18:7d01::4bf')).toBe(true)
    expect(isGlobalUnicastIPv6('2606:4700:3035::ac43:91f1')).toBe(true)
    expect(isGlobalUnicastIPv6('2400:cb00:2049:1::a29f:21')).toBe(true)
  })

  it('带 %zone 后缀也能识别', () => {
    expect(isGlobalUnicastIPv6('240e:37c::1%以太网')).toBe(true)
  })

  it('拒绝链路本地 / 唯一本地 / 环回 / 组播 / IPv4 映射', () => {
    expect(isGlobalUnicastIPv6('fe80::6664:4aff:fe8b:741c')).toBe(false)
    expect(isGlobalUnicastIPv6('fd7a:115c:a1e0::1')).toBe(false) // 虚拟组网常用 ULA
    expect(isGlobalUnicastIPv6('fc00::1')).toBe(false)
    expect(isGlobalUnicastIPv6('::1')).toBe(false)
    expect(isGlobalUnicastIPv6('::')).toBe(false)
    expect(isGlobalUnicastIPv6('ff02::1')).toBe(false)
    expect(isGlobalUnicastIPv6('::ffff:1.2.3.4')).toBe(false)
  })

  it('拒绝文档地址与 Teredo（2001::/32 落在 2000::/3 内但不可用）', () => {
    expect(isGlobalUnicastIPv6('2001:db8::1')).toBe(false)
    expect(isGlobalUnicastIPv6('2001::1')).toBe(false) // 真机上被污染的 AAAA 就长这样
  })

  it('拒绝 IPv4 与非地址串', () => {
    expect(isGlobalUnicastIPv6('1.2.3.4')).toBe(false)
    expect(isGlobalUnicastIPv6('not-an-ip')).toBe(false)
  })
})

describe('IPv6 环境预检', () => {
  const base = {
    localProbe: () => LOCAL,
    routeProbe: async () => true as boolean | null,
    canaryProbe: async () => true,
    canary: CANARY,
  }

  it('三态齐全时判定为 ok', async () => {
    const r = await detectIPv6Env(base)
    expect(r.status).toBe('ok')
    expect(r.address).toBe(LOCAL.address)
    expect(r.interfaceName).toBe(LOCAL.interfaceName)
    expect(r.canaryTried).toBe(CANARY.length)
    expect(r.canaryOk).toBe(CANARY.length)
    expect(r.advice).toEqual([])
    expect(r.message).toContain('IPv6 环境可用')
  })

  it('没有公网地址 → no-address，且带固定前缀的用户提示', async () => {
    const r = await detectIPv6Env({ ...base, localProbe: () => null })
    expect(r.status).toBe('no-address')
    expect(r.canaryTried).toBe(0)
    expect(r.message).toContain('当前网络环境不具备 IPv6 测速条件')
    expect(r.advice.length).toBeGreaterThan(0)
  })

  it('有地址但没有默认路由 → no-route', async () => {
    const r = await detectIPv6Env({ ...base, routeProbe: async () => false })
    expect(r.status).toBe('no-route')
    expect(r.hasDefaultRoute).toBe(false)
    expect(r.canaryTried).toBe(0) // 路由都没有，不必再浪费一轮金丝雀
    expect(r.message).toContain('当前网络环境不具备 IPv6 测速条件')
  })

  it('路由判定失败（null）不阻断，继续做金丝雀', async () => {
    const r = await detectIPv6Env({ ...base, routeProbe: async () => null })
    expect(r.status).toBe('ok')
    expect(r.hasDefaultRoute).toBeNull()
  })

  it('金丝雀全失败 → no-internet（这正是「有地址但国际链路不通」的情形）', async () => {
    const r = await detectIPv6Env({ ...base, canaryProbe: async () => false })
    expect(r.status).toBe('no-internet')
    expect(r.canaryTried).toBe(CANARY.length)
    expect(r.canaryOk).toBe(0)
    expect(r.message).toContain('当前网络环境不具备 IPv6 测速条件')
    expect(r.advice.join(' ')).toContain('TUN')
  })

  it('金丝雀部分成功即放行', async () => {
    let n = 0
    const r = await detectIPv6Env({ ...base, canaryProbe: async () => n++ === 0 })
    expect(r.status).toBe('ok')
    expect(r.canaryOk).toBe(1)
  })

  it('没有金丝雀地址时只用「地址 + 路由」判定', async () => {
    const r = await detectIPv6Env({ ...base, canary: [] })
    expect(r.status).toBe('ok')
    expect(r.canaryTried).toBe(0)
    expect(r.message).toContain('未做金丝雀探测')
  })

  it('预检失败不产生任何观测（本函数只读，不写档案）', async () => {
    // 通过类型约束锁住：返回值里没有任何可写观测的字段
    const r = await detectIPv6Env({ ...base, localProbe: () => null })
    expect(Object.keys(r).sort()).toEqual(
      ['address', 'advice', 'canaryOk', 'canaryTried', 'elapsedMs', 'hasDefaultRoute', 'interfaceName', 'message', 'status'].sort(),
    )
  })
})
