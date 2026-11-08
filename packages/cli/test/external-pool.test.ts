/**
 * Phase 1 回归：CLI / 桌面版共用的本地候选池读写层。
 *
 * 这里的 GOLDEN_POOL 与 packages/desktop/internal/scan/pool_test.go 里的
 * poolGolden **必须逐字节相同**：两端各自断言 parse → serialize 往返不变，
 * 等价于锁死跨语言的 JSON 排版契约。改任一侧都要同步改另一侧。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_IP,
  POOL_FILENAME,
  POOL_MAX_CANDIDATES,
  POOL_SCHEMA,
  emptyPool,
  isCloudflareEntryIp,
  normalizeCandidateKey,
  parsePool,
  poolDir,
  poolLockPath,
  poolPath,
  readPoolRaw,
  serializePool,
  upsertCandidates,
  withPool,
  type CandidateInput,
  type ExternalPool,
} from '../src/sources/pool'

const GOLDEN_POOL = `{
  "schema": 1,
  "updatedAt": 1794000000000,
  "candidates": [
    {
      "key": "104.16.0.1:443",
      "ip": "104.16.0.1",
      "port": 443,
      "ipVersion": 4,
      "candidateType": "entry_ip",
      "sources": [
        "github_best_cf_ips",
        "custom_001"
      ],
      "firstSeen": 1794000000000,
      "lastSeen": 1794000000000,
      "lightCheck": {
        "tcpOk": true,
        "tlsOk": true,
        "tlsMs": 168,
        "at": 1794000000000
      },
      "fullTest": null,
      "status": "pending",
      "failCount": 0,
      "successCount": 0
    }
  ]
}
`

const NOW = 1794000000000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfpilot-pool-'))
  vi.stubEnv('CFPILOT_CONFIG_DIR', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const input = (ip: string, source = 'src'): CandidateInput => ({ ip, source })

describe('跨语言序列化契约', () => {
  it('Go 写出的 golden 池，解析后重新序列化逐字节不变', () => {
    const pool = parsePool(GOLDEN_POOL)
    expect(pool.candidates).toHaveLength(1)
    expect(serializePool(pool)).toBe(GOLDEN_POOL)
  })

  it('空池序列化为 [] 而不是 null', () => {
    expect(serializePool(emptyPool())).toBe(
      '{\n  "schema": 1,\n  "updatedAt": 0,\n  "candidates": []\n}\n'
    )
  })

  it('解析时丢弃未知字段、补齐缺省值、固定字段顺序', () => {
    // 手工/旧版本写入的文件：带未知字段、缺 failCount、fullTest 是空对象、
    // 字段顺序被打乱。规范化后必须与 Go 的 struct 编码结果完全一致。
    const messy = JSON.stringify({
      updatedAt: NOW,
      schema: 1,
      extraTop: 'should-drop',
      candidates: [
        {
          status: 'pending',
          successCount: 0,
          failCount: 0,
          fullTest: {},
          lightCheck: null,
          lastSeen: NOW,
          firstSeen: NOW,
          sources: ['github_best_cf_ips', 'custom_001'],
          candidateType: 'entry_ip',
          ipVersion: 4,
          port: 443,
          ip: '104.16.0.1',
          key: '104.16.0.1:443',
          extraField: 42,
        },
      ],
    })
    const normalized = parsePool(messy)
    expect(normalized.candidates[0]).not.toHaveProperty('extraField')
    expect(normalized).not.toHaveProperty('extraTop')
    expect(normalized.candidates[0]!.fullTest).toEqual({
      at: null,
      wsOk: null,
      speedMBps: null,
      colo: null,
    })
    expect(serializePool(normalized)).toBe(`{
  "schema": 1,
  "updatedAt": 1794000000000,
  "candidates": [
    {
      "key": "104.16.0.1:443",
      "ip": "104.16.0.1",
      "port": 443,
      "ipVersion": 4,
      "candidateType": "entry_ip",
      "sources": [
        "github_best_cf_ips",
        "custom_001"
      ],
      "firstSeen": 1794000000000,
      "lastSeen": 1794000000000,
      "lightCheck": null,
      "fullTest": {
        "at": null,
        "wsOk": null,
        "speedMBps": null,
        "colo": null
      },
      "status": "pending",
      "failCount": 0,
      "successCount": 0
    }
  ]
}
`)
  })

  it('TLSMs 未传时字段整个消失，且位置排在 at 之前', () => {
    const pool = emptyPool()
    upsertCandidates(pool, [
      { ip: '104.16.0.1', source: 'src', lightCheck: { tcpOk: true, tlsOk: true, at: NOW } },
    ], NOW)
    expect(serializePool(pool)).toContain('"tlsOk": true,\n        "at":')
    expect(serializePool(pool)).not.toContain('tlsMs')
  })
})

describe('路径与只读语义', () => {
  it('CFPILOT_CONFIG_DIR 覆盖生效，文件名与 lockfile 契约固定', () => {
    expect(poolDir()).toBe(dir)
    expect(poolPath()).toBe(join(dir, POOL_FILENAME))
    expect(poolLockPath()).toBe(poolPath() + '.lock')
  })

  it('只读不产生任何文件', () => {
    expect(readPoolRaw()).toBe('')
    expect(existsSync(poolPath())).toBe(false)
  })
})

describe('合法性与 CF 段判定', () => {
  it('IPv4 / IPv6 / 域名 key 归一，非法 IP 与端口拒绝', () => {
    expect(normalizeCandidateKey('104.16.0.1', 443)).toBe('104.16.0.1:443')
    expect(normalizeCandidateKey(' 104.16.0.1 ', 8443)).toBe('104.16.0.1:8443')
    expect(normalizeCandidateKey('2606:4700::1', 443)).toBe('[2606:4700::1]:443')
    // 域名与 IPv4 共用 `host:port` 形态，但域名必含 `.` 且至少一段含字母
    expect(normalizeCandidateKey('example.com', 443)).toBe('example.com:443')
    expect(normalizeCandidateKey('bestcf.pages.dev', 2053)).toBe('bestcf.pages.dev:2053')
    expect(normalizeCandidateKey('999.999.999.999', 443)).toBeNull()
    expect(normalizeCandidateKey('', 443)).toBeNull()
    expect(normalizeCandidateKey('ex ample.com', 443)).toBeNull()
    expect(normalizeCandidateKey('104.16.0.1', 0)).toBeNull()
    expect(normalizeCandidateKey('104.16.0.1', 65536)).toBeNull()
  })

  it('只认扫描器官方 15 段 + IPv6 聚合段，公共 DNS / 私网一律拒绝', () => {
    for (const ip of ['104.16.0.1', '172.64.0.1', '2606:4700::1']) {
      expect(isCloudflareEntryIp(ip), ip).toBe(true)
    }
    for (const ip of ['223.5.5.5', '1.1.1.1', '8.8.8.8', '192.168.1.1', '127.0.0.1', '10.0.0.1', '::1']) {
      expect(isCloudflareEntryIp(ip), ip).toBe(false)
    }
  })
})

describe('合并语义', () => {
  it('同一 ip:port 多来源保留全部 sources，且不重复', () => {
    const pool = emptyPool()
    const r1 = upsertCandidates(pool, [input('104.16.0.1', 'github_best_cf_ips')], NOW)
    const r2 = upsertCandidates(pool, [
      input('104.16.0.1', 'custom_001'),
      input('104.16.0.1', 'custom_001'),
    ], NOW + 1)
    expect(r1.added).toBe(1)
    expect(r2.added).toBe(0)
    expect(r2.updated).toBe(2)
    expect(pool.candidates).toHaveLength(1)
    expect(pool.candidates[0]!.sources).toEqual(['github_best_cf_ips', 'custom_001'])
    expect(pool.candidates[0]!.firstSeen).toBe(NOW)
    expect(pool.candidates[0]!.lastSeen).toBe(NOW + 1)
  })

  it('非法 IP / 非 CF 段 / 异类型全部拒绝，并分类计数', () => {
    const pool = emptyPool()
    const inputs: CandidateInput[] = [
      input('999.999.999.999'),
      { ip: '104.16.0.1', port: 0, source: 'src' },
      input('223.5.5.5'),
      input('8.8.8.8'),
      { ip: '104.16.0.2', source: 'src', candidateType: 'proxy_ip' },
      { ip: '104.16.0.3', source: 'src', candidateType: 'nat64' },
    ]
    const r = upsertCandidates(pool, inputs, NOW)
    expect(r.added).toBe(0)
    expect(r.rejected).toBe(inputs.length)
    expect(pool.candidates).toHaveLength(0)
    expect(r.reasons).toEqual({ invalidIp: 2, notCloudflare: 2, candidateType: 2 })
  })

  it('IPv6 入池生成方括号 key，新候选是 pending 且 fullTest=null', () => {
    const pool = emptyPool()
    const r = upsertCandidates(pool, [input('2606:4700::1')], NOW)
    expect(r.added).toBe(1)
    expect(pool.candidates[0]).toMatchObject({
      key: '[2606:4700::1]:443',
      ipVersion: 6,
      candidateType: ENTRY_IP,
      status: 'pending',
      fullTest: null,
    })
  })

  it('轻量校验通过不自动置 active', () => {
    const pool = emptyPool()
    upsertCandidates(pool, [
      { ip: '104.16.0.1', source: 'src', lightCheck: { tcpOk: true, tlsOk: true, at: NOW } },
    ], NOW)
    expect(pool.candidates[0]!.status).toBe('pending')
  })

  it('disabled 不被自动刷新覆盖，但来源与时间仍刷新', () => {
    const pool = emptyPool()
    upsertCandidates(pool, [input('104.16.0.1', 'src')], NOW)
    pool.candidates[0]!.status = 'disabled'
    upsertCandidates(pool, [input('104.16.0.1', 'src2')], NOW + 100)
    expect(pool.candidates[0]!.status).toBe('disabled')
    expect(pool.candidates[0]!.sources).toEqual(['src', 'src2'])
    expect(pool.candidates[0]!.lastSeen).toBe(NOW + 100)
  })

  it('expired / failed 被重新发现时回到 pending', () => {
    for (const status of ['expired', 'failed'] as const) {
      const pool = emptyPool()
      upsertCandidates(pool, [input('104.16.0.1')], NOW)
      pool.candidates[0]!.status = status
      upsertCandidates(pool, [input('104.16.0.1')], NOW + 1)
      expect(pool.candidates[0]!.status, status).toBe('pending')
    }
  })

  it('30 天未重新发现只标记 expired，不物理删除；disabled 不参与', () => {
    const base = {
      key: '104.16.0.1:443', ip: '104.16.0.1', port: 443, ipVersion: 4 as const,
      candidateType: ENTRY_IP, sources: ['src'], firstSeen: NOW, lastSeen: 1,
      lightCheck: null, fullTest: null, status: 'pending' as const, failCount: 0, successCount: 0,
    }
    const pool: ExternalPool = {
      schema: POOL_SCHEMA,
      updatedAt: 0,
      candidates: [
        { ...base },
        { ...base, key: '104.16.0.2:443', ip: '104.16.0.2', lastSeen: NOW - 1000 },
        { ...base, key: '104.16.0.3:443', ip: '104.16.0.3', status: 'disabled' },
      ],
    }
    upsertCandidates(pool, [], NOW)
    expect(pool.candidates).toHaveLength(3)
    expect(pool.candidates.map((c) => c.status)).toEqual(['expired', 'pending', 'disabled'])
  })

  it('容量淘汰删最旧的，disabled 保留', () => {
    const pool = emptyPool()
    for (let i = 1; i <= 6; i++) {
      upsertCandidates(pool, [input(`104.16.0.${i}`)], NOW + i, POOL_MAX_CANDIDATES)
    }
    pool.candidates[0]!.status = 'disabled'
    const r = upsertCandidates(pool, [], NOW + 10, 3)
    expect(pool.candidates).toHaveLength(3)
    expect(r.reasons.evicted).toBe(1)
    expect(pool.candidates[0]!.status).toBe('disabled')
    expect(pool.candidates.map((c) => c.key)).toEqual([
      '104.16.0.1:443', '104.16.0.5:443', '104.16.0.6:443',
    ])
  })
})

describe('域名候选（优选域名来源）', () => {
  it('合法域名入池：key=域名:port、ipVersion=0、candidateType 仍是 ENTRY_IP', () => {
    const pool = emptyPool()
    const r = upsertCandidates(pool, [
      { ip: 'bestcf.pages.dev', port: 2053, source: 'domain_src' },
      input('example.com', 'domain_src'),
    ], NOW)
    expect(r.added).toBe(2)
    expect(r.rejected).toBe(0)
    expect(pool.candidates.map((c) => c.key)).toEqual(['bestcf.pages.dev:2053', 'example.com:443'])
    for (const c of pool.candidates) {
      expect(c.ipVersion).toBe(0)
      expect(c.candidateType).toBe(ENTRY_IP)
      expect(c.status).toBe('pending')
    }
    // 域名不是 IP：跳过官方段校验，即便不在任何 CF 段也能入池
    expect(isCloudflareEntryIp('example.com')).toBe(false)
  })

  it('非法字符串仍被拒：空串 / 空格 / 控制字符 / 无点主机 / 非法 IP 字面量', () => {
    const pool = emptyPool()
    const r = upsertCandidates(pool, [
      input(''),
      input('  '),
      input('ex ample.com'),
      input('example\x00.com'),
      input('localhost'),
      input('999.999.999.999'),
    ], NOW)
    expect(r.added).toBe(0)
    expect(r.rejected).toBe(6)
    expect(pool.candidates).toHaveLength(0)
    expect(r.reasons.invalidIp).toBe(6)
  })

  it('域名候选落盘后 parsePool 不丢弃（ipVersion=0 是合法值）', () => {
    const pool = emptyPool()
    upsertCandidates(pool, [input('example.com')], NOW)
    const reloaded = parsePool(serializePool(pool))
    expect(reloaded.candidates).toHaveLength(1)
    expect(reloaded.candidates[0]!.ipVersion).toBe(0)
  })
})

describe('持久化 / 损坏降级 / 内容未变不写', () => {
  it('跨进程重启后池仍在，追加时合并来源而不是覆盖', async () => {
    await withPool((pool) => {
      upsertCandidates(pool, [
        input('104.16.0.1', 'github_best_cf_ips'),
        input('2606:4700::1', 'custom_001'),
      ], NOW)
    })
    expect(existsSync(poolPath())).toBe(true)
    // 模拟进程重启：完全重新解析，不复用任何内存状态
    const reloaded = parsePool(readPoolRaw())
    expect(reloaded.candidates).toHaveLength(2)
    expect(reloaded.updatedAt).toBe(NOW)

    await withPool((pool) => {
      upsertCandidates(pool, [input('104.16.0.1', 'custom_001')], NOW + 1)
    })
    const final = parsePool(readPoolRaw())
    expect(final.candidates).toHaveLength(2)
    expect(final.candidates[0]!.sources).toEqual(['github_best_cf_ips', 'custom_001'])
  })

  it('重复内容不重复落盘（mtime 不变）', async () => {
    await withPool((pool) => upsertCandidates(pool, [input('104.16.0.1', 'src')], NOW))
    const before = statSync(poolPath())
    await withPool((pool) => upsertCandidates(pool, [input('104.16.0.1', 'src')], NOW))
    const after = statSync(poolPath())
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(readFileSync(poolPath(), 'utf8')).toBe(serializePool(parsePool(readPoolRaw())))
  })

  it('回调抛错时不落盘，且锁一定被释放', async () => {
    writeFileSync(poolPath(), GOLDEN_POOL)
    await expect(withPool(() => { throw new Error('模拟回调失败') })).rejects.toThrow('模拟回调失败')
    expect(readPoolRaw()).toBe(GOLDEN_POOL)
    expect(existsSync(poolLockPath())).toBe(false)
  })

  it('损坏文件保留备份并降级为空池，下次写入生成合法空池', async () => {
    writeFileSync(poolPath(), '{ 这不是 json')
    const pool = parsePool(readPoolRaw())
    expect(pool.schema).toBe(POOL_SCHEMA)
    expect(pool.candidates).toHaveLength(0)
    const backups = readdirSync(dir).filter((f) => f.startsWith(`${POOL_FILENAME}.corrupt-`))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{ 这不是 json')

    await withPool(() => {})
    expect(parsePool(readPoolRaw()).candidates).toHaveLength(0)
    expect(readPoolRaw()).toBe(serializePool(emptyPool()))
  })

  it('schema 不兼容也备份并降级', () => {
    writeFileSync(poolPath(), JSON.stringify({ schema: 999, updatedAt: 0, candidates: [] }))
    expect(parsePool(readPoolRaw()).candidates).toHaveLength(0)
    expect(readdirSync(dir).filter((f) => f.startsWith(`${POOL_FILENAME}.corrupt-`))).toHaveLength(1)
  })

  it('candidateType 隔离：异类型条目丢弃，但 schema 合法不备份整个文件', () => {
    const raw = JSON.stringify({
      schema: 1,
      updatedAt: 1,
      candidates: [
        { key: '104.16.0.1:443', ip: '104.16.0.1', port: 443, ipVersion: 4, candidateType: 'proxy_ip', sources: ['src'], firstSeen: 1, lastSeen: 1, lightCheck: null, fullTest: null, status: 'pending', failCount: 0, successCount: 0 },
        { key: '104.16.0.2:443', ip: '104.16.0.2', port: 443, ipVersion: 4, candidateType: 'entry_ip', sources: ['src'], firstSeen: 1, lastSeen: 1, lightCheck: null, fullTest: null, status: 'pending', failCount: 0, successCount: 0 },
      ],
    })
    writeFileSync(poolPath(), raw)
    expect(parsePool(readPoolRaw()).candidates.map((c) => c.key)).toEqual(['104.16.0.2:443'])
    expect(existsSync(poolPath())).toBe(true)
  })
})

describe('跨语言文件锁', () => {
  it('并发写不丢候选，写完后锁已释放', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      withPool((pool) => upsertCandidates(pool, [input(`104.16.1.${i + 1}`)], NOW + i))
    )
    await Promise.all(tasks)
    expect(parsePool(readPoolRaw()).candidates).toHaveLength(12)
    expect(existsSync(poolLockPath())).toBe(false)
  })

  it('超过 30s 的陈旧锁可以清理', async () => {
    const fd = openSync(poolLockPath(), 'wx')
    closeSync(fd)
    const past = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(poolLockPath(), past, past)
    await withPool((pool) => upsertCandidates(pool, [input('104.16.0.1')], NOW))
    expect(parsePool(readPoolRaw()).candidates).toHaveLength(1)
  })

  it('对方持锁时等待重试，锁释放后能拿到锁', async () => {
    const fd = openSync(poolLockPath(), 'wx')
    closeSync(fd)
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const pending = withPool(async (pool) => {
      await released
      upsertCandidates(pool, [input('104.16.0.1')], NOW)
    })
    // 让 pending 先进到抢锁重试，再释放外部持的锁
    await new Promise((resolve) => setTimeout(resolve, 80))
    unlinkSync(poolLockPath())
    release()
    await pending
    expect(parsePool(readPoolRaw()).candidates).toHaveLength(1)
  })
})
