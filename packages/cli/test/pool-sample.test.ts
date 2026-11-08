/**
 * Phase 4 回归：本地池分层取样、完整优选结果回写，以及 E3「回填默认 replace」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScanSummary } from '../src/scan/scan'
import { postResults } from '../src/scan/callback'
import {
  parsePool,
  readPoolRaw,
  withPool,
  writePoolAtomic,
  serializePool,
  type ExternalCandidate,
} from '../src/sources/pool'
import {
  POOL_SAMPLE_LIMIT,
  applyFullTestResults,
  networkBucket,
  sampleFromPool,
} from '../src/sources/sample'

const NOW = 1794000000000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfpilot-sample-'))
  vi.stubEnv('CFPILOT_CONFIG_DIR', dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

function candidate(ip: string, patch: Partial<ExternalCandidate> = {}): ExternalCandidate {
  return {
    key: ip.includes(':') ? `[${ip}]:443` : `${ip}:443`,
    ip,
    port: 443,
    ipVersion: ip.includes(':') ? 6 : 4,
    candidateType: 'entry_ip',
    sources: ['src'],
    firstSeen: NOW,
    lastSeen: NOW,
    lightCheck: null,
    fullTest: null,
    status: 'pending',
    failCount: 0,
    successCount: 0,
    ...patch,
  }
}

async function seed(items: ExternalCandidate[]): Promise<void> {
  const pool = parsePool(readPoolRaw())
  pool.candidates.push(...items)
  writePoolAtomic(serializePool(pool))
}

describe('分层取样', () => {
  it('networkBucket：IPv4 /24、IPv6 /48', () => {
    expect(networkBucket('104.16.0.1')).toBe('104.16.0')
    expect(networkBucket('104.16.9.9')).toBe('104.16.9')
    expect(networkBucket('2606:4700:3035::1')).toBe('2606:4700:3035')
  })

  it('同一 /24 不会吃掉全部预算（桶间轮转）', () => {
    const pool = parsePool('')
    pool.candidates = [
      ...Array.from({ length: 20 }, (_, i) => candidate(`104.16.0.${i + 1}`)),
      candidate('104.17.1.1'), candidate('104.17.2.1'), candidate('104.17.3.1'),
    ]
    const sample = sampleFromPool(pool, { limit: 8 })
    expect(sample.candidates).toHaveLength(8)
    expect(sample.totalEligible).toBe(23)
    // 至少一个来自 104.17.x，而不是前 8 个全是 104.16.0.x
    expect(sample.candidates.some((ip) => ip.startsWith('104.17.'))).toBe(true)
  })

  it('v4 / v6 各拿一半配额，一族不足时把预算让给另一族', () => {
    const pool = parsePool('')
    pool.candidates = [
      ...Array.from({ length: 10 }, (_, i) => candidate(`104.16.0.${i + 1}`)),
      candidate('2606:4700::1'), candidate('2606:4700::2'),
    ]
    const sample = sampleFromPool(pool, { limit: 6 })
    expect(sample.counts.v6).toBe(2)
    expect(sample.counts.v4).toBe(4)
  })

  it('disabled / expired / 轻量校验失败 / 端口不匹配都排除', () => {
    const pool = parsePool('')
    pool.candidates = [
      candidate('104.16.0.1'),
      candidate('104.16.0.2', { status: 'disabled' }),
      candidate('104.16.0.3', { status: 'expired' }),
      candidate('104.16.0.4', { lightCheck: { tcpOk: true, tlsOk: false, at: NOW } }),
      candidate('104.16.0.5', { port: 8443, key: '104.16.0.5:8443' }),
    ]
    const sample = sampleFromPool(pool, { limit: 10, port: 443 })
    expect(sample.candidates).toEqual(['104.16.0.1'])
    expect(sample.totalEligible).toBe(1)
  })

  it('单次取样默认上限 200，不放大测速并发', async () => {
    await seed(Array.from({ length: 500 }, (_, i) => candidate(`104.16.${Math.floor(i / 250)}.${i % 250 + 1}`)))
    const sample = sampleFromPool(parsePool(readPoolRaw()))
    expect(POOL_SAMPLE_LIMIT).toBe(200)
    expect(sample.candidates).toHaveLength(200)
  })
})

describe('完整优选结果回写', () => {
  const summary = {
    entries: [
      { ip: '104.16.0.1', port: 443, colo: 'LAX', peakMBps: 12.5, speed: 10 },
      { ip: '104.16.0.2', port: 443, colo: 'AMS', peakMBps: 0, speed: 8.2 },
    ],
  } as unknown as ScanSummary

  it('进 top N 的置 active，其余被取样的置 failed', async () => {
    await seed([
      candidate('104.16.0.1'), candidate('104.16.0.2'), candidate('104.16.0.3'),
      candidate('104.16.0.4', { status: 'disabled' }),
    ])
    const r = await applyFullTestResults(
      ['104.16.0.1:443', '104.16.0.2:443', '104.16.0.3:443', '104.16.0.4:443'],
      443, summary, NOW + 1
    )
    expect(r).toEqual({ active: 2, failed: 1 })
    const pool = parsePool(readPoolRaw())
    const one = pool.candidates.find((c) => c.key === '104.16.0.1:443')!
    expect(one.status).toBe('active')
    expect(one.fullTest).toEqual({ at: NOW + 1, wsOk: true, speedMBps: 12.5, colo: 'LAX' })
    expect(one.successCount).toBe(1)
    expect(pool.candidates.find((c) => c.key === '104.16.0.2:443')!.fullTest!.speedMBps).toBe(8.2)
    expect(pool.candidates.find((c) => c.key === '104.16.0.3:443')!.status).toBe('failed')
    // 用户禁用的候选不被结果回写覆盖
    expect(pool.candidates.find((c) => c.key === '104.16.0.4:443')!.status).toBe('disabled')
  })

  it('回写后仍可被下一次 upsert 重新发现（failed → pending）', async () => {
    await seed([candidate('104.16.0.1')])
    await withPool((pool) => {
      const c = pool.candidates[0]!
      c.status = 'failed'
      c.failCount = 2
    })
    const { upsertCandidates } = await import('../src/sources/pool')
    await withPool((pool) => upsertCandidates(pool, [{ ip: '104.16.0.1', source: 'src' }], NOW + 2))
    expect(parsePool(readPoolRaw()).candidates[0]!.status).toBe('pending')
  })
})

describe('E3：回填默认 replace', () => {
  it('postResults 不传 mode 时请求体是 replace', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await postResults('https://panel.example.com/api/v1/preferred-ips', 'tk', ['104.16.0.1:443#x'])
    expect(r.ok).toBe(true)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string) as { ips: string[]; mode: string }
    expect(body.mode).toBe('replace')
  })

  it('显式 append 仍可用（但 --from-pool 路径不会默认用它）', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await postResults('https://panel.example.com/api/v1/preferred-ips', 'tk', ['1.2.3.4:443'], 'append')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((JSON.parse(init.body as string) as { mode: string }).mode).toBe('append')
  })
})
