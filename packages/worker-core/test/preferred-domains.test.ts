/**
 * 内置优选域名库 —— 回归测试。
 *
 * ## 为什么钉住这些具体域名
 *
 * 2026-10-28 真机实测：旧表 21 个域名里 **14 个已经废弃**（DNS 不解析、
 * 解析到 127.0.0.1、或根本不再指向 Cloudflare）。
 * 订阅里半个节点是这种废域名，客户端就表现为「优选出来的 IP 全部 -1」。
 *
 * 测法（与客户端行为等价）：`dns.resolve4` 必须落在 CF 网段，
 * 且 `tls.connect(域名IP:443, servername=<数据面域名>)` 后用数据面域名作 Host
 * 发 WebSocket 升级，**必须返回 101**。每个域名 2 轮，2/2 通过才收录。
 *
 * 所以这里断言：那 14 个死域名**不许回来**，实测通过的必须都在。
 * 哪天网络环境变了要改表，先跑一遍实测再改这里。
 */
import { describe, expect, it } from 'vitest'
import { PREFERRED_DOMAINS } from '../src/data/pools'

/** 实测已废弃的域名：DNS 失败 / 解析到非 CF / 解析到 127.0.0.1 */
const DEAD_DOMAINS = [
  'speed.marisalnc.com', // 解析到 172.104.x（Linode）
  'freeyx.cloudflare88.eu.org', // DNS 解析失败
  'cfip.cfcdn.vip', // 解析到 34.41.x（Google Cloud）
  'cf.zhetengsha.eu.org', // DNS 解析失败
  'cloudflare.9jy.cc', // DNS 解析失败
  'cf.zerone-cdn.pp.ua', // DNS 解析失败
  'cfip.1323123.xyz', // 解析到 127.0.0.1（被墙/污染）
  'cnamefuckxxs.yuchen.icu', // 解析到 195.85.x
  '115155.xyz', // DNS 解析失败
  'cname.xirancdn.us', // DNS 解析失败
  'f3058171cad.002404.xyz', // DNS 解析失败
  '8.889288.xyz', // DNS 解析失败
  'cdn.tzpro.xyz', // 解析到 127.0.0.1（被墙/污染）
  'cf.877771.xyz', // 解析到 117.41.x（不是 CF）
  // 下面两个是「看起来能用但实测不行」的候选：
  'time.cloudflare.com', // 解析到 162.159.200.x，但 WS 升级 8 秒超时
  'shopify.com', // 解析到 23.227.38.33，不是 CF
]

describe('PREFERRED_DOMAINS（内置优选域名库）', () => {
  it('不含已实测废弃的域名', () => {
    const present = DEAD_DOMAINS.filter((d) => PREFERRED_DOMAINS.includes(d))
    expect(present).toEqual([])
  })

  it('保留实测可用的大厂 / 社区域名', () => {
    // 抽样断言几个方向：大厂站点、社区优选池及其泛解析变体
    for (const domain of [
      'www.visa.com',
      'time.is',
      'ip.sb',
      'www.speedtest.net',
      'cf.090227.xyz',
      'node.cf.090227.xyz',
      'cloudflare.182682.xyz',
      'bestcf.top',
    ]) {
      expect(PREFERRED_DOMAINS).toContain(domain)
    }
  })

  it('全部是合法主机名且无重复', () => {
    const hostname = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/
    for (const domain of PREFERRED_DOMAINS) {
      expect(domain, `非法主机名：${domain}`).toMatch(hostname)
      expect(domain.includes('://'), `不该带协议：${domain}`).toBe(false)
    }
    expect(new Set(PREFERRED_DOMAINS).size).toBe(PREFERRED_DOMAINS.length)
  })

  it('规模在合理区间（订阅默认抽 10 个，池子太小会天天重复）', () => {
    expect(PREFERRED_DOMAINS.length).toBeGreaterThanOrEqual(20)
    expect(PREFERRED_DOMAINS.length).toBeLessThanOrEqual(60)
  })
})
