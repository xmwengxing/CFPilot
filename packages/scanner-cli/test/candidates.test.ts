import { describe, expect, it, vi } from 'vitest'
import {
  normalizeCandidateList,
  resolveCandidates,
} from '../src/candidates'
import { resolveScanCandidates, startBridge, type StartScanRequest } from '../src/server'

describe('resolveCandidates', () => {
  it('自定义网段直接展开，无需联网', async () => {
    const list = await resolveCandidates({ cidr: '1.2.3.0/30', seed: 1 })
    expect(list).toEqual(['1.2.3.0', '1.2.3.1', '1.2.3.2', '1.2.3.3'])
  })

  it('相同 seed 可复现，不同 seed 结果不同', async () => {
    const a = await resolveCandidates({ cidr: '104.16.0.0/13', sample: 64, seed: 42 })
    const b = await resolveCandidates({ cidr: '104.16.0.0/13', sample: 64, seed: 42 })
    const c = await resolveCandidates({ cidr: '104.16.0.0/13', sample: 64, seed: 43 })
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(a).toHaveLength(64)
  })

  it('支持逗号分隔与数组两种网段写法', async () => {
    const fromString = await resolveCandidates({ cidr: '1.2.3.0/31, 5.6.7.0/31', seed: 1 })
    const fromArray = await resolveCandidates({ cidr: ['1.2.3.0/31', '5.6.7.0/31'], seed: 1 })
    expect(fromString).toEqual(['1.2.3.0', '1.2.3.1', '5.6.7.0', '5.6.7.1'])
    expect(fromArray).toEqual(fromString)
  })

  it('family 可按地址族过滤', async () => {
    const both = ['1.2.3.0/31', '2606:4700::/127']
    const v4 = await resolveCandidates({ cidr: both, family: 'v4' })
    const v6 = await resolveCandidates({ cidr: both, family: 'v6' })
    expect(v4).toEqual(['1.2.3.0', '1.2.3.1'])
    expect(v6).toEqual(['2606:4700::', '2606:4700::1'])
  })

  it('网络不可用时回退内置 Cloudflare 网段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    )
    try {
      const list = await resolveCandidates({ sample: 64, seed: 7 })
      expect(list.length).toBeGreaterThan(0)
      expect(list.every((ip) => ip.length > 0)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('normalizeCandidateList', () => {
  it('清洗面板手动优选 IP 的常见写法', () => {
    const list = normalizeCandidateList([
      '1.2.3.4',
      '5.6.7.8:443',
      '9.9.9.9:8443#SJC_12_33.5',
      '[2606:4700::1]:443#LAX',
      '104.16.0.1, 1, 2, 3',
      '',
      '  1.2.3.4  ',
      '1.2.3.4',
    ])
    expect(list).toEqual(['1.2.3.4', '5.6.7.8', '9.9.9.9', '2606:4700::1', '104.16.0.1'])
  })

  it('忽略非字符串与非数组输入', () => {
    expect(normalizeCandidateList(undefined)).toEqual([])
    expect(normalizeCandidateList([])).toEqual([])
    // 运行时可能收到任意 JSON，非字符串项必须被丢弃而不是抛错
    expect(normalizeCandidateList([1, null, { ip: '1.2.3.4' }, '1.2.3.4'] as unknown[])).toEqual(['1.2.3.4'])
  })
})

describe('resolveScanCandidates（/start-scan 候选来源）', () => {
  it('请求未带 candidates 时自动生成', async () => {
    const plan = await resolveScanCandidates({ host: 'example.com', cidr: '1.2.3.0/30', seed: 1 })
    expect(plan.source).toBe('generated')
    expect(plan.candidates).toEqual(['1.2.3.0', '1.2.3.1', '1.2.3.2', '1.2.3.3'])
  })

  it('manual 优先于 candidates 与自动生成', async () => {
    const body: StartScanRequest = {
      host: 'example.com',
      manual: ['1.1.1.1', '[2606:4700::1]:443#LAX'],
      candidates: ['2.2.2.2'],
      cidr: '1.2.3.0/30',
    }
    const plan = await resolveScanCandidates(body)
    expect(plan.source).toBe('manual')
    expect(plan.candidates).toEqual(['1.1.1.1', '2606:4700::1'])
  })

  it('显式 candidates 优先于自动生成', async () => {
    const plan = await resolveScanCandidates({
      host: 'example.com',
      candidates: ['1.2.3.4:443#SJC'],
      cidr: '1.2.3.0/30',
    })
    expect(plan.source).toBe('request')
    expect(plan.candidates).toEqual(['1.2.3.4'])
  })
})

describe('桥接服务 /start-scan', () => {
  it('面板不带 candidates 也能自动生成并跑完扫描', async () => {
    const bridge = await startBridge({ port: 0 })
    try {
      const base = `http://127.0.0.1:${bridge.port}`
      const started = (await (
        await fetch(`${base}/start-scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 与面板实际请求一致：不带 candidates；cidr 指向回环 /32，避免测试联网
          body: JSON.stringify({ host: 'example.com', port: 9, cidr: '127.0.0.1/32', top: 5 }),
        })
      ).json()) as { ok: boolean; jobId: string }

      expect(started.ok).toBe(true)
      expect(started.jobId).toBeTruthy()

      const events = await (
        await fetch(`${base}/events?jobId=${encodeURIComponent(started.jobId)}`)
      ).text()

      expect(events).toContain('event: progress')
      expect(events).toContain('已自动生成 1 个候选 IP')
      expect(events).toContain('event: done')
      expect(events).not.toContain('请先运行一次完整扫描')
    } finally {
      await bridge.close()
    }
  })

  it('候选与自动生成都为空时才报错，且不再提示「先运行一次完整扫描」', async () => {
    const bridge = await startBridge({ port: 0 })
    try {
      const base = `http://127.0.0.1:${bridge.port}`
      const started = (await (
        await fetch(`${base}/start-scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: 'example.com', port: 9, candidates: [], cidr: 'not-a-cidr' }),
        })
      ).json()) as { ok: boolean; jobId: string }

      const events = await (
        await fetch(`${base}/events?jobId=${encodeURIComponent(started.jobId)}`)
      ).text()

      expect(events).toContain('event: error')
      expect(events).toContain('没有可用的候选 IP')
      expect(events).not.toContain('请先运行一次完整扫描')
    } finally {
      await bridge.close()
    }
  })
})
