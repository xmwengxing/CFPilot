/**
 * 多账户隔离的回归测试。
 *
 * ## 为什么需要
 *
 * CLI 的配置是**扁平单文件**（`~/.cfpilot/config.json`），
 * 没有 profiles 数组。历史上出过三类串号：
 *
 *  1. **B3：「账号取自 accounts[0] + KV 取自本地配置」**
 *     —— 两者可以分属不同账号 → 部署落到 A，却带着 B 的 KV ID
 *     → 在 A 里凭空建出孤儿 Pages 项目、KV 绑定失败、配置写不进去。
 *  2. **B4：「新 Token + 旧账户的 KV / 域名 / WS 路径」**
 *     —— `saveConfig` 是合并语义，换 Token 时旧字段全部留存。
 *  3. **B9：「读不到 ≠ 不存在」**
 *     —— KV 归属判定把 403 / 网络错误当成「键不存在」→ 落到 `empty`（不阻断）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CloudflareClient } from '../src/deploy/cf-api'
import { inspectKvOwnership, readManifest } from '../src/deploy/pages-deploy'
import { checkKvInAccount, findAccountByKv } from '../src/deploy/account-resolve'
import { resolveDeployAccount } from '../src/deploy/command'

// ------------------------------------------------------------------
// 测试脚手架
// ------------------------------------------------------------------

let workDir = ''
let originalHome = ''

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cfpilot-acct-'))
  // 把配置目录指到临时目录，避免污染真实配置
  originalHome = process.env.CFPILOT_CONFIG_DIR ?? ''
  process.env.CFPILOT_CONFIG_DIR = workDir
})

afterEach(() => {
  if (originalHome) process.env.CFPILOT_CONFIG_DIR = originalHome
  else delete process.env.CFPILOT_CONFIG_DIR
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  vi.unstubAllGlobals()
})

/**
 * 造一个 Cloudflare API 的 JSON 响应。
 *
 * ⚠️ CF 的响应**必须带信封** `{ success: true, result: [...] }` ——
 * `readApiResponse` 会校验它，裸数组会被当成「格式无效」抛错。
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Cloudflare API 的路径路由表。 */
interface CfRoutes {
  /** GET /accounts */
  accounts?: Array<{ id: string; name: string }>
  /** GET /accounts/{id}/storage/kv/namespaces */
  namespaces?: Record<string, Array<{ id: string; title: string }>>
  /** GET /accounts/{id}/storage/kv/namespaces/{ns}/values/{key} —— 值是纯文本 */
  values?: Record<string, string>
  /** 整体失败（模拟网络 / 权限问题） */
  failStatus?: number
}

/**
 * 装一个假的 fetch，按 **URL 路径** 路由（不用子串匹配 ——
 * `/accounts` 是 `/accounts/{id}/storage/kv/namespaces` 的前缀，
 * 子串匹配会分不清）。
 */
function mockCloudflare(routes: CfRoutes): string[] {
  const hits: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      hits.push(url)
      const path = new URL(url).pathname.replace(/^\/client\/v4/, '')

      if (routes.failStatus) {
        return new Response('boom', { status: routes.failStatus })
      }

      // /accounts/{id}/storage/kv/namespaces/{ns}/values/{key}
      const valueMatch = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/.exec(path)
      if (valueMatch) {
        const key = decodeURIComponent(valueMatch[3]!)
        const raw = routes.values?.[key]
        return raw === undefined ? new Response('not found', { status: 404 }) : new Response(raw)
      }

      // /accounts/{id}/storage/kv/namespaces
      const nsMatch = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces$/.exec(path)
      if (nsMatch) {
        return jsonResponse(routes.namespaces?.[nsMatch[1]!] ?? [])
      }

      // /accounts
      if (path === '/accounts') {
        return jsonResponse(routes.accounts ?? [])
      }

      return new Response('not found', { status: 404 })
    })
  )
  return hits
}

/** 造一个假的 CloudflareClient（只需 listAccounts / listKvNamespaces）。 */
function fakeClient(opts: {
  accounts: Array<{ id: string; name: string }>
  namespaces: Record<string, Array<{ id: string; title: string }>>
  /** 列出命名空间时报错的账号 */
  failAccounts?: string[]
}): CloudflareClient {
  const client = {
    listAccounts: async () => opts.accounts,
    listKvNamespaces: async (accountId: string) => {
      if (opts.failAccounts?.includes(accountId)) {
        throw new Error(`403 forbidden: ${accountId}`)
      }
      return opts.namespaces[accountId] ?? []
    },
  }
  return client as unknown as CloudflareClient
}

const ACCOUNT_A = { id: 'acc-A', name: '账户 A' }
const ACCOUNT_B = { id: 'acc-B', name: '账户 B' }

/** 一个完整可用的部署清单。 */
function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kvNamespaceId: 'kv-B',
    controlProject: 'cfpilot-control-B',
    dataProject: 'cfpilot-data-B',
    controlSubdomain: 'b.pages.dev',
    dataSubdomain: 'bdata.pages.dev',
    build: 'abc-1234',
    kernelVersion: '0.8.1',
    at: '2026-10-28T00:00:00.000Z',
    credentials: {
      panelPath: '/panel',
      panelPassword: 'pw',
      uuid: 'uuid-B',
      trojanPassword: 'tp',
      wsPath: '/ws-B',
    },
    ...overrides,
  }
}

// ------------------------------------------------------------------
// B9：读不到 ≠ 不存在
// ------------------------------------------------------------------

describe('B9：KV 读失败不能当成「键不存在」', () => {
  it('getKvValue 在 403 时抛错（不返回 null）', async () => {
    mockCloudflare({ failStatus: 403 })
    const client = new CloudflareClient({ token: 't' })
    await expect(client.getKvValue('acc', 'ns', 'CONFIG')).rejects.toThrow(/无法确认归属/)
  })

  it('getKvValue 在 500 时抛错', async () => {
    mockCloudflare({ failStatus: 500 })
    const client = new CloudflareClient({ token: 't' })
    await expect(client.getKvValue('acc', 'ns', 'CONFIG')).rejects.toThrow(/无法确认归属/)
  })

  it('getKvValue 在 404 时返回 null（键确实不存在）', async () => {
    mockCloudflare({})
    const client = new CloudflareClient({ token: 't' })
    await expect(client.getKvValue('acc', 'ns', 'CONFIG')).resolves.toBeNull()
  })

  it('网络异常时抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const client = new CloudflareClient({ token: 't' })
    await expect(client.getKvValue('acc', 'ns', 'CONFIG')).rejects.toThrow(/无法确认归属/)
  })

  it('归属判定：读不到时不可放行（不能落到 empty）', async () => {
    mockCloudflare({ failStatus: 403 })
    const client = new CloudflareClient({ token: 't' })
    const info = await inspectKvOwnership(client, 'acc', 'ns', 'some-project')
    expect(info.verdict).not.toBe('empty')
    expect(info.blocking).toBe(true)
  })

  it('归属判定：清单损坏时不可放行（不能落到 empty）', async () => {
    mockCloudflare({ values: { CFP_DEPLOY_MANIFEST: '{ 坏掉的 JSON' } })
    const client = new CloudflareClient({ token: 't' })
    const info = await inspectKvOwnership(client, 'acc', 'ns', 'some-project')
    expect(info.verdict).not.toBe('empty')
    expect(info.blocking).toBe(true)
  })

  it('归属判定：确实为空时仍判定 empty（不阻断）', async () => {
    mockCloudflare({})
    const client = new CloudflareClient({ token: 't' })
    const info = await inspectKvOwnership(client, 'acc', 'ns', 'some-project')
    expect(info.verdict).toBe('empty')
    expect(info.blocking).toBe(false)
  })

  it('readManifest 读失败时抛错（不返回 null）', async () => {
    mockCloudflare({ failStatus: 403 })
    const client = new CloudflareClient({ token: 't' })
    await expect(readManifest(client, 'acc', 'ns')).rejects.toThrow(/无法确认归属/)
  })

  it('readManifest 键不存在时返回 null', async () => {
    mockCloudflare({})
    const client = new CloudflareClient({ token: 't' })
    await expect(readManifest(client, 'acc', 'ns')).resolves.toBeNull()
  })

  it('五分支语义不变：owned / occupied / foreign / stale / empty', async () => {
    // owned：清单属于本次目标
    mockCloudflare({ values: { CFP_DEPLOY_MANIFEST: JSON.stringify(makeManifest()) } })
    let client = new CloudflareClient({ token: 't' })
    let info = await inspectKvOwnership(client, 'acc', 'ns', 'cfpilot-control-B')
    expect(info.verdict).toBe('owned')
    expect(info.blocking).toBe(false)

    // occupied：清单属于另一个实例
    mockCloudflare({ values: { CFP_DEPLOY_MANIFEST: JSON.stringify(makeManifest()) } })
    client = new CloudflareClient({ token: 't' })
    info = await inspectKvOwnership(client, 'acc', 'ns', 'another-project')
    expect(info.verdict).toBe('occupied')
    expect(info.blocking).toBe(true)

    // foreign：含小写 config 键
    mockCloudflare({ values: { config: JSON.stringify({ uuid: 'x' }) } })
    client = new CloudflareClient({ token: 't' })
    info = await inspectKvOwnership(client, 'acc', 'ns', 'p')
    expect(info.verdict).toBe('foreign')
    expect(info.blocking).toBe(true)

    // stale：含大写 CONFIG 键但没有清单
    mockCloudflare({ values: { CONFIG: JSON.stringify({ uuid: 'x' }) } })
    client = new CloudflareClient({ token: 't' })
    info = await inspectKvOwnership(client, 'acc', 'ns', 'p')
    expect(info.verdict).toBe('stale')
    expect(info.blocking).toBe(true)
  })
})

// ------------------------------------------------------------------
// B3：账号与 KV 必须同源
// ------------------------------------------------------------------

describe('B3：账号与 KV 的归属解析', () => {
  it('findAccountByKv 反查到 KV 所属的账号（不是 accounts[0]）', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const { owner } = await findAccountByKv(client, [ACCOUNT_A, ACCOUNT_B], 'kv-B')
    expect(owner?.id).toBe('acc-B')
  })

  it('findAccountByKv 找不到时返回 null', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const { owner } = await findAccountByKv(client, [ACCOUNT_A, ACCOUNT_B], 'kv-C')
    expect(owner).toBeNull()
  })

  it('findAccountByKv 某个账号读不到时跳过它并计数', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: { 'acc-B': [{ id: 'kv-B', title: 'kv-B' }] },
      failAccounts: ['acc-A'],
    })
    const { owner, unreadable } = await findAccountByKv(client, [ACCOUNT_A, ACCOUNT_B], 'kv-B')
    expect(owner?.id).toBe('acc-B')
    expect(unreadable).toBe(1)
  })

  it('checkKvInAccount：同源为 yes / 异源为 no / 读不到为 unknown', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
      failAccounts: ['acc-A'],
    })
    await expect(checkKvInAccount(client, 'acc-B', 'kv-B')).resolves.toBe('yes')
    await expect(checkKvInAccount(client, 'acc-B', 'kv-A')).resolves.toBe('no')
    await expect(checkKvInAccount(client, 'acc-A', 'kv-A')).resolves.toBe('unknown')
  })

  it('部署命令：只给 --kv 时按 KV 反查账号（不取 accounts[0]）', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const res = await resolveDeployAccount(client, { accountFlag: '', kvId: 'kv-B' })
    expect(res.ok).toBe(true)
    expect(res.accountId).toBe('acc-B')
    expect(res.source).toBe('kv-lookup')
  })

  it('部署命令：只给 --kv 且查不到归属时报错（不静默用 accounts[0]）', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const res = await resolveDeployAccount(client, { accountFlag: '', kvId: 'kv-C' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('kv-C')
    expect(res.message).toContain('--account')
  })

  it('部署命令：显式 --account 与 --kv 异源时拒绝部署', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const res = await resolveDeployAccount(client, { accountFlag: 'acc-A', kvId: 'kv-B' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('不属于账号')
  })

  it('部署命令：显式 --account 与 --kv 同源时放行', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const res = await resolveDeployAccount(client, { accountFlag: 'acc-B', kvId: 'kv-B' })
    expect(res.ok).toBe(true)
    expect(res.accountId).toBe('acc-B')
  })

  it('部署命令：命令行直调「只给 --kv」仍然可用（不回归）', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    const res = await resolveDeployAccount(client, { accountFlag: '', kvId: 'kv-A' })
    expect(res.ok).toBe(true)
    expect(res.accountId).toBe('acc-A')
  })

  it('部署命令：都不给时回落第一个账号（全新部署场景）', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: { 'acc-A': [] },
    })
    const res = await resolveDeployAccount(client, { accountFlag: '', kvId: '' })
    expect(res.ok).toBe(true)
    expect(res.accountId).toBe('acc-A')
    expect(res.source).toBe('first')
  })

  it('部署命令：--list-kv 与 KV 无关（KV 查不到也不报错）', async () => {
    const client = fakeClient({
      accounts: [ACCOUNT_A, ACCOUNT_B],
      namespaces: {
        'acc-A': [{ id: 'kv-A', title: 'kv-A' }],
        'acc-B': [{ id: 'kv-B', title: 'kv-B' }],
      },
    })
    // --list-kv 时 ignoreKv 生效 → 不做 KV 反查
    const res = await resolveDeployAccount(client, {
      accountFlag: '',
      kvId: 'kv-C',
      ignoreKv: true,
    })
    expect(res.ok).toBe(true)
    expect(res.accountId).toBe('acc-A')
  })
})

// ------------------------------------------------------------------
// B4：换 Token 必须清空上一个账户的字段
// ------------------------------------------------------------------

describe('B4：换 Token 必须清空上一个账户的字段', () => {
  /** 往临时配置目录里写一份配置。 */
  function writeConfig(cfg: Record<string, unknown>): void {
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
  }

  it('saveToken：换 Token 时清空账号 / KV / 域名 / WS 路径', async () => {
    writeConfig({
      token: 'old-token',
      accountId: 'acc-A',
      accountName: '账户 A',
      kvNamespaceId: 'kv-A',
      panelHost: 'a.pages.dev',
      dataHost: 'adata.pages.dev',
      wsPath: '/ws-A',
    })
    const { saveToken, loadConfig } = await import('../src/menu/store')
    saveToken('new-token')

    const cfg = loadConfig()
    expect(cfg.token).toBe('new-token')
    // 关键：旧账户的字段**不能**残留
    expect(cfg.accountId ?? '').toBe('')
    expect(cfg.accountName ?? '').toBe('')
    expect(cfg.kvNamespaceId ?? '').toBe('')
    expect(cfg.panelHost ?? '').toBe('')
    expect(cfg.dataHost ?? '').toBe('')
    expect(cfg.wsPath ?? '').toBe('')
  })

  it('saveToken：同一个 Token 不清空（重新添加同一 Token 保留配置）', async () => {
    writeConfig({
      token: 'same-token',
      accountId: 'acc-A',
      kvNamespaceId: 'kv-A',
      panelHost: 'a.pages.dev',
    })
    const { saveToken, loadConfig } = await import('../src/menu/store')
    saveToken('same-token')

    const cfg = loadConfig()
    expect(cfg.accountId).toBe('acc-A')
    expect(cfg.kvNamespaceId).toBe('kv-A')
    expect(cfg.panelHost).toBe('a.pages.dev')
  })

  it('saveToken：同一次调用里显式给的字段保留', async () => {
    writeConfig({
      token: 'old-token',
      accountId: 'acc-A',
      kvNamespaceId: 'kv-A',
      panelHost: 'a.pages.dev',
    })
    const { saveToken, loadConfig } = await import('../src/menu/store')
    saveToken('new-token', { accountId: 'acc-B' })

    const cfg = loadConfig()
    expect(cfg.token).toBe('new-token')
    expect(cfg.accountId).toBe('acc-B')
    // 没显式给的仍然要清空
    expect(cfg.kvNamespaceId ?? '').toBe('')
    expect(cfg.panelHost ?? '').toBe('')
  })

  it('命令行 config --token 同样清空旧账户的字段', async () => {
    writeConfig({
      token: 'old-token',
      accountId: 'acc-A',
      accountName: '账户 A',
      kvNamespaceId: 'kv-A',
      panelHost: 'a.pages.dev',
      dataHost: 'adata.pages.dev',
      wsPath: '/ws-A',
    })
    // 让同步失败（网络不通）—— 清空必须发生在同步之前
    mockCloudflare({ failStatus: 500 })

    const { runConfig } = await import('../src/menu/config')
    await runConfig({ command: 'config', flags: { token: 'new-token' }, positionals: [] })

    const { loadConfig } = await import('../src/menu/store')
    const cfg = loadConfig()
    expect(cfg.token).toBe('new-token')
    expect(cfg.accountId ?? '').toBe('')
    expect(cfg.kvNamespaceId ?? '').toBe('')
    expect(cfg.panelHost ?? '').toBe('')
    expect(cfg.dataHost ?? '').toBe('')
    expect(cfg.wsPath ?? '').toBe('')
  })

  it('syncAccount 成功时 wsPath 会被更新成当前实例的', async () => {
    writeConfig({
      token: 'old-token',
      accountId: 'acc-A',
      kvNamespaceId: 'kv-A',
      wsPath: '/ws-A',
    })

    mockCloudflare({
      accounts: [{ id: 'acc-B', name: '账户 B' }],
      namespaces: { 'acc-B': [{ id: 'kv-B', title: 'kv-B' }] },
      values: { CFP_DEPLOY_MANIFEST: JSON.stringify(makeManifest()) },
    })

    const { syncAccount } = await import('../src/menu/config')
    await syncAccount('new-token')

    const { loadConfig } = await import('../src/menu/store')
    const cfg = loadConfig()
    expect(cfg.accountId).toBe('acc-B')
    expect(cfg.kvNamespaceId).toBe('kv-B')
    expect(cfg.panelHost).toBe('b.pages.dev')
    expect(cfg.dataHost).toBe('bdata.pages.dev')
    // wsPath 之前从不更新 —— 现在必须跟着实例走
    expect(cfg.wsPath).toBe('/ws-B')
  })

  it('syncAccount：新账号下没有 KV 时清空旧实例的 KV / 域名 / WS 路径', async () => {
    writeConfig({
      token: 'old-token',
      accountId: 'acc-A',
      kvNamespaceId: 'kv-A',
      panelHost: 'a.pages.dev',
      dataHost: 'adata.pages.dev',
      wsPath: '/ws-A',
    })

    mockCloudflare({
      accounts: [{ id: 'acc-B', name: '账户 B' }],
      namespaces: { 'acc-B': [] },
    })

    const { syncAccount } = await import('../src/menu/config')
    await syncAccount('new-token')

    const { loadConfig } = await import('../src/menu/store')
    const cfg = loadConfig()
    expect(cfg.accountId).toBe('acc-B')
    expect(cfg.kvNamespaceId ?? '').toBe('')
    expect(cfg.panelHost ?? '').toBe('')
    expect(cfg.dataHost ?? '').toBe('')
    expect(cfg.wsPath ?? '').toBe('')
  })

  it('syncAccount：新账号有 KV 但没有实例时也清空旧域名 / WS 路径', async () => {
    writeConfig({
      token: 'old-token',
      accountId: 'acc-A',
      kvNamespaceId: 'kv-A',
      panelHost: 'a.pages.dev',
      dataHost: 'adata.pages.dev',
      wsPath: '/ws-A',
    })

    mockCloudflare({
      accounts: [{ id: 'acc-B', name: '账户 B' }],
      namespaces: { 'acc-B': [{ id: 'kv-B', title: 'kv-B' }] },
    })

    const { syncAccount } = await import('../src/menu/config')
    await syncAccount('new-token')

    const { loadConfig } = await import('../src/menu/store')
    const cfg = loadConfig()
    expect(cfg.accountId).toBe('acc-B')
    expect(cfg.kvNamespaceId).toBe('kv-B')
    // 没有实例 → 不该残留上一个账户的域名 / WS 路径
    expect(cfg.panelHost ?? '').toBe('')
    expect(cfg.dataHost ?? '').toBe('')
    expect(cfg.wsPath ?? '').toBe('')
  })
})
