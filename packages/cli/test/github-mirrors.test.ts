/**
 * GitHub 镜像回退的测试。
 *
 * ## 为什么测
 *
 * 国内直连 `api.github.com` 经常超时（实测 12 秒超时连不上）。
 * 没有回退的话，「拉远程内核」会直接失败 —— 用户只能拿到旧的内置内核，
 * 而内置内核是跟着 npm 包版本走的，等于「升级应用才能升级内核」。
 *
 * 覆盖三条通道：
 *   1. 直连 API
 *   2. 镜像代理的 API
 *   3. 免 API 通道（`releases/latest` 的 302 里带版本号）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  MIRRORS,
  apiSources,
  downloadSources,
  fetchLatestVersionWithoutApi,
  versionFromReleaseUrl,
  desktopAssetName,
} from '../src/shared/github-mirrors'

/** 记录每次 fetch 的 URL，便于断言「依次尝试了哪些源」。 */
let fetched: string[] = []

/** 装一个假的 fetch。 */
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    fetched.push(String(url))
    return await handler(String(url), init)
  }))
}

beforeEach(() => {
  fetched = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('镜像源列表', () => {
  it('downloadSources 的第一项是直连', () => {
    const sources = downloadSources('https://github.com/a/b/releases/download/v1/x')
    expect(sources[0]!.name).toBe('GitHub')
    expect(sources[0]!.url).toBe('https://github.com/a/b/releases/download/v1/x')
  })

  it('downloadSources 每个镜像都是「前缀 + 原始 URL」', () => {
    const url = 'https://github.com/a/b'
    for (const source of downloadSources(url).slice(1)) {
      expect(source.url.endsWith(url)).toBe(true)
      expect(source.url.startsWith('https://')).toBe(true)
    }
  })

  it('apiSources 同样以直连开头', () => {
    const sources = apiSources('https://api.github.com/repos/a/b/releases')
    expect(sources[0]!.url).toBe('https://api.github.com/repos/a/b/releases')
    expect(sources.length).toBe(MIRRORS.length + 1)
  })

  it('镜像列表非空且前缀都是 https', () => {
    expect(MIRRORS.length).toBeGreaterThan(0)
    for (const m of MIRRORS) {
      expect(m.prefix.startsWith('https://')).toBe(true)
      expect(m.name.length).toBeGreaterThan(0)
    }
  })
})

describe('versionFromReleaseUrl', () => {
  it('从 tag 链接解析版本', () => {
    expect(versionFromReleaseUrl('https://github.com/o/r/releases/tag/v0.8.1')).toBe('0.8.1')
  })

  it('从 download 链接解析版本', () => {
    expect(
      versionFromReleaseUrl('https://github.com/o/r/releases/download/v0.8.1/file.zip')
    ).toBe('0.8.1')
  })

  it('多段版本号也能解析', () => {
    expect(versionFromReleaseUrl('https://github.com/o/r/releases/tag/v1.2.3')).toBe('1.2.3')
  })

  it('非发行版链接返回空串', () => {
    expect(versionFromReleaseUrl('https://github.com/o/r')).toBe('')
    expect(versionFromReleaseUrl('')).toBe('')
  })
})

describe('desktopAssetName', () => {
  it('windows 带 .exe', () => {
    expect(desktopAssetName('0.8.1', 'windows', 'amd64')).toBe('cfpilot-0.8.1-windows-amd64.exe')
  })

  it('linux 不带扩展名', () => {
    expect(desktopAssetName('0.8.1', 'linux', 'arm64')).toBe('cfpilot-0.8.1-linux-arm64')
  })
})

describe('fetchLatestVersionWithoutApi', () => {
  it('从 302 的 Location 里读出版本', async () => {
    mockFetch(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/o/r/releases/tag/v0.9.3' },
      })
    )
    const version = await fetchLatestVersionWithoutApi(5000)
    expect(version).toBe('0.9.3')
  })

  it('直连失败后自动改用镜像', async () => {
    mockFetch(async (url) => {
      if (url.startsWith('https://github.com/')) {
        throw new Error('直连超时')
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/o/r/releases/tag/v0.9.3' },
      })
    })
    const version = await fetchLatestVersionWithoutApi(5000)
    expect(version).toBe('0.9.3')
    expect(fetched.length).toBeGreaterThan(1)
    expect(fetched[0]).toContain('github.com')
  })

  it('所有源都失败时返回空串（不抛错）', async () => {
    mockFetch(async () => {
      throw new Error('网络不通')
    })
    const version = await fetchLatestVersionWithoutApi(1000)
    expect(version).toBe('')
  })

  it('用 redirect: manual（否则读不到 Location）', async () => {
    const seen: (RequestInit | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(init)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/o/r/releases/tag/v1.0.0' },
      })
    }))
    await fetchLatestVersionWithoutApi(5000)
    expect(seen[0]?.redirect).toBe('manual')
  })
})
