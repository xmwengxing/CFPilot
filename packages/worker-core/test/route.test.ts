/**
 * 出站选路测试。
 *
 * 这些用例守护的是旧自研实现踩过的坑：
 * ① 优选 IP 库里全是 Cloudflare 网段 → 每次拨号必然失败
 * ② 同区域过滤写错 → 代理被全部滤掉
 * ③ 异常被吞 → 失败无法诊断
 */
import { describe, expect, it } from 'vitest'
import {
  buildRouteCandidates,
  classifyDialFailure,
  explainDialFailure,
  groupCandidates,
  isCloudflareIpv4,
  type RouteCandidate,
} from '../src/outbound/route'

describe('Cloudflare 网段判定', () => {
  it('识别 CF 自家 IP', () => {
    for (const ip of [
      '1.1.1.1',
      '1.0.0.1',
      '104.16.0.1',
      '104.16.7.1',
      '172.64.0.1',
      '162.158.0.1',
      '188.114.96.5',
      '104.31.4.1',
      '131.0.72.1',
      '192.0.0.1',
    ]) {
      expect(isCloudflareIpv4(ip), ip).toBe(true)
    }
  })

  it('第三方 IP 不误判', () => {
    for (const ip of [
      '8.8.8.8',
      '9.9.9.9',
      '1.2.3.4',
      '208.67.222.222',
      '172.32.0.1',
      '162.160.0.1', // 162.158.0.0/15 之外的下一段
      '139.130.4.5',
      '104.32.0.1', // 104.24.0.0/14 之外的下一段
    ]) {
      expect(isCloudflareIpv4(ip), ip).toBe(false)
    }
  })

  it('非 IP 输入返回 false', () => {
    expect(isCloudflareIpv4('example.com')).toBe(false)
    expect(isCloudflareIpv4('not-an-ip')).toBe(false)
    expect(isCloudflareIpv4('999.1.1.1')).toBe(false)
    expect(isCloudflareIpv4('')).toBe(false)
  })

  it('网段边界正确（不吞相邻网段）', () => {
    // 104.16.0.0/13 覆盖 104.16.0.0 – 104.23.255.255
    expect(isCloudflareIpv4('104.23.255.255')).toBe(true)
    expect(isCloudflareIpv4('104.24.0.0')).toBe(true) // 属于 104.24.0.0/14
    expect(isCloudflareIpv4('104.15.255.255')).toBe(false)
    expect(isCloudflareIpv4('104.32.0.0')).toBe(false)
  })
})

describe('候选列表构建', () => {
  const base = { targetHost: 'example.com', targetPort: 443 }

  it('代理候选优先于直连与优选', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: 'proxy.example', port: 1080, kind: 'socks5' }],
      optimizedIps: [{ ip: '8.8.8.8', port: 443 }],
    })
    expect(list[0]!.source).toBe('proxy')
    expect(list[0]!.via?.kind).toBe('socks5')
  })

  it('SOCKS5 与 HTTP 代理都要保留（旧实现把它们全滤掉了）', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [
        { host: 's1.example', port: 1080, kind: 'socks5' },
        { host: 'h1.example', port: 8080, kind: 'http' },
      ],
    })
    const kinds = list.filter((c) => c.source === 'proxy').map((c) => c.via?.kind)
    expect(kinds).toContain('socks5')
    expect(kinds).toContain('http')
  })

  it('优选 IP 里 Cloudflare 网段的被降权到末尾', () => {
    const list = buildRouteCandidates({
      ...base,
      optimizedIps: [
        { ip: '104.16.0.1', port: 443 },
        { ip: '9.9.9.9', port: 443 },
      ],
    })
    const optimized = list.filter((c) => c.source === 'optimized')
    expect(optimized[0]!.host).toBe('9.9.9.9')
    expect(optimized[optimized.length - 1]!.host).toBe('104.16.0.1')
    expect(optimized[optimized.length - 1]!.deprioritized).toBe(true)
  })

  it('目标是 Cloudflare 网段时直连候选被降权', () => {
    const list = buildRouteCandidates({ targetHost: '104.16.0.1', targetPort: 443 })
    const direct = list.find((c) => c.source === 'direct')!
    expect(direct.deprioritized).toBe(true)
  })

  it('候选顺序：代理 → 直连 → 优选（除非被降权）', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: 'p.example', port: 1080, kind: 'socks5' }],
      optimizedIps: [{ ip: '9.9.9.9', port: 443 }],
    })
    const order = list.map((c: RouteCandidate) => c.source)
    expect(order[0]).toBe('proxy')
    expect(order.indexOf('direct')).toBeLessThan(order.indexOf('optimized'))
  })

  it('没有代理时第一个是直连目标', () => {
    const list = buildRouteCandidates(base)
    expect(list[0]!.source).toBe('direct')
    expect(list[0]!.host).toBe('example.com')
  })

  it('ProxyIP 用 direct 语义（连到该地址由它转发）', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: '1.2.3.4', port: 443, kind: 'direct' }],
    })
    expect(list[0]!.via?.kind).toBe('direct')
    expect(list[0]!.host).toBe('1.2.3.4')
  })

  it('重复候选被去重', () => {
    const list = buildRouteCandidates({
      ...base,
      optimizedIps: [
        { ip: '9.9.9.9', port: 443 },
        { ip: '9.9.9.9', port: 443 },
      ],
    })
    expect(list.filter((c) => c.host === '9.9.9.9')).toHaveLength(1)
  })

  it('HTTPS 代理被保留并标注为 https 类型', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: 'p.example', port: 8443, kind: 'https' }],
    })
    const proxy = list.find((c) => c.source === 'proxy')!
    expect(proxy.via?.kind).toBe('https')
    expect(proxy.label).toContain('HTTPS')
  })

  it('ProxyIP 即使落在 Cloudflare 网段也不降权（用户显式配置）', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: '104.16.0.1', port: 443, kind: 'direct' }],
    })
    const proxy = list.find((c) => c.source === 'proxy')!
    expect(proxy.deprioritized).toBeFalsy()
    // 仍然排在直连候选之前
    expect(list[0]!.source).toBe('proxy')
  })

  it('同权重候选保持稳定顺序（可复现）', () => {
    // ⚠️ Array.prototype.sort 对长度 > 10 的数组用非稳定排序，
    // 会让竞速时「谁先试」变得随机，排查时无法复现。
    const ips = Array.from({ length: 20 }, (_, i) => ({ ip: `9.9.9.${i + 1}`, port: 443 }))
    const first = buildRouteCandidates({ ...base, optimizedIps: ips })
    const second = buildRouteCandidates({ ...base, optimizedIps: ips })
    expect(first.map((c) => c.host)).toEqual(second.map((c) => c.host))
    // 相对顺序与输入一致
    const optimizedHosts = first.filter((c) => c.source === 'optimized').map((c) => c.host)
    expect(optimizedHosts).toEqual(ips.map((i) => i.ip))
  })
})

describe('失败分类与可诊断性', () => {
  it('平台拒绝识别为 blocked', () => {
    const f = classifyDialFailure(
      new Error('proxy request failed, cannot connect to the specified address. It looks like you might be trying to connect to a HTTP-based service'),
      '直连 example.com:443'
    )
    expect(f.kind).toBe('blocked')
    expect(explainDialFailure(f)).toContain('Cloudflare 自家网段')
    expect(explainDialFailure(f)).toContain('直连 example.com:443')
  })

  it('TCP Loop 措辞同样识别为 blocked', () => {
    const f = classifyDialFailure(new Error('TCP Loop detected'), 'x')
    expect(f.kind).toBe('blocked')
  })

  it('超时识别为 timeout', () => {
    const f = classifyDialFailure(new Error('连接超时：example.com:443'), '直连 example.com:443')
    expect(f.kind).toBe('timeout')
    expect(explainDialFailure(f)).toContain('example.com:443')
  })

  it('其它错误保留原始信息', () => {
    const f = classifyDialFailure(new Error('证书校验失败'), 'x')
    expect(f.kind).toBe('other')
    expect(explainDialFailure(f)).toContain('证书校验失败')
  })

  it('非 Error 对象也能处理', () => {
    const f = classifyDialFailure('字符串错误', 'x')
    expect(f.kind).toBe('other')
    expect(f.message).toBe('字符串错误')
  })
})

describe('候选分组（代理与直连必须互斥）', () => {
  const base = { targetHost: 'example.com', targetPort: 443 }

  it('配置代理时代理与直连被分到不同组', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: 'p.example', port: 1080, kind: 'socks5' }],
      optimizedIps: [{ ip: '9.9.9.9', port: 443 }],
    })
    const groups = groupCandidates(list)
    expect(groups.landing).toHaveLength(1)
    expect(groups.landing[0]!.via?.kind).toBe('socks5')
    // 直连与优选都在 direct 组，**不在** 代理组
    expect(groups.direct.map((c) => c.source)).toEqual(['direct', 'optimized'])
    expect(groups.direct.every((c) => c.source !== 'proxy')).toBe(true)
  })

  it('无代理时代理组为空', () => {
    const list = buildRouteCandidates(base)
    const groups = groupCandidates(list)
    expect(groups.landing).toHaveLength(0)
    expect(groups.proxyIp).toHaveLength(0)
    expect(groups.direct).toHaveLength(1)
  })

  it('降权候选单独成组，不与正常候选混在一起', () => {
    const list = buildRouteCandidates({
      ...base,
      targetHost: '104.16.0.1',
      optimizedIps: [{ ip: '9.9.9.9', port: 443 }],
    })
    const groups = groupCandidates(list)
    expect(groups.fallback.length).toBeGreaterThan(0)
    expect(groups.fallback.every((c) => c.deprioritized)).toBe(true)
    expect(groups.direct.every((c) => !c.deprioritized)).toBe(true)
    expect(groups.landing.every((c) => !c.deprioritized)).toBe(true)
  })

  it('多个落地代理都在 landing 组内', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [
        { host: 's1.example', port: 1080, kind: 'socks5' },
        { host: 'h1.example', port: 8080, kind: 'http' },
        { host: 'x1.example', port: 8443, kind: 'https' },
      ],
    })
    const groups = groupCandidates(list)
    expect(groups.landing).toHaveLength(3)
    expect(groups.landing.map((c) => c.via?.kind)).toEqual(['socks5', 'http', 'https'])
  })
})

describe('ProxyIP 与落地代理必须分开（2026-10-28 修）', () => {
  const base = { targetHost: 'example.com', targetPort: 443 }

  it('ProxyIP（kind=direct）与 SOCKS5 分到不同组', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [
        { host: '1.2.3.4', port: 443, kind: 'direct' }, // ProxyIP
        { host: 's1.example', port: 1080, kind: 'socks5' },
      ],
    })
    const groups = groupCandidates(list)
    expect(groups.proxyIp).toHaveLength(1)
    expect(groups.proxyIp[0]!.via?.kind).toBe('direct')
    expect(groups.landing).toHaveLength(1)
    expect(groups.landing[0]!.via?.kind).toBe('socks5')
  })

  it('两者绝不混在同一组（否则 ProxyIP 的 1 RTT 必然赢过 SOCKS5 的 2~3 RTT）', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [
        { host: '1.2.3.4', port: 443, kind: 'direct' },
        { host: 's1.example', port: 1080, kind: 'socks5' },
        { host: 'h1.example', port: 8080, kind: 'http' },
      ],
    })
    const groups = groupCandidates(list)
    // 每组内部互不重叠
    const landingHosts = groups.landing.map((c) => c.host)
    const proxyIpHosts = groups.proxyIp.map((c) => c.host)
    expect(landingHosts.some((h) => proxyIpHosts.includes(h))).toBe(false)
    expect(groups.landing.length + groups.proxyIp.length).toBe(3)
  })

  it('只有 ProxyIP 时它落在 proxyIp 组', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: '1.2.3.4', port: 443, kind: 'direct' }],
    })
    const groups = groupCandidates(list)
    expect(groups.proxyIp).toHaveLength(1)
    expect(groups.landing).toHaveLength(0)
  })
})

describe('直连降权（目标域名解析到 CF 网段时）', () => {
  const base = { targetHost: 'example.com', targetPort: 443 }

  it('默认不降权直连', () => {
    const list = buildRouteCandidates(base)
    expect(list.find((c) => c.source === 'direct')!.deprioritized).toBeFalsy()
  })

  it('deprioritizeDirect 为真时直连被降权', () => {
    const list = buildRouteCandidates({ ...base, deprioritizeDirect: true })
    const direct = list.find((c) => c.source === 'direct')!
    expect(direct.deprioritized).toBe(true)
  })

  it('降权后非 CF 网段的优选 IP 排在直连之前', () => {
    const list = buildRouteCandidates({
      ...base,
      deprioritizeDirect: true,
      optimizedIps: [
        { ip: '34.223.124.45', port: 80 }, // 非 CF
        { ip: '172.66.147.243', port: 80 }, // CF 网段
      ],
    })
    const order = list.map((c) => c.host)
    expect(order.indexOf('34.223.124.45')).toBeLessThan(order.indexOf('example.com'))
    // CF 网段的优选 IP 应排在最后
    expect(order[order.length - 1]).toBe('172.66.147.243')
  })

  it('目标是 CF 网段 IP 时直连仍降权（与新参数无关）', () => {
    const list = buildRouteCandidates({ targetHost: '104.16.0.1', targetPort: 443 })
    expect(list.find((c) => c.source === 'direct')!.deprioritized).toBe(true)
  })

  it('降权不影响代理候选的优先级（代理仍在最前）', () => {
    const list = buildRouteCandidates({
      ...base,
      deprioritizeDirect: true,
      proxies: [{ host: 'p.example', port: 1080, kind: 'socks5' }],
    })
    expect(list[0]!.source).toBe('proxy')
  })
})
