import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { compareSemver, parseVersion } from '../src/shared/version-util'
import {
  fetchRemoteKernelInfo,
  isChannelNewer,
  loadKernelBundle,
  parseKernelVersionManifest,
  versionFromTag,
  CHECKSUMS_ASSET_NAME,
  CONTROL_ASSET_NAME,
  DATA_ASSET_NAME,
} from '../src/deploy/kernel-remote'

/** 算一个内容的 SHA-256（与实现同口径） */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 造一份 sha256sum 格式的内核清单 */
function checksumsFor(control: string, data: string): string {
  return [
    `${sha256(control)}  ${CONTROL_ASSET_NAME}`,
    `${sha256(data)}  ${DATA_ASSET_NAME}`,
    '',
  ].join('\n')
}

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
          {
            name: CHECKSUMS_ASSET_NAME,
            browser_download_url: `https://example.test/dl/${tag}/SHA256SUMS`,
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
  delete process.env.CFPILOT_KERNEL_CHANNEL_BASE
  delete process.env.CFPILOT_KERNEL_DIR
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

  it('拒绝尾随路径穿越等垃圾（审计 D6）', () => {
    expect(versionFromTag('v1.2.3-rc1/../../evil')).toBe('')
    expect(versionFromTag('v1.2.3/../../evil')).toBe('')
    expect(versionFromTag('desktop-v1.2.3foo')).toBe('')
    // 首尾空白被 trim 归一（非安全问题）；内部垃圾才拒绝
    expect(versionFromTag('v1.2.3 ')).toBe('1.2.3')
    // 合法 semver（含预发布/构建后缀）仍接受
    expect(versionFromTag('v1.2.3')).toBe('1.2.3')
    expect(versionFromTag('v1.2.3-rc1')).toBe('1.2.3-rc1')
    expect(versionFromTag('desktop-v1.2.3+build.5')).toBe('1.2.3+build.5')
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
    expect(info!.checksumsUrl).toContain('SHA256SUMS')
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

  it('镜像 API 返回非官方资产 URL 时，下载地址仍按官方模板构造（审计 D1/C2）', async () => {
    // 模拟被接管的镜像 API：资产 URL 全指向攻击者服务器
    const evil = {
      tag_name: 'v9.9.9',
      draft: false,
      prerelease: false,
      assets: [
        { name: CONTROL_ASSET_NAME, browser_download_url: 'https://evil.example/attack/control.js' },
        { name: DATA_ASSET_NAME, browser_download_url: 'https://evil.example/attack/dataplane.js' },
        { name: CHECKSUMS_ASSET_NAME, browser_download_url: 'https://evil.example/attack/SHA256SUMS' },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([evil]))
    const info = await fetchRemoteKernelInfo()
    expect(info).not.toBeNull()
    // 下载地址一律官方构造，绝不取镜像响应里的 URL
    expect(info!.controlUrl).toBe(
      'https://github.com/xmwengxing/CFPilot/releases/download/v9.9.9/cfpilot-kernel-control.js'
    )
    expect(info!.checksumsUrl).toBe(
      'https://github.com/xmwengxing/CFPilot/releases/download/v9.9.9/cfpilot-kernel-SHA256SUMS'
    )
    expect(info!.controlUrl).not.toContain('evil.example')
    expect(info!.dataUrl).not.toContain('evil.example')
    expect(info!.checksumsUrl).not.toContain('evil.example')
  })

  it('携带路径穿越 tag 的发行版被跳过（审计 D6）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([release('v9.9.9/../../evil')]))
    await expect(fetchRemoteKernelInfo()).resolves.toBeNull()
  })
})

describe('loadKernelBundle', () => {
  /** 内置内核的最小内容（要含 export 才像真的产物）。 */
  const builtinControl = 'export default {control:1}'
  const builtinData = 'export default {data:1}'

  /** 远程内核的正常下载链路（含清单） */
  function mockRemoteKernel(control: string, data: string, sums = checksumsFor(control, data)) {
    return async (input: unknown) => {
      const url = String(input)
      // ⚠️ 先按资产名匹配：官方下载 URL 形如 …/releases/download/<tag>/<name>，
      // 也含 '/releases'，必须先于 API 列表分支判定（审计 D1/C2 修复后 URL 官方化）。
      if (url.includes('SHA256SUMS')) return textResponse(sums)
      if (url.includes('control.js')) return textResponse(control)
      if (url.includes('dataplane.js')) return textResponse(data)
      if (url.includes('/releases')) return jsonResponse([release('v9.9.9')])
      throw new Error('unexpected url: ' + url)
    }
  }

  it('远程版本更新 → 用远程内核', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockRemoteKernel('export default {remote:"control"}', 'export default {remote:"data"}')
    )

    const bundle = await loadKernelBundle('0.7.5')
    expect(bundle.version).toBe('9.9.9')
    expect(bundle.source).toContain('远程')
    expect(bundle.control).toContain('remote')
  })

  it('摘要不匹配 → 拒绝远程内核，回退内置并记日志', async () => {
    const control = 'export default {remote:"control"}'
    const data = 'export default {remote:"data"}'
    // 清单里的摘要与真实内容不符（模拟镜像 / 中间人篡改产物）
    const tampered = checksumsFor('别的控制面', '别的数据面')
    vi.spyOn(globalThis, 'fetch').mockImplementation(mockRemoteKernel(control, data, tampered))

    const logs: string[] = []
    const bundle = await loadKernelBundle('0.7.5', { log: (m) => logs.push(m) })
    expect(bundle.source).toContain('内置')
    expect(bundle.control).not.toContain('remote')
    expect(logs.some((l) => l.includes('摘要'))).toBe(true)
  })

  it('缺少校验清单 → 拒绝远程内核', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input)
      // 清单取不到（发行版没发布 / 官方地址不可达）
      if (url.includes('SHA256SUMS')) return textResponse('', false)
      if (url.includes('control.js')) return textResponse('export default {remote:"control"}')
      if (url.includes('dataplane.js')) return textResponse('export default {remote:"data"}')
      if (url.includes('/releases')) return jsonResponse([release('v9.9.9')])
      throw new Error('unexpected url: ' + url)
    })

    const bundle = await loadKernelBundle('0.7.5')
    expect(bundle.source).toContain('内置')
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
      // 产物下载失败（清单本身正常）→ 精确覆盖「下载资产失败」分支
      if (url.includes('control.js') || url.includes('dataplane.js')) return textResponse('', false)
      if (url.includes('SHA256SUMS')) {
        return textResponse(checksumsFor('export default {remote:"control"}', 'export default {remote:"data"}'))
      }
      if (url.includes('/releases')) return jsonResponse([release('v9.9.9')])
      return textResponse('', false)
    })

    const logs: string[] = []
    const bundle = await loadKernelBundle('0.7.5', { log: (m) => logs.push(m) })
    expect(bundle.source).toContain('内置')
    expect(logs.some((l) => l.includes('远程内核'))).toBe(true)
  })

  it('缓存清单被篡改时仍从官方重取并拒绝恶意缓存（审计 C5）', async () => {
    const maliciousControl = 'export default {evil:"control"}'
    const maliciousData = 'export default {evil:"data"}'
    // 预置缓存：本机攻击者植入的恶意产物 + 配套自洽清单
    const dir = join(cacheRoot, '9.9.9')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'control.js'), maliciousControl)
    writeFileSync(join(dir, 'dataplane.js'), maliciousData)
    writeFileSync(join(dir, 'SHA256SUMS'), checksumsFor(maliciousControl, maliciousData))

    // 官方清单对应合法内容（与缓存里的恶意产物不符）
    const legitControl = 'export default {remote:"control"}'
    const legitData = 'export default {remote:"data"}'
    vi.spyOn(globalThis, 'fetch').mockImplementation(mockRemoteKernel(legitControl, legitData))

    const bundle = await loadKernelBundle('0.7.5')
    // 缓存清单不作信任锚：官方重取后，恶意缓存产物校验失败 → 重新下载官方产物
    expect(bundle.control).toContain('remote')
    expect(bundle.control).not.toContain('evil')
    expect(bundle.data).not.toContain('evil')
  })
})

describe('parseKernelVersionManifest', () => {
  it('解析合法清单', () => {
    const m = parseKernelVersionManifest(
      JSON.stringify({ seq: 202611140800, build: 'f4493ce-10650979', minToolVersion: '0.40.6' })
    )
    expect(m).toEqual({ seq: 202611140800, build: 'f4493ce-10650979', minToolVersion: '0.40.6' })
  })

  it('缺 seq / 非整数 / 非正数 / 坏 JSON 都返回 null', () => {
    expect(parseKernelVersionManifest('{}')).toBeNull()
    expect(parseKernelVersionManifest(JSON.stringify({ seq: 1.5 }))).toBeNull()
    expect(parseKernelVersionManifest(JSON.stringify({ seq: -1 }))).toBeNull()
    expect(parseKernelVersionManifest('not-json')).toBeNull()
    expect(parseKernelVersionManifest('[]')).toBeNull()
  })
})

describe('isChannelNewer', () => {
  it('序号更高 → 新', () => {
    expect(isChannelNewer({ seq: 2, build: 'b', minToolVersion: '' }, { seq: 1, build: 'a', minToolVersion: '' })).toBe(true)
    expect(isChannelNewer({ seq: 1, build: 'a', minToolVersion: '' }, { seq: 2, build: 'b', minToolVersion: '' })).toBe(false)
  })

  it('同序号且构建指纹不同 → 新（同序号覆盖发布）', () => {
    expect(isChannelNewer({ seq: 5, build: 'b2', minToolVersion: '' }, { seq: 5, build: 'b1', minToolVersion: '' })).toBe(true)
    expect(isChannelNewer({ seq: 5, build: 'b1', minToolVersion: '' }, { seq: 5, build: 'b1', minToolVersion: '' })).toBe(false)
  })

  it('内置没有清单（旧包）→ 任何通道内核都视为新', () => {
    expect(isChannelNewer({ seq: 1, build: 'a', minToolVersion: '' }, { seq: 0, build: '', minToolVersion: '' })).toBe(true)
  })
})

describe('内核热更新通道（kernel-latest）', () => {
  /** 搭一个内置内核目录（产物 + 内置 VERSION 清单）。 */
  function setupBuiltin(builtin: { seq: number; build: string }): string {
    const dir = join(cacheRoot, 'builtin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'control.js'), 'export default {control:1}')
    writeFileSync(join(dir, 'dataplane.js'), 'export default {data:1}')
    writeFileSync(join(dir, 'cfpilot-kernel-VERSION'), JSON.stringify({ ...builtin, minToolVersion: '' }))
    return dir
  }

  /** 通道 mock：VERSION + 三资产，按 URL 分发。 */
  function mockChannel(
    manifest: { seq: number; build: string; minToolVersion?: string },
    opts: { control?: string; data?: string; sums?: string; assetsFail?: boolean } = {}
  ) {
    const control = opts.control ?? 'export default {channel:"control"}'
    const data = opts.data ?? 'export default {channel:"data"}'
    const sums = opts.sums ?? checksumsFor(control, data)
    return async (input: unknown) => {
      const url = String(input)
      if (url.includes('cfpilot-kernel-VERSION')) {
        return textResponse(JSON.stringify(manifest))
      }
      if (url.includes('SHA256SUMS')) return textResponse(opts.assetsFail ? '' : sums, !opts.assetsFail)
      if (url.includes('control.js')) return textResponse(control, !opts.assetsFail)
      if (url.includes('dataplane.js')) return textResponse(data, !opts.assetsFail)
      if (url.includes('/releases')) return jsonResponse([release('v0.1.0')]) // Release 通道更旧
      throw new Error('unexpected url: ' + url)
    }
  }

  it('通道序号比内置新 → 用通道内核，来源带序号', async () => {
    process.env.CFPILOT_KERNEL_DIR = setupBuiltin({ seq: 202611140000, build: 'aaa-1111' })
    process.env.CFPILOT_KERNEL_CHANNEL_BASE = 'https://channel.test/kernel-latest'
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockChannel({ seq: 202611141000, build: 'bbb-2222' })
    )

    const bundle = await loadKernelBundle('0.40.6')
    expect(bundle.source).toContain('远程内核 k202611141000')
    expect(bundle.source).toContain('bbb-2222')
    expect(bundle.control).toContain('channel')
  })

  it('通道序号不比内置新 → 走包 Release 通道（原有行为）', async () => {
    process.env.CFPILOT_KERNEL_DIR = setupBuiltin({ seq: 202611150000, build: 'aaa-1111' })
    process.env.CFPILOT_KERNEL_CHANNEL_BASE = 'https://channel.test/kernel-latest'
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockChannel({ seq: 202611140000, build: 'bbb-2222' })
    )

    const bundle = await loadKernelBundle('0.40.6')
    // Release mock 给了 v0.1.0（比 0.40.6 旧）→ 最终内置
    expect(bundle.source).toContain('内置')
    expect(bundle.control).not.toContain('channel')
  })

  it('通道要求更高工具版本 → 明确提示，不用远程内核', async () => {
    process.env.CFPILOT_KERNEL_DIR = setupBuiltin({ seq: 202611140000, build: 'aaa-1111' })
    process.env.CFPILOT_KERNEL_CHANNEL_BASE = 'https://channel.test/kernel-latest'
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockChannel({ seq: 202611141000, build: 'bbb-2222', minToolVersion: '99.0.0' })
    )

    const logs: string[] = []
    const bundle = await loadKernelBundle('0.40.6', { log: (m) => logs.push(m) })
    expect(bundle.source).toContain('内置')
    expect(logs.some((l) => l.includes('请先升级'))).toBe(true)
  })

  it('通道产物下载失败 → 回退内置并记日志', async () => {
    process.env.CFPILOT_KERNEL_DIR = setupBuiltin({ seq: 202611140000, build: 'aaa-1111' })
    process.env.CFPILOT_KERNEL_CHANNEL_BASE = 'https://channel.test/kernel-latest'
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockChannel({ seq: 202611141000, build: 'bbb-2222' }, { assetsFail: true })
    )

    const logs: string[] = []
    const bundle = await loadKernelBundle('0.40.6', { log: (m) => logs.push(m) })
    expect(bundle.source).toContain('内置')
    expect(logs.some((l) => l.includes('k202611141000'))).toBe(true)
  })

  it('通道清单不可读（坏 JSON）→ 视为通道不可用，走原有逻辑', async () => {
    process.env.CFPILOT_KERNEL_DIR = setupBuiltin({ seq: 202611140000, build: 'aaa-1111' })
    process.env.CFPILOT_KERNEL_CHANNEL_BASE = 'https://channel.test/kernel-latest'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.includes('cfpilot-kernel-VERSION')) return textResponse('not-json')
      if (url.includes('SHA256SUMS')) return textResponse(checksumsFor('export default {remote:"control"}', 'export default {remote:"data"}'))
      if (url.includes('control.js')) return textResponse('export default {remote:"control"}')
      if (url.includes('dataplane.js')) return textResponse('export default {remote:"data"}')
      if (url.includes('/releases')) return jsonResponse([release('v9.9.9')])
      throw new Error('unexpected url: ' + url)
    })

    const bundle = await loadKernelBundle('0.40.6')
    // Release 通道 v9.9.9 更新 → 用 Release 内核（原有行为不受影响）
    expect(bundle.version).toBe('9.9.9')
  })
})
