/**
 * 多账户隔离的回归测试。
 *
 * ## 为什么需要
 *
 * CLI 的配置是**扁平单文件**（`~/.cfpilot/config.json`），
 * 没有 profiles 数组。历史上出过两类串号：
 *
 *  1. **「新 Token + 旧账户的 KV / 域名 / WS 路径」**
 *     —— `saveConfig` 是合并语义，换 Token 时旧字段全部留存。
 *  2. **「账号取自 accounts[0] + KV 取自本地配置」**
 *     —— 两者可以分属不同账号。
 *
 * 另外还有一类「读不到 ≠ 不存在」：
 * KV 归属判定把 403 / 网络错误当成「键不存在」→ 落到 `empty`（不阻断）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CloudflareClient } from '../src/deploy/cf-api'
import { inspectKvOwnership } from '../src/deploy/pages-deploy'

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
 * 装一个假的 fetch，按 URL 路由。
 *
 * ⚠️ Cloudflare API 的响应是**信封**格式 `{ success, result }`，
 * `readApiResponse` 会取 `result`；直接返回数组会被判「格式无效」。
 */
function mockFetch(routes: Record<string, () => Response>): string[] {
  const hits: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      hits.push(url)
      for (const [pattern, handler] of Object.entries(routes)) {
        if (url.includes(pattern)) return handler()
      }
      return new Response('not found', { status: 404 })
    })
  )
  return hits
}

/** 造一个 Cloudflare 风格的信封响应。 */
function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ------------------------------------------------------------------
// B9：读不到 ≠ 不存在
// ------------------------------------------------------------------

describe('B9：KV 读失败不能当成「键不存在」', () => {
  it('getKvValue 在 403 时抛错（不返回 null）', async () => {
    mockFetch({ '/values/': () => new Response('forbidden', { status: 403 }) })
    const client = new CloudflareClient({ token: 't' })
    await expect(client.getKvValue('acc', 'ns', 'CONFIG')).rejects.toThrow(/无法确认归属/)
  })

  it('getKvValue 在 404 时返回 null（键确实不存在）', async () => {
    mockFetch({ '/values/': () => new Response('not found', { status: 404 }) })
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
    mockFetch({ '/values/': () => new Response('forbidden', { status: 403 }) })
    const client = new CloudflareClient({ token: 't' })
    const info = await inspectKvOwnership(client, 'acc', 'ns', 'some-project')
    expect(info.verdict).not.toBe('empty')
    expect(info.blocking).toBe(true)
  })

  it('归属判定：确实为空时仍判定 empty（不阻断）', async () => {
    mockFetch({ '/values/': () => new Response('not found', { status: 404 }) })
    const client = new CloudflareClient({ token: 't' })
    const info = await inspectKvOwnership(client, 'acc', 'ns', 'some-project')
    expect(info.verdict).toBe('empty')
    expect(info.blocking).toBe(false)
  })
})

// ------------------------------------------------------------------
// B4：换 Token 时清空上一个账户的字段
// ------------------------------------------------------------------

describe('B4：换 Token 必须清空上一个账户的字段', () => {
  it('syncAccount 失败时不留下旧账户的 KV / 域名 / WS 路径', async () => {
    // 预置一份「上一个账户」的配置
    mkdirSync(workDir, { recursive: true })
    writeFileSync(
      join(workDir, 'config.json'),
      JSON.stringify({
        token: 'old-token',
        accountId: 'acc-A',
        accountName: '账户 A',
        kvNamespaceId: 'kv-A',
        panelHost: 'a.pages.dev',
        dataHost: 'adata.pages.dev',
        wsPath: '/ws-A',
      }),
      'utf8'
    )

    // 让 listAccounts 失败 → syncFromCloud 走 catch 分支
    mockFetch({
      '/accounts': () => new Response('boom', { status: 500 }),
    })

    const { syncAccount } = await import('../src/menu/config')
    await syncAccount('new-token')

    const { loadConfig } = await import('../src/menu/store')
    const cfg = loadConfig()
    // 关键：旧账户的 KV / 域名 / WS 路径**不能**残留
    expect(cfg.kvNamespaceId ?? '').toBe('')
    expect(cfg.panelHost ?? '').toBe('')
    expect(cfg.dataHost ?? '').toBe('')
    expect(cfg.wsPath ?? '').toBe('')
    expect(cfg.accountId ?? '').toBe('')
  })

  it('syncAccount 成功时 wsPath 会被更新成当前实例的', async () => {
    mkdirSync(workDir, { recursive: true })
    writeFileSync(
      join(workDir, 'config.json'),
      JSON.stringify({
        token: 'old-token',
        accountId: 'acc-A',
        kvNamespaceId: 'kv-A',
        wsPath: '/ws-A',
      }),
      'utf8'
    )

    const manifest = {
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
    }

    mockFetch({
      // ⚠️ 顺序要紧：清单的 URL 里也含 `/storage/kv/namespaces`，
      // 所以更精确的 `values/CFP_DEPLOY_MANIFEST` 必须排在前面。
      'values/CFP_DEPLOY_MANIFEST': () =>
        new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      '/accounts/acc-B/storage/kv/namespaces': () =>
        envelope([{ id: 'kv-B', title: 'kv-B' }]),
      '/accounts?per_page=50': () => envelope([{ id: 'acc-B', name: '账户 B' }]),
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
})
