/**
 * Phase 7 回归（FOFA 移除后）：schema v1→v2 迁移、RIPEstat Provider、
 * API 源经 manager 完整入池，以及「FOFA 已彻底移除」的回归断言。
 *
 * FOFA 曾短暂接入；真机验证免费账户 `remain_api_query=0`、
 * 查询返回 `[820031] F点余额不足`，按用户裁决整体移除，
 * 凭据层与相关 UI/路由一并删除。这里保留断言防止它被悄悄加回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSources,
  serializeSources,
  makeSource,
  SOURCES_SCHEMA,
} from '../src/sources/config'
import {
  PROVIDERS,
  representativeIp,
  runProvider,
  isApiSource,
  API_SOURCE_TYPES,
} from '../src/sources/providers'
import { syncSources } from '../src/sources/manager'
import { parsePool, readPoolRaw } from '../src/sources/pool'

const NOW = 1794000000000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfpilot-providers-'))
  vi.stubEnv('CFPILOT_CONFIG_DIR', dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const v1Source = {
  id: 'legacy',
  name: 'legacy',
  type: 'custom-url',
  url: 'https://example.com/ips.txt',
  mirrors: [],
  enabled: true,
  intervalHours: 24,
  etag: 'W/"v1"',
  lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
  lastSyncAt: NOW,
  lastError: '',
  failCount: 0,
}

describe('schema v1 → v2 迁移', () => {
  it('旧配置自动补齐字段，不清空、不备份丢弃', () => {
    const raw = JSON.stringify({ schema: 1, updatedAt: NOW, sources: [v1Source], runs: [] })
    const parsed = parseSources(raw)
    expect(parsed.schema).toBe(SOURCES_SCHEMA)
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.sources[0]!.etag).toBe('W/"v1"')
    expect(parsed.sources[0]!.lastSyncAt).toBe(NOW)
    expect(parsed.sources[0]!.query).toBe('')
    expect(parsed.sources[0]!.maxResults).toBe(200)
    expect(serializeSources(parsed)).toContain('"maxResults": 200')
  })

  it('真正不兼容的 schema 仍然备份降级', () => {
    const path = join(dir, 'external-sources.json')
    writeFileSync(path, JSON.stringify({ schema: 999, sources: [] }))
    expect(parseSources(readFileSync(path, 'utf8')).sources).toHaveLength(0)
  })

  it('只注册 RIPEstat 一个 API 源，list 型不受影响', () => {
    expect(API_SOURCE_TYPES).toEqual(['ripe-stat'])
    expect(Object.keys(PROVIDERS)).toEqual(['ripe-stat'])
    expect(PROVIDERS['ripe-stat']!.requiresKey).toBe(false)
    expect(isApiSource(makeSource({ id: 'a', type: 'ripe-stat' }))).toBe(true)
    expect(isApiSource(makeSource({ id: 'c', type: 'custom-url', url: 'https://e.com/a' }))).toBe(false)
  })

  it('FOFA 类型已从配置白名单移除（防止被悄悄加回）', () => {
    const raw = JSON.stringify({
      schema: 2, updatedAt: NOW,
      sources: [{ ...v1Source, type: 'fofa', query: 'asn="13335"', maxResults: 100 }],
      runs: [],
    })
    expect(parseSources(raw).sources).toHaveLength(0)
  })
})

describe('RIPEstat Provider（零 Key）', () => {
  it('representativeIp 只接受 /24 与 /48，且避开网络/广播地址', () => {
    expect(representativeIp('172.70.244.0/24')).toBe('172.70.244.130')
    expect(representativeIp('2400:cb00:db65::/48')).toBe('2400:cb00:db65::1')
    expect(representativeIp('104.16.0.0/13')).toBeNull()
    expect(representativeIp('2606:4700::/32')).toBeNull()
  })

  const ripePayload = JSON.stringify({
    status: 'ok',
    data: {
      prefixes: [
        { prefix: '172.70.244.0/24' },
        { prefix: '172.70.245.0/24' },
        { prefix: '104.16.5.0/24' },
        { prefix: '2400:cb00:db65::/48' },
        { prefix: '8.8.8.0/24' }, // 非 CF 段，应被过滤
      ],
    },
  })

  it('真实响应结构解析成功，且不需要任何 Key', async () => {
    const fetchMock = vi.fn(async () => new Response(ripePayload, { status: 200 }))
    const result = await runProvider({
      source: makeSource({ id: 'ripe', type: 'ripe-stat', query: 'AS13335', maxResults: 10 }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result.upstreamCount).toBe(5)
    expect(result.candidates.map((c) => c.ip)).not.toContain('8.8.8.130')
    expect(result.candidates.some((c) => c.ip.startsWith('172.70.'))).toBe(true)
    expect(result.candidates.every((c) => c.port === 443)).toBe(true)
    expect(result.note).toContain('AS13335')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ASN 非法直接拒绝，不发请求', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    await expect(runProvider({
      source: makeSource({ id: 'ripe', type: 'ripe-stat', query: 'DROP TABLE' }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow(/ASN/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('经 manager 完整入池（配置 → Provider → 归一 → 池）', async () => {
    const { withSources } = await import('../src/sources/config')
    await withSources((f) => {
      f.sources.push(makeSource({ id: 'ripe', type: 'ripe-stat', query: 'AS13335', maxResults: 10 }))
    })
    const fetchMock = vi.fn(async () => new Response(ripePayload, { status: 200 }))
    const report = await syncSources({
      now: NOW,
      providerFetch: fetchMock as unknown as typeof fetch,
    })
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0]!.ok).toBe(true)
    expect(report.outcomes[0]!.added).toBeGreaterThan(0)
    const pool = parsePool(readPoolRaw())
    expect(pool.candidates.length).toBeGreaterThan(0)
    expect(pool.candidates.every((c) => c.sources.includes('ripe'))).toBe(true)
    expect(pool.candidates.every((c) => c.status === 'pending')).toBe(true)
  })
})
