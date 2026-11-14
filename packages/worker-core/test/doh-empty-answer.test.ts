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

describe('A 记录多源聚合', () => {
  it('两家境外 DoH 返回不同 CDN 的 IP 时全部保留（不再第一家即停）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('cloudflare-dns.com')) {
          return jsonResponse({ Status: 0, Answer: [{ type: 1, data: '151.101.194.146' }] })
        }
        if (url.includes('dns.google')) {
          return jsonResponse({ Status: 0, Answer: [{ type: 1, data: '172.66.0.227' }] })
        }
        return jsonResponse({ Status: 0, Answer: [] })
      })
    )
    const result = await resolveEndpointIps('mixed.example', 443)
    expect(result).toEqual([
      { hostname: '151.101.194.146', port: 443 },
      { hostname: '172.66.0.227', port: 443 },
    ])
    // 并行问前两家，且不碰国内 DoH
    expect(calls.filter((u) => u.includes('type=A'))).toHaveLength(2)
    expect(calls.some((u) => u.includes('alidns') || u.includes('doh.pub'))).toBe(false)
  })

  it('两家都网络失败时回落串行兜底链路', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('cloudflare-dns.com') || url.includes('dns.google')) {
          return new Response('bad', { status: 502 })
        }
        return jsonResponse({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      })
    )
    const result = await resolveEndpointIps('fallback-a.example', 443)
    expect(result).toContainEqual({ hostname: '93.184.216.34', port: 443 })
    expect(calls.some((u) => u.includes('alidns') || u.includes('doh.pub'))).toBe(true)
  })
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
    // A 记录并行问前两家境外 DoH（多源聚合），但两家国内 DoH 完全不该被碰到
    expect(calls.filter((u) => u.includes('type=A'))).toHaveLength(2)
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
    // NXDOMAIN 是权威应答：A 只问前两家境外 DoH 并合并，不继续轮询国内
    expect(calls.filter((u) => u.includes('type=A'))).toHaveLength(2)
    expect(calls.some((u) => u.includes('alidns') || u.includes('doh.pub'))).toBe(false)
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

  it('同一域名的并发解析共用一个在途请求（singleflight，审计 B6）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        // 延迟一拍，确保 6 个并发解析都在首个完成前发起
        await new Promise((r) => setTimeout(r, 5))
        if (url.includes('type=TXT')) return jsonResponse({ Status: 0, Answer: [] })
        return jsonResponse({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      })
    )

    const results = await Promise.all(
      Array.from({ length: 6 }, () => resolveEndpointIps('concurrent.example', 443))
    )
    for (const r of results) expect(r).toContainEqual({ hostname: '93.184.216.34', port: 443 })
    // 6 并发共用一次解析：一次 TXT + 前两家 A（而非 6×3）
    expect(calls.filter((u) => u.includes('type=TXT'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('type=A'))).toHaveLength(2)
  })

  it('空应答短缓存：重复解析不再发 DoH（负缓存，审计 B14）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ Status: 3, Answer: [] }) // NXDOMAIN
      })
    )

    expect(await resolveEndpointIps('neg.example', 443)).toEqual([])
    const callsAfterFirst = calls.length
    expect(await resolveEndpointIps('neg.example', 443)).toEqual([])
    // 命中负缓存，无新请求
    expect(calls.length).toBe(callsAfterFirst)
  })
})
