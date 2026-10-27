import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { compareSemver, parseVersion } from '../src/shared/version-util'
import {
  fetchRemoteKernelInfo,
  loadKernelBundle,
  versionFromTag,
  CONTROL_ASSET_NAME,
  DATA_ASSET_NAME,
} from '../src/deploy/kernel-remote'

/** 造一个 GitHub Release 响应项。 */
function release(tag: string, opts: { withAssets?: boolean; draft?: boolean; prerelease?: boolean } = {}) {
  const withAssets = opts.withAssets !== false
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    assets: withAssets
      ? [
          {
            name: CONTROL_ASSET_NAME,
            browser_download_url: `https://example.test/dl/${tag}/control.js`,
          },
          {
            name: DATA_ASSET_NAME,
            browser_download_url: `https://example.test/dl/${tag}/dataplane.js`,
          },
        ]
      : [],
  }
}

/**
 * 造一个 Response 替身。
 *
 * ⚠️ 必须带 `headers`（含 get 方法）与 `body`：
 * 真实 fetch 的 Response 一定有这两个，下载逻辑会读
 * `headers.get('content-length')` 与 `body.getReader()`。
 * 少了就会抛 TypeError，被当成「下载失败」。
 */
function makeResponse(opts: {
  ok?: boolean
  status?: number
  text: string
  json?: unknown
}): Response {
  const ok = opts.ok !== false
  const body = opts.text
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(body.length) : null) },
    text: async () => body,
    json: async () => (opts.json !== undefined ? opts.json : JSON.parse(body)),
    body: null, // null → 走 text() 分支
  } as unknown as Response
}

/** 造一个 JSON Response 替身。 */
function jsonResponse(body: unknown, ok = true): Response {
  return makeResponse({ ok, text: JSON.stringify(body), json: body })
}

/** 造一个文本 Response 替身（内核产物）。 */
function textResponse(text: string, ok = true): Response {
  return makeResponse({ ok, text })
}

/**
 * 每个用例独立的缓存目录。
 *
 * ⚠️ 必须隔离：内核下载会缓存到 `~/.cfpilot/kernel/<版本>/`，
 * 缓存命中时**不下载** —— 前一个用例缓存的产物会让后一个用例
 * 拿到「远程」结果，掩盖下载失败等分支。
 */
let cacheRoot = ''

beforeEach(() => {
  cacheRoot = join(
    tmpdir(),
    `cfpilot-kernel-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  process.env.CFPILOT_KERNEL_CACHE_DIR = cacheRoot
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.CFPILOT_KERNEL_CACHE_DIR
  if (cacheRoot) {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

describe('compareSemver', () => {
  it('比较数字三段', () => {
    expect(compareSemver('0.7.5', '0.7.4')).toBeGreaterThan(0)
    expect(compareSemver('0.7.4', '0.7.5')).toBeLessThan(0)
    expect(compareSemver('0.7.5', '0.7.5')).toBe(0)
  })

  it('按位比较（不是字符串比较）', () => {
    // 字符串比较会认为 '0.10.0' < '0.9.0'
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('支持 v 前缀', () => {
    expect(compareSemver('v0.8.0', '0.7.9')).toBeGreaterThan(0)
    expect(compareSemver('v0.8.0', 'v0.8.0')).toBe(0)
  })

  it('解析不出来的一方视为更旧', () => {
    expect(compareSemver('', '0.7.5')).toBeLessThan(0)
    expect(compareSemver('0.7.5', '')).toBeGreaterThan(0)
    expect(compareSemver('', '')).toBe(0)
    expect(compareSemver('garbage', '0.7.5')).toBeLessThan(0)
  })

  it('预发布版本比正式版本旧', () => {
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0)
  })

  it('parseVersion 能解析常见形态', () => {
    expect(parseVersion('0.7.5')).not.toBeNull()
    expect(parseVersion('v0.7.5')).not.toBeNull()
    expect(parseVersion('0.7')).not.toBeNull()
    expect(parseVersion('not-a-version')).toBeNull()
  })
})

describe('versionFromTag', () => {
  it('剥掉已知前缀', () => {
    expect(versionFromTag('v0.7.5')).toBe('0.7.5')
    expect(versionFromTag('desktop-v0.7.5')).toBe('0.7.5')
    expect(versionFromTag('gui-v0.7.5')).toBe('0.7.5')
  })

  it('未知前缀或非法版本返回空串', () => {
    expect(versionFromTag('release-0.7.5')).toBe('')
    expect(versionFromTag('vnotaversion')).toBe('')
    expect(versionFromTag('')).toBe('')
  })
})

describe('fetchRemoteKernelInfo', () => {
  it('取最新且带完整内核资产的发行版', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        release('v0.7.5'),
        release('v0.7.6'),
        release('v0.7.7', { withAssets: false }), // 没有内核资产 → 跳过
      ])
    )
    const info = await fetchRemoteKernelInfo()
    expect(info).not.toBeNull()
    expect(info!.version).toBe('0.7.6')
    expect(info!.controlUrl).toContain('control.js')
    expect(info!.dataUrl).toContain('dataplane.js')
  })

  it('跳过 draft 与 prerelease', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        release('v0.8.0', { draft: true }),
        release('v0.7.9', { prerelease: true }),
        release('v0.7.5'),
      ])
    )
    const info = await fetchRemoteKernelInfo()
    expect(info!.version).toBe('0.7.5')
  })

  it('网络不可达时返回 null（不抛错）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    await expect(fetchRemoteKernelInfo()).resolves.toBeNull()
  })

  it('非 200 时返回 null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, false))
    await expect(fetchRemoteKernelInfo()).resolves.toBeNull()
  })
})

describe('loadKernelBundle', () => {
  /** 内置内核的最小内容（要含 export 才像真的产物）。 */
  const builtinControl = 'export default {control:1}'
  const builtinData = 'export default {data:1}'

  it('远程版本更新 → 用远程内核', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/releases')) {
        return jsonResponse([release('v9.9.9')])
      }
      if (url.includes('control.js')) return textResponse('export default {remote:"control"}')
      if (url.includes('dataplane.js')) return textResponse('export default {remote:"data"}')
      throw new Error('unexpected url: ' + url)
    })

    const bundle = await loadKernelBundle('0.7.5')
    expect(bundle.version).toBe('9.9.9')
    expect(bundle.source).toContain('远程')
    expect(bundle.control).toContain('remote')
  })

  it('远程版本不更新 → 用内置内核', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/releases')) {
        return jsonResponse([release('v0.7.0')]) // 比当前旧
      }
      throw new Error('unexpected url: ' + url)
    })

    const bundle = await loadKernelBundle('0.7.5')
    expect(bundle.version).toBe('0.7.5')
    expect(bundle.source).toContain('内置')
  })

  it('远程不可达 → 回退内置，不抛错', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const bundle = await loadKernelBundle('0.7.5')
    expect(bundle.version).toBe('0.7.5')
    expect(bundle.source).toContain('内置')
    expect(bundle.control.length).toBeGreaterThan(0)
  })

  it('远程下载失败 → 回退内置并记录日志', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/releases')) {
        return jsonResponse([release('v9.9.9')])
      }
      // 下载资产时失败
      return textResponse('', false)
    })

    const logs: string[] = []
    const bundle = await loadKernelBundle('0.7.5', { log: (m) => logs.push(m) })
    expect(bundle.source).toContain('内置')
    expect(logs.some((l) => l.includes('远程内核'))).toBe(true)
  })
})
