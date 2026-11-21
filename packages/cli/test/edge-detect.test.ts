/**
 * `cfpilot edge status`（盲中继部署状态检测）单测。
 *
 * 防什么：
 *   1. 把普通 Worker（没有 MONITOR_TOKEN / MeshRoom 特征）误认成盲中继；
 *   2. 只认名字不认绑定特征 → 用户改过 worker 名就检测不到；
 *   3. 多实例时顺序不稳、筛选条件失效；
 *   4. 未绑定域名 / 令牌不可读没有提示（用户以为回填成功）；
 *   5. 检测悄悄写入或探测 —— 本文件同时断言「只读」（不调用任何写方法）。
 */
import { describe, it, expect, vi } from 'vitest'
import type { CloudflareClient, ScriptBinding } from '../src/deploy/cf-api'
import {
  detectEdgeRelay,
  isEdgeRelayBindings,
  matchZone,
  pickDashboardProject,
  pickWorkerDomain,
  rankScriptNames,
  readPlainText,
  settingsBindings,
} from '../src/edge/detect'

const relayBindings: ScriptBinding[] = [
  { type: 'd1', name: 'DB', id: 'db-uuid-1' },
  { type: 'durable_object_namespace', name: 'MESH_ROOM', class_name: 'MeshRoom' },
  { type: 'plain_text', name: 'MONITOR_TOKEN', text: 'monitor-token-abc123456789' },
  { type: 'plain_text', name: 'WINDOW_MS', text: '1000' },
  { type: 'plain_text', name: 'MAX_BYTES_PER_WINDOW', text: '1048576' },
  { type: 'plain_text', name: 'MAX_PACKETS_PER_WINDOW', text: '2000' },
  { type: 'plain_text', name: 'MAX_PEERS_PER_ROOM', text: '512' },
]

type FakeOptions = {
  scripts: string[]
  settings: Record<string, unknown>
  domains?: Array<{ id: string; hostname: string; service: string; enabled?: boolean }>
  d1?: Array<{ uuid: string; name: string }>
  projects?: Array<{ id: string; name: string; subdomain: string; production_branch: string }>
  zones?: Array<{ id: string; name: string; status: string }>
  subdomain?: string
}

function fakeClient(opts: FakeOptions) {
  const writes = vi.fn()
  const client = {
    listScripts: vi.fn(async () => opts.scripts),
    getScriptSettings: vi.fn(async (_a: string, name: string) => {
      const s = opts.settings[name]
      if (s === undefined) throw Object.assign(new Error('not found'), { status: 404 })
      return s
    }),
    listWorkerDomains: vi.fn(async () => opts.domains ?? []),
    listD1Databases: vi.fn(async () => opts.d1 ?? []),
    listPagesProjects: vi.fn(async () => opts.projects ?? []),
    listZones: vi.fn(async () => opts.zones ?? []),
    getWorkersSubdomain: vi.fn(async () => opts.subdomain ?? ''),
    // 写方法一律不允许被调用：检测必须只读
    uploadScript: writes,
    createD1Database: writes,
    attachCustomDomain: writes,
    deployPagesWorker: writes,
    createPagesProject: writes,
    setKvValue: writes,
  }
  return { client: client as unknown as CloudflareClient, writes }
}

const base: FakeOptions = {
  scripts: ['mobihop-edge-relay', 'my-other-worker'],
  settings: {
    'mobihop-edge-relay': { bindings: relayBindings },
    'my-other-worker': { bindings: [{ type: 'plain_text', name: 'FOO', text: 'bar' }] },
  },
  domains: [{ id: 'd1', hostname: 'relay.example.com', service: 'mobihop-edge-relay', enabled: true }],
  d1: [{ uuid: 'db-uuid-1', name: 'mobihop-edge-relay-monitor' }],
  projects: [
    {
      id: 'p1',
      name: 'mobihop-edge-relay-dashboard',
      subdomain: 'mobihop-edge-relay-dashboard.pages.dev',
      production_branch: 'main',
    },
  ],
  zones: [{ id: 'zone-1', name: 'example.com', status: 'active' }],
  subdomain: 'demo',
}

describe('识别规则', () => {
  it('有 MONITOR_TOKEN + MeshRoom/DB 才算盲中继', () => {
    expect(isEdgeRelayBindings(relayBindings)).toBe(true)
    expect(isEdgeRelayBindings([{ type: 'plain_text', name: 'FOO' }])).toBe(false)
    // 只有普通 D1 绑定、没有令牌：不是我们
    expect(isEdgeRelayBindings([{ type: 'd1', name: 'DB', id: 'x' }])).toBe(false)
  })

  it('secret_text 的 MONITOR_TOKEN 仍算本脚本（只是令牌不可读）', () => {
    const secret = [
      { type: 'd1', name: 'DB', id: 'db-uuid-1' },
      { type: 'secret_text', name: 'MONITOR_TOKEN' },
    ] as unknown as ScriptBinding[]
    expect(isEdgeRelayBindings(secret)).toBe(true)
    expect(readPlainText(secret, 'MONITOR_TOKEN')).toBe('')
  })

  it('settingsBindings 对畸形结构返回空数组', () => {
    expect(settingsBindings(null)).toEqual([])
    expect(settingsBindings({ bindings: 'nope' })).toEqual([])
    expect(settingsBindings({ bindings: [{ name: 'A', type: 'plain_text', text: 'v' }] })).toHaveLength(1)
  })

  it('域名按最长后缀匹配 zone', () => {
    const zones = [
      { id: 'z1', name: 'example.com', status: 'active' },
      { id: 'z2', name: 'sub.example.com', status: 'active' },
    ]
    expect(matchZone('relay.sub.example.com', zones)?.id).toBe('z2')
    expect(matchZone('relay.example.com', zones)?.id).toBe('z1')
    expect(matchZone('other.net', zones)).toBeNull()
  })

  it('监测面板优先精确名，其次唯一 dashboard 项目', () => {
    expect(
      pickDashboardProject(
        [{ id: 'p', name: 'edge-dashboard', subdomain: '', production_branch: 'main' }],
        'edge'
      )
    ).toEqual({ project: 'edge-dashboard', guessed: false })
    expect(
      pickDashboardProject(
        [{ id: 'p', name: 'my-monitor', subdomain: '', production_branch: 'main' }],
        'edge'
      )
    ).toEqual({ project: 'my-monitor', guessed: true })
    expect(pickDashboardProject([], 'edge')).toEqual({ project: '', guessed: false })
  })

  it('域名绑定按启用优先选，名字像盲中继的脚本排前', () => {
    const domains = [
      { id: 'a', hostname: 'b.example.com', service: 'w', enabled: false },
      { id: 'b', hostname: 'a.example.com', service: 'w', enabled: true },
    ]
    expect(pickWorkerDomain(domains, 'w')).toBe('a.example.com')
    expect(rankScriptNames(['zzz', 'edge-relay', 'mobihop-edge-relay'], 'mobihop-edge-relay')[0]).toBe(
      'mobihop-edge-relay'
    )
  })
})

describe('detectEdgeRelay 主流程', () => {
  it('识别实例并回填全部字段（只读，不调任何写方法）', async () => {
    const { client, writes } = fakeClient(base)
    const probeFn = vi.fn(async () => ({ reachable: true, dashboardReady: true, passwordSet: true }))

    const result = await detectEdgeRelay(client, { accountId: 'acc', probeFn })

    expect(result.instances).toHaveLength(1)
    const ins = result.instances[0]!
    expect(ins.workerName).toBe('mobihop-edge-relay')
    expect(ins.domain).toBe('relay.example.com')
    expect(ins.workerUrl).toBe('https://relay.example.com')
    expect(ins.wssEndpoint).toContain('wss://relay.example.com/mesh/')
    expect(ins.zoneId).toBe('zone-1')
    expect(ins.dashboardProject).toBe('mobihop-edge-relay-dashboard')
    expect(ins.dashboardUrl).toBe('https://relay.example.com')
    expect(ins.dashboardReady).toBe(true)
    expect(ins.d1Name).toBe('mobihop-edge-relay-monitor')
    expect(ins.monitorToken).toBe('monitor-token-abc123456789')
    expect(ins.limits).toEqual({ windowMs: '1000', maxBytes: '1048576', maxPackets: '2000', maxPeers: '512' })
    expect(ins.reachable).toBe(true)
    expect(ins.passwordSet).toBe(true)
    expect(probeFn).toHaveBeenCalledWith('https://relay.example.com')
    expect(writes).not.toHaveBeenCalled()
  })

  it('普通 Worker 被跳过，账号下没有实例时返回空数组', async () => {
    const { client } = fakeClient({ ...base, scripts: ['my-other-worker'] })
    const result = await detectEdgeRelay(client, { accountId: 'acc', probe: false })
    expect(result.instances).toEqual([])
  })

  it('未绑定自定义域名时留空并提示，workerUrl 退到 workers.dev', async () => {
    const { client } = fakeClient({ ...base, domains: [] })
    const result = await detectEdgeRelay(client, { accountId: 'acc', probe: false })
    const ins = result.instances[0]!
    expect(ins.domain).toBe('')
    expect(ins.workerUrl).toBe('https://mobihop-edge-relay.demo.workers.dev')
    expect(ins.warnings.join(' ')).toContain('未绑定自定义域名')
  })

  it('secret 令牌给出「不可读取」提示而不是静默留空', async () => {
    const secretBindings = relayBindings.filter((b) => b.name !== 'MONITOR_TOKEN')
    const { client } = fakeClient({
      ...base,
      settings: {
        'mobihop-edge-relay': {
          bindings: [...secretBindings, { type: 'secret_text', name: 'MONITOR_TOKEN' }],
        },
      },
    })
    const result = await detectEdgeRelay(client, { accountId: 'acc', probe: false })
    const ins = result.instances[0]!
    expect(ins.monitorToken).toBe('')
    expect(ins.warnings.join(' ')).toContain('无法回填')
  })

  it('多个实例按 Worker 名排序，且 --domain 筛选生效', async () => {
    const second = {
      scripts: ['zeta-relay', 'mobihop-edge-relay'],
      settings: {
        'zeta-relay': { bindings: relayBindings },
        'mobihop-edge-relay': { bindings: relayBindings },
      },
      domains: [
        { id: 'd1', hostname: 'z.example.com', service: 'zeta-relay', enabled: true },
        { id: 'd2', hostname: 'relay.example.com', service: 'mobihop-edge-relay', enabled: true },
      ],
      d1: [{ uuid: 'db-uuid-1', name: 'mobihop-edge-relay-monitor' }],
      projects: [],
      zones: [{ id: 'zone-1', name: 'example.com', status: 'active' }],
    }
    const { client } = fakeClient(second)
    const all = await detectEdgeRelay(client, { accountId: 'acc', probe: false })
    expect(all.instances.map((i) => i.workerName)).toEqual(['mobihop-edge-relay', 'zeta-relay'])

    const { client: c2 } = fakeClient(second)
    const one = await detectEdgeRelay(c2, { accountId: 'acc', probe: false, domain: 'z.example.com' })
    expect(one.instances.map((i) => i.workerName)).toEqual(['zeta-relay'])
  })

  it('--no-probe 时不发起任何可达性请求', async () => {
    const { client } = fakeClient(base)
    const probeFn = vi.fn(async () => ({ reachable: true, dashboardReady: true, passwordSet: true }))
    await detectEdgeRelay(client, { accountId: 'acc', probe: false, probeFn })
    expect(probeFn).not.toHaveBeenCalled()
  })

  it('账号级列表失败只降级为 warning，不整单失败', async () => {
    const { client } = fakeClient(base)
    ;(client as unknown as { listPagesProjects: () => Promise<never> }).listPagesProjects = vi.fn(async () => {
      throw new Error('403 forbidden')
    })
    const result = await detectEdgeRelay(client, { accountId: 'acc', probe: false })
    expect(result.instances).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('Pages')
  })

  it('页面项目存在但根路径返回 426 时，监测台仍判为未部署', async () => {
    const { client } = fakeClient(base)
    const result = await detectEdgeRelay(client, {
      accountId: 'acc',
      probeFn: vi.fn(async () => ({ reachable: true, dashboardReady: false, passwordSet: true })),
    })
    const ins = result.instances[0]!
    expect(ins.dashboardProject).toBe('mobihop-edge-relay-dashboard')
    expect(ins.dashboardReady).toBe(false)
    expect(ins.dashboardUrl).toBe('')
    expect(ins.warnings.join(' ')).toContain('监测台未部署')
  })

  it('默认探测要求根路径返回 HTML 才标记监测台可用', async () => {
    const { client } = fakeClient(base)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('{"ok":true}', { status: 200 })
      if (url.endsWith('/auth/status')) return Response.json({ setupRequired: false })
      if (url.endsWith('/')) return new Response('WebSocket upgrade required', { status: 426 })
      throw new Error(`unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await detectEdgeRelay(client, { accountId: 'acc' })
    const ins = result.instances[0]!
    expect(ins.reachable).toBe(true)
    expect(ins.dashboardReady).toBe(false)
    expect(ins.dashboardUrl).toBe('')

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/health')) return new Response('{"ok":true}', { status: 200 })
      if (url.endsWith('/auth/status')) return Response.json({ setupRequired: false })
      return new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    })
    const ready = await detectEdgeRelay(client, { accountId: 'acc' })
    expect(ready.instances[0]!.dashboardReady).toBe(true)
    expect(ready.instances[0]!.dashboardUrl).toBe('https://relay.example.com')
  })
})
