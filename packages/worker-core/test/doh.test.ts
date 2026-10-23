/**
 * DoH 优选 IP 解析测试。
 *
 * 守护的是归档实现与现实现的关键约定：
 * ① TXT 记录里的社区优选 IP 库优先于 A / AAAA
 * ② 解析结果**不**在这里过滤 Cloudflare 网段 —— 降权是 route.ts 的职责
 * ③ 解析失败不能抛异常（不能阻断出站）
 */
import { describe, expect, it } from 'vitest'
import {
  clearDnsCache,
  isIpLiteral,
  parseTxtIps,
  resolveEndpointIps,
  splitHostPort,
} from '../src/outbound/doh'

describe('splitHostPort', () => {
  it('解析 host:port', () => {
    expect(splitHostPort('1.2.3.4:443', 80)).toEqual({ host: '1.2.3.4', port: 443 })
  })

  it('缺省端口时使用默认值', () => {
    expect(splitHostPort('example.com', 443)).toEqual({ host: 'example.com', port: 443 })
  })

  it('IPv6 带方括号', () => {
    expect(splitHostPort('[2606:4700::1]:443', 80)).toEqual({ host: '2606:4700::1', port: 443 })
  })

  it('裸 IPv6 不按端口切分', () => {
    expect(splitHostPort('2606:4700::1', 443)).toEqual({ host: '2606:4700::1', port: 443 })
  })

  it('空串返回原样', () => {
    expect(splitHostPort('', 443)).toEqual({ host: '', port: 443 })
  })
})

describe('isIpLiteral', () => {
  it('识别 IPv4 与 IPv6 字面量', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true)
    expect(isIpLiteral('2606:4700::1')).toBe(true)
  })

  it('域名不是字面量', () => {
    expect(isIpLiteral('example.com')).toBe(false)
    expect(isIpLiteral('')).toBe(false)
  })
})

describe('parseTxtIps', () => {
  it('解析逗号分隔的 IP 列表', () => {
    const result = parseTxtIps('"1.2.3.4,5.6.7.8"', 443)
    expect(result).toEqual([
      { hostname: '1.2.3.4', port: 443 },
      { hostname: '5.6.7.8', port: 443 },
    ])
  })

  it('解析带端口的条目', () => {
    const result = parseTxtIps('1.2.3.4:8080,5.6.7.8', 443)
    expect(result).toEqual([
      { hostname: '1.2.3.4', port: 8080 },
      { hostname: '5.6.7.8', port: 443 },
    ])
  })

  it('处理转义逗号（\\010）', () => {
    const result = parseTxtIps('1.2.3.4\\0105.6.7.8', 443)
    expect(result.map((r) => r.hostname)).toEqual(['1.2.3.4', '5.6.7.8'])
  })

  it('哨兵 @edgetunnel 返回空', () => {
    expect(parseTxtIps('@edgetunnel', 443)).toEqual([])
  })

  it('非 IP 内容被忽略', () => {
    expect(parseTxtIps('hello world', 443)).toEqual([])
  })

  it('空串返回空数组', () => {
    expect(parseTxtIps('', 443)).toEqual([])
  })

  it('SPF 记录不被误当成优选 IP 库', () => {
    // ⚠️ 真实样例（实测）：目标域名的 TXT 绝大多数不是优选库。
    // 若把 SPF 里的 ip4: 指令当成优选 IP，所有出站都会被悄悄导向那个 IP。
    expect(parseTxtIps('"v=spf1 ip4:1.2.3.4 -all"', 443)).toEqual([])
    expect(parseTxtIps('"v=spf1 include:_spf.google.com ~all"', 443)).toEqual([])
    expect(parseTxtIps('"v=spf1 -all"', 443)).toEqual([])
  })

  it('域名验证记录不被误当成优选 IP 库', () => {
    expect(parseTxtIps('"canva-site-verification=oOyaVnHC-OiFoR1BPvetNA"', 443)).toEqual([])
    expect(parseTxtIps('"google-site-verification=BGYWMGmMapwHpaj8kW5SNItcLefH74b1mrUN2zk_8aE"', 443)).toEqual([])
    expect(parseTxtIps('"MS=6BF03E6AF5CB689E315FB6199603BABF2C88D805"', 443)).toEqual([])
  })

  it('纯数字串不算 IP 列表', () => {
    expect(parseTxtIps('"20210615"', 443)).toEqual([])
    expect(parseTxtIps('"_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9"', 443)).toEqual([])
  })

  it('IP 与非 IP 混合的记录整体判为非优选库', () => {
    // 严格判定：不能「部分采用」，否则会得到一个残缺的优选池
    expect(parseTxtIps('"1.2.3.4,hello"', 443)).toEqual([])
  })
})

describe('resolveEndpointIps', () => {
  it('IP 字面量直接返回自身，不发起 DoH 请求', async () => {
    clearDnsCache()
    const result = await resolveEndpointIps('8.8.8.8', 443)
    expect(result).toEqual([{ hostname: '8.8.8.8', port: 443 }])
  })

  it('IPv6 字面量直接返回自身', async () => {
    clearDnsCache()
    const result = await resolveEndpointIps('2606:4700::1', 443)
    expect(result).toEqual([{ hostname: '2606:4700::1', port: 443 }])
  })

  it('空域名返回空数组', async () => {
    clearDnsCache()
    expect(await resolveEndpointIps('', 443)).toEqual([])
  })

  it('DoH 不可用时返回空数组而不是抛异常', async () => {
    clearDnsCache()
    // 该域名刻意不存在，且测试环境不应有真实 DoH 可用性保证。
    // 关键断言：**不抛异常** —— 解析失败不能阻断出站（直连候选仍在）。
    const result = await resolveEndpointIps('this-domain-should-not-exist-cfpilot.invalid', 443)
    expect(Array.isArray(result)).toBe(true)
  })
})
