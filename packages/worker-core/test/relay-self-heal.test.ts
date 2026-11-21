import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isTlsFatalAlert } from '../src/protocols/websocket-self'
import {
  clearRelayCache,
  collectRelayEndpoints,
  fetchDynamicRelayFeed,
  parseRelayFeedText,
} from '../src/outbound/relay'

const NL = String.fromCharCode(10)

describe('TLS Fatal Alert 识别（反代假活/拒转快速换路）', () => {
  it('识别 7 字节 TLS Fatal Alert（alert 40 / 80 / 112）', () => {
    expect(isTlsFatalAlert(new Uint8Array([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]))).toBe(true)
    expect(isTlsFatalAlert(new Uint8Array([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x50]))).toBe(true)
    expect(isTlsFatalAlert(new Uint8Array([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x70]))).toBe(true)
  })

  it('不误判正常 ServerHello（0x16）与 Warning Alert（level 0x01）', () => {
    expect(isTlsFatalAlert(new Uint8Array([0x16, 0x03, 0x03, 0x00, 0x50, 0x02, 0x00]))).toBe(false)
    expect(isTlsFatalAlert(new Uint8Array([0x15, 0x03, 0x03, 0x00, 0x02, 0x01, 0x00]))).toBe(false)
    expect(isTlsFatalAlert(new Uint8Array([0x15, 0x03, 0x03]))).toBe(false)
  })
})

describe('动态反代清单解析与缓存', () => {
  beforeEach(() => {
    clearRelayCache()
    vi.restoreAllMocks()
  })

  it('过滤注释、非法行、CF 官方网段并去重', () => {
    const text = [
      '# header comment',
      '216.36.82.11 # good',
      '104.16.1.1',
      '172.64.10.2',
      '137.184.228.85:8443',
      '216.36.82.11',
      'not-an-ip',
    ].join(NL)
    const parsed = parseRelayFeedText(text)
    expect(parsed.map((r) => `${r.ip}:${r.port}`)).toEqual([
      '216.36.82.11:443',
      '137.184.228.85:8443',
    ])
  })

  it('动态清单成功拉取后缓存在内存，且排在用户自配之后、内置兜底之前', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(['# feed', '198.51.100.88', '203.0.113.99', ''].join(NL), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const list1 = await collectRelayEndpoints({
      userEntries: '9.9.9.9',
      useBuiltin: true,
      useRemoteFeed: true,
      feedUrl: 'https://example.invalid/relay-ips.txt',
    })
    expect(list1[0]!.ip).toBe('9.9.9.9')
    expect(list1[1]!.ip).toBe('198.51.100.88')
    expect(list1[2]!.ip).toBe('203.0.113.99')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const list2 = await fetchDynamicRelayFeed('https://example.invalid/relay-ips.txt')
    expect(list2.map((r) => r.ip)).toEqual(['198.51.100.88', '203.0.113.99'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('动态清单拉取失败时静默降级到内置表并退避', async () => {
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const list = await collectRelayEndpoints({
      useBuiltin: true,
      useRemoteFeed: true,
      feedUrl: 'https://example.invalid/relay-ips.txt',
    })
    expect(list.length).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const retry = await fetchDynamicRelayFeed('https://example.invalid/relay-ips.txt')
    expect(retry).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
