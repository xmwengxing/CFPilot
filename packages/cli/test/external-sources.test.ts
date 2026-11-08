/**
 * Phase 2/3 回归：外部清单解析、SSRF 防护、条件请求、镜像回退、
 * 单源失败隔离、轻量校验闸门，以及跨语言配置契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SYNC_RUNS,
  SOURCES_FILENAME,
  loadSources,
  parseSources,
  serializeSources,
  withSources,
  makeSource,
  sourcesPath,
} from '../src/sources/config'
import {
  SOURCE_MAX_BYTES,
  fetchSourceText,
  sanitizeUrl,
  validateSourceUrl,
} from '../src/sources/fetch'
import { parseSourcePayload, toCandidateInputs } from '../src/sources/normalizer'
import { syncSources, type SourceFetcher } from '../src/sources/manager'
import { lightCheckCandidates } from '../src/sources/light'
import { parsePool, readPoolRaw, poolPath } from '../src/sources/pool'

const NOW = 1794000000000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfpilot-sources-'))
  vi.stubEnv('CFPILOT_CONFIG_DIR', dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const githubSource = () => makeSource({
  id: 'github_ips',
  type: 'github-raw',
  url: 'https://raw.githubusercontent.com/owner/repo/main/ips.txt',
})
const customSource = () => makeSource({
  id: 'custom_001',
  type: 'custom-url',
  url: 'https://example.com/ips.txt',
})

/** 与 Go 侧 sources_test.go 的 sourcesGolden 逐字节一致。 */
const SOURCES_GOLDEN = `{
  "schema": 2,
  "updatedAt": 1794000000000,
  "sources": [
    {
      "id": "github_ips",
      "name": "github_ips",
      "type": "github-raw",
      "url": "https://raw.githubusercontent.com/owner/repo/main/ips.txt",
      "mirrors": [
        "https://mirror.example.com/ips.txt"
      ],
      "enabled": true,
      "intervalHours": 12,
      "etag": "W/\\"abc\\"",
      "lastModified": "Wed, 01 Jan 2026 00:00:00 GMT",
      "lastSyncAt": 1794000000000,
      "lastError": "",
      "failCount": 0,
      "query": "",
      "maxResults": 200
    }
  ],
  "runs": [
    {
      "at": 1794000000000,
      "sourceId": "github_ips",
      "ok": true,
      "added": 3,
      "updated": 0,
      "rejected": 0,
      "error": "",
      "durationMs": 42,
      "notModified": false
    }
  ]
}
`

describe('数据源配置契约', () => {
  it('golden 往返逐字节不变（CLI / Go 共用同一 schema）', () => {
    expect(serializeSources(parseSources(SOURCES_GOLDEN))).toBe(SOURCES_GOLDEN)
  })

  it('损坏 / 不兼容 schema 降级为空配置并保留备份', () => {
    writeFileSync(sourcesPath(), '{ 不是 json')
    expect(parseSources(readFileSync(sourcesPath(), 'utf8')).sources).toHaveLength(0)
    expect(readdirSync(dir).filter((f) => f.startsWith(`${SOURCES_FILENAME}.corrupt-`))).toHaveLength(1)
  })

  it('未知字段丢弃、字段顺序固定', () => {
    const messy = JSON.stringify({
      runs: [], extra: 1,
      sources: [{
        failCount: 0, lastError: '', lastSyncAt: 0, lastModified: '', etag: '',
        intervalHours: 24, enabled: true, mirrors: ['https://m.example.com/a.txt'],
        url: 'https://example.com/a.txt', type: 'custom-url', name: 'n', id: 'a', junk: 9,
      }],
      updatedAt: NOW, schema: 1,
    })
    const parsed = parseSources(messy)
    expect(parsed).not.toHaveProperty('extra')
    expect(parsed.sources[0]).not.toHaveProperty('junk')
    expect(Object.keys(parsed.sources[0]!)).toEqual([
      'id', 'name', 'type', 'url', 'mirrors', 'enabled', 'intervalHours',
      'etag', 'lastModified', 'lastSyncAt', 'lastError', 'failCount',
      'query', 'maxResults',
    ])
  })

  it('采集记录有上限，不会无限膨胀', async () => {
    await withSources((file) => {
      for (let i = 0; i < MAX_SYNC_RUNS + 20; i++) {
        file.runs.push({
          at: NOW + i, sourceId: 's', ok: true, added: 0, updated: 0,
          rejected: 0, error: '', durationMs: 0, notModified: false,
        })
      }
    })
    expect(loadSources().runs).toHaveLength(MAX_SYNC_RUNS)
  })
})

describe('清单内容归一（复用 readIpFile，只补 JSON 与端口）', () => {
  it('TXT 的 IP:port 能保留端口，裸 IP 缺省 443', () => {
    const parsed = parseSourcePayload('104.16.0.1:8443\n104.16.0.2\n[2606:4700::1]:2053')
    expect(parsed).toEqual([
      { ip: '104.16.0.1', port: 8443 },
      { ip: '104.16.0.2', port: null },
      { ip: '2606:4700::1', port: 2053 },
    ])
  })

  it('CSV 按「哪一列像 IP」取，并认相邻的端口列', () => {
    const parsed = parseSourcePayload('No,Proxy IP,Port,City\n1,104.16.0.1,8443,LAX\n2,104.16.0.2,443,AMS')
    expect(parsed.map((p) => p.ip)).toEqual(['104.16.0.1', '104.16.0.2'])
    expect(parsed[0]!.port).toBe(8443)
  })

  it('JSON 数组：字符串 / 对象 / 带端口字段', () => {
    expect(parseSourcePayload('["104.16.0.1:8443", "104.16.0.2"]')).toEqual([
      { ip: '104.16.0.1', port: 8443 }, { ip: '104.16.0.2', port: null },
    ])
    expect(parseSourcePayload('{"ips":[{"ip":"104.16.0.1","port":2053},{"address":"104.16.0.2"}]}')).toEqual([
      { ip: '104.16.0.1', port: 2053 }, { ip: '104.16.0.2', port: null },
    ])
  })

  it('JSON 顶层对象用常见别名字段找列表', () => {
    expect(parseSourcePayload('{"data":["104.16.0.1"]}')).toEqual([{ ip: '104.16.0.1', port: null }])
  })

  it('toCandidateInputs 只做映射，合法性交给 upsertCandidates', () => {
    const inputs = toCandidateInputs(parseSourcePayload('999.999.999.999\n223.5.5.5'), 's')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]!.source).toBe('s')
  })
})

describe('SSRF 防护', () => {
  it('默认只接受 HTTPS；allowHttp 也不放开私网判定', () => {
    expect(() => validateSourceUrl('http://example.com/a.txt')).toThrow(/只支持 HTTPS/)
    expect(validateSourceUrl('https://example.com/a.txt').hostname).toBe('example.com')
    expect(validateSourceUrl('http://example.com/a.txt', { allowHttp: true }).hostname).toBe('example.com')
    expect(() => validateSourceUrl('http://127.0.0.1/a', { allowHttp: true })).toThrow(/私网/)
  })

  it('本机 / 私网 / 链路本地 / 云元数据 / CGNAT / 组播一律拒绝', () => {
    for (const raw of [
      'https://localhost/a', 'https://foo.localhost/a', 'https://x.internal/a',
      'https://metadata.google.internal/latest', 'https://127.0.0.1/a',
      'https://10.1.2.3/a', 'https://172.16.5.4/a', 'https://192.168.1.1/a',
      'https://169.254.169.254/latest/meta-data', 'https://100.64.1.2/a',
      'https://198.18.0.1/a', 'https://224.0.0.1/a', 'https://[::1]/a',
      'https://[fd00::1]/a', 'https://[fe80::1]/a', 'https://[::ffff:127.0.0.1]/a',
    ]) {
      expect(() => validateSourceUrl(raw), raw).toThrow()
    }
  })

  it('拒绝带 userinfo 的视觉欺骗链接', () => {
    expect(() => validateSourceUrl('https://public.example.com@127.0.0.1/a')).toThrow(/用户名/)
    expect(() => validateSourceUrl('https://user:pw@example.com/a')).toThrow(/用户名/)
  })

  it('脱敏去掉 query / fragment', () => {
    expect(sanitizeUrl('https://example.com/ips.txt?token=SECRET#x')).toBe('https://example.com/ips.txt')
  })
})

describe('拉取（mock fetch）', () => {
  const textResponse = (text: string, init: { status?: number; headers?: Record<string, string> } = {}) =>
    new Response(text, { status: init.status ?? 200, headers: init.headers ?? {} })

  it('正常拉取并带回 ETag / Last-Modified', async () => {
    const fetchMock = vi.fn(async () => textResponse('104.16.0.1\n', {
      headers: { etag: 'W/"v1"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchSourceText(customSource())
    expect(r.text).toContain('104.16.0.1')
    expect(r.etag).toBe('W/"v1"')
    expect(r.notModified).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['If-None-Match']).toBeUndefined()
  })

  it('带条件头，304 返回 notModified 且 text 为空', async () => {
    const src = { ...customSource(), etag: 'W/"v1"', lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT' }
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await fetchSourceText(src)
    expect(r.notModified).toBe(true)
    expect(r.text).toBe('')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('W/"v1"')
  })

  it('主 URL 失败自动试下一个镜像', async () => {
    const src = {
      ...customSource(),
      mirrors: ['https://mirror.example.com/ips.txt'],
    }
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      if (n === 1) throw new Error('主站超时')
      return textResponse('104.16.0.1')
    }))
    const r = await fetchSourceText(src)
    expect(r.text).toBe('104.16.0.1')
    expect(r.url).toContain('mirror.example.com')
  })

  it('重定向逐跳复检：跳到私网直接拒绝并回退镜像', async () => {
    const src = { ...customSource(), mirrors: ['https://mirror.example.com/ips.txt'] }
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      if (n === 1) return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } })
      return textResponse('104.16.0.1')
    }))
    const r = await fetchSourceText(src)
    expect(r.url).toContain('mirror.example.com')
  })

  it('超过字节上限被拒，不会把整份内容读进内存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('x'.repeat(SOURCE_MAX_BYTES + 10))))
    await expect(fetchSourceText(customSource())).rejects.toThrow(/过大/)
  })

  it('HTTP 404 只当本 URL 失败，错误信息里不含 query 令牌', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(fetchSourceText({
      ...customSource(), url: 'https://example.com/ips.txt?token=SECRET',
    })).rejects.toThrow(/HTTP 404/)
    try {
      await fetchSourceText({ ...customSource(), url: 'https://example.com/ips.txt?token=SECRET' })
    } catch (err) {
      expect(String(err)).not.toContain('SECRET')
    }
  })
})

describe('采集编排', () => {
  const okFetcher = (text: string): SourceFetcher => async (source) => ({
    text, url: sanitizeUrl(source.url), etag: '', lastModified: '', notModified: false,
  })

  it('单源失败不清空已有池，也不拖累其它源', async () => {
    await withSources((f) => { f.sources.push(githubSource(), customSource()) })
    const fetcher: SourceFetcher = async (s) => {
      if (s.id === 'github_ips') throw new Error('主站 404')
      return okFetcher('104.16.0.1\n104.16.0.2')(s, {})
    }
    const report = await syncSources({ fetcher, now: NOW })
    expect(report.outcomes).toHaveLength(2)
    expect(report.outcomes.find((o) => o.sourceId === 'github_ips')!.ok).toBe(false)
    expect(report.outcomes.find((o) => o.sourceId === 'custom_001')!.ok).toBe(true)
    expect(parsePool(readPoolRaw()).candidates).toHaveLength(2)
    const cfg = loadSources()
    expect(cfg.sources.find((s) => s.id === 'github_ips')!.failCount).toBe(1)
    expect(cfg.sources.find((s) => s.id === 'custom_001')!.lastError).toBe('')
  })

  it('非 CF 官方段 / 非法 IP 被池层拒绝并分类计数', async () => {
    await withSources((f) => { f.sources.push(customSource()) })
    const report = await syncSources({
      fetcher: okFetcher('104.16.0.1\n223.5.5.5\n999.999.999.999\n8.8.8.8'),
      now: NOW,
    })
    expect(report.outcomes[0]!.added).toBe(1)
    expect(report.outcomes[0]!.reasons).toMatchObject({ notCloudflare: 2, invalidIp: 1 })
    expect(parsePool(readPoolRaw()).candidates.map((c) => c.ip)).toEqual(['104.16.0.1'])
  })

  it('同一 IP 多来源保留全部 sources', async () => {
    const s2 = makeSource({ id: 's2', type: 'custom-url', url: 'https://b.example.com/a.txt' })
    await withSources((f) => { f.sources.push(customSource(), s2) })
    await syncSources({ fetcher: okFetcher('104.16.0.1'), now: NOW })
    expect(parsePool(readPoolRaw()).candidates[0]!.sources).toEqual(['custom_001', 's2'])
  })

  it('304 不写池文件，也不重复落盘', async () => {
    await withSources((f) => { f.sources.push(customSource()) })
    await syncSources({ fetcher: okFetcher('104.16.0.1'), now: NOW })
    const before = readFileSync(poolPath(), 'utf8')
    const fetcher: SourceFetcher = async (s) => ({
      text: '', url: sanitizeUrl(s.url), etag: s.etag, lastModified: s.lastModified, notModified: true,
    })
    const report = await syncSources({ fetcher, now: NOW + 1 })
    expect(report.outcomes[0]!.notModified).toBe(true)
    expect(readFileSync(poolPath(), 'utf8')).toBe(before)
  })

  it('采集记录写入且保留来源失败原因', async () => {
    await withSources((f) => { f.sources.push(customSource()) })
    await syncSources({ fetcher: async () => { throw new Error('超时') }, now: NOW })
    const run = loadSources().runs.at(-1)!
    expect(run.ok).toBe(false)
    expect(run.error).toContain('超时')
    expect(run.sourceId).toBe('custom_001')
  })

  it('禁用源不参与同步', async () => {
    const src = { ...customSource(), enabled: false }
    await withSources((f) => { f.sources.push(src) })
    const report = await syncSources({ fetcher: okFetcher('104.16.0.1'), now: NOW })
    expect(report.outcomes).toHaveLength(0)
  })
})

describe('轻量校验（Phase 3）', () => {
  it('TCP/TLS 结果写进 lightCheck，失败候选仍保留', async () => {
    const inputs = toCandidateInputs(parseSourcePayload('104.16.0.1\n104.16.0.2'), 's')
    const out = await lightCheckCandidates(inputs, {
      now: NOW,
      sni: 'cloudflare.com',
      tcpProbe: async (ip) => ip === '104.16.0.1',
      tlsProbe: async () => ({ ok: true, tlsMs: 12 }),
    })
    expect(out[0]!.lightCheck).toEqual({ tcpOk: true, tlsOk: true, tlsMs: 12, at: NOW })
    expect(out[1]!.lightCheck).toEqual({ tcpOk: false, tlsOk: false, at: NOW })
    expect(out).toHaveLength(2)
  })

  it('单次数量闸门生效，超出的候选本轮不校验', async () => {
    const inputs = toCandidateInputs(
      parseSourcePayload(Array.from({ length: 10 }, (_, i) => `104.16.0.${i + 1}`).join('\n')), 's'
    )
    const out = await lightCheckCandidates(inputs, {
      now: NOW, maxPerSync: 3, concurrency: 2,
      tcpProbe: async () => true, tlsProbe: async () => ({ ok: true, tlsMs: 5 }),
    })
    expect(out.filter((i) => i.lightCheck)).toHaveLength(3)
  })

  it('池里已有未过期 lightCheck 的候选不重复校验', async () => {
    // 直接写一份带 lightCheck 的池，再校验
    const { writePoolAtomic, serializePool, parsePool: parse } = await import('../src/sources/pool')
    const pool = parse(readPoolRaw())
    pool.candidates.push({
      key: '104.16.0.1:443', ip: '104.16.0.1', port: 443, ipVersion: 4,
      candidateType: 'entry_ip', sources: ['s'], firstSeen: NOW, lastSeen: NOW,
      lightCheck: { tcpOk: true, tlsOk: true, tlsMs: 7, at: NOW },
      fullTest: null, status: 'pending', failCount: 0, successCount: 0,
    })
    writePoolAtomic(serializePool(pool))
    let calls = 0
    const out = await lightCheckCandidates(
      toCandidateInputs(parseSourcePayload('104.16.0.1'), 's'),
      { now: NOW + 1000, tcpProbe: async () => { calls++; return true }, tlsProbe: async () => ({ ok: true, tlsMs: 1 }) }
    )
    expect(calls).toBe(0)
    expect(out[0]!.lightCheck).toBeUndefined()
  })
})
