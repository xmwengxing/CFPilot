/**
 * DoH「空应答」必须立即短路 —— 晚高峰首包延迟回归测试。
 *
 * ## 守护的缺陷
 *
 * `queryAll()` 原先只在 `answers.length > 0` 时返回，把「服务器正常应答但
 * 该域名没有 TXT 优选库」当成查询失败，于是每个未命中缓存的新域名都要把
 * CF → 国内阿里 → 国内腾讯三家 DoH 串行问一遍。晚高峰海外节点回连国内
 * DoH 链路拥堵时，这一段直接变成几百毫秒到数秒的首包延迟。
 *
 * 这里钉住：空应答（NOERROR 无 Answer / NXDOMAIN / 无该类型记录）是
 * **权威结论**，只问第一家就该停；只有请求失败才继续尝试下一个 provider。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDnsCache, resolveEndpointIps } from '../src/outbound/doh'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
  })
}

let calls: string[] = []

beforeEach(() => {
  clearDnsCache()
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DoH 空应答短路', () => {
  it('TXT 无记录时只问第一家 DoH，不串行跨国内', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ Status: 0, Answer: [] })
      })
    )

    await resolveEndpointIps('no-txt.example', 443)

    const txtCalls = calls.filter((u) => u.includes('type=TXT'))
    expect(txtCalls).toHaveLength(1)
    expect(txtCalls[0]).toContain('cloudflare-dns.com')
    // A 分支同样只问第一家；两家国内 DoH 完全不该被碰到
    expect(calls.filter((u) => u.includes('type=A'))).toHaveLength(1)
    expect(calls.some((u) => u.includes('alidns') || u.includes('doh.pub'))).toBe(false)
  })

  it('NXDOMAIN 也是权威应答，不继续轮询', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ Status: 3, Answer: [] })
      })
    )

    const result = await resolveEndpointIps('nxdomain.example', 443)
    expect(result).toEqual([])
    expect(calls.filter((u) => u.includes('type=TXT'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('type=A'))).toHaveLength(1)
  })

  it('第一家失败时继续到海外的第二家，且不碰国内 DoH', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('cloudflare-dns.com')) return new Response('bad', { status: 502 })
        return jsonResponse({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      })
    )

    const result = await resolveEndpointIps('fallback.example', 443)
    expect(result).toContainEqual({ hostname: '93.184.216.34', port: 443 })
    expect(calls.some((u) => u.includes('dns.google'))).toBe(true)
    expect(calls.some((u) => u.includes('alidns') || u.includes('doh.pub'))).toBe(false)
  })

  it('所有 provider 都失败时不抛异常，返回空数组', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )

    await expect(resolveEndpointIps('all-down.example', 443)).resolves.toEqual([])
  })

  it('TXT 优选库仍优先于 A 记录（短路不能破坏既有功能）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('type=TXT')) {
          return jsonResponse({ Status: 0, Answer: [{ type: 16, data: '"1.2.3.4,5.6.7.8"' }] })
        }
        return jsonResponse({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      })
    )

    const result = await resolveEndpointIps('has-txt-pool.example', 443)
    expect(result).toEqual([
      { hostname: '1.2.3.4', port: 443 },
      { hostname: '5.6.7.8', port: 443 },
    ])
  })
})
