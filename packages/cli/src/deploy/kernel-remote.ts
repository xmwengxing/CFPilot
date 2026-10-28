/**
 * 内核产物的远程获取（GitHub Releases）与本地回退。
 *
 * ## 为什么需要远程内核
 *
 * 内核产物（control.js / dataplane.js）原先**内置在 npm 包里**
 * （`packages/cli/assets/`），于是**部署用的代码被应用版本绑死**：
 * 用户没升级 npm 包，就只能部署旧内核。
 *
 * 现在每个 Release 都会发布两个内核资产：
 *
 *   cfpilot-kernel-control.js
 *   cfpilot-kernel-dataplane.js
 *
 * 部署前先查一下远程有没有更新的内核，有就用远程的 ——
 * 应用版本与内核版本从此解耦。
 *
 * ## 零第三方依赖（铁律）
 *
 * `packages/cli` 是 npm 包（`cfpilot`），必须能被 `npx -y` 秒级拉起，
 * 因此这里**只用 Node 内置模块**（node:fs / node:path / node:os）与
 * 全局 fetch（Node 18+ 自带），不引入任何第三方运行时依赖。
 *
 * ## 网络失败不抛错
 *
 * 查不到远程 / 下载失败 / GitHub 不可达，都是**正常情况**（离线、限流、
 * 仓库还没发新版），一律回退到**本地内置产物**继续部署，
 * 只在返回值里把 `source` 标成「内置 x.y.z」，让调用方能提示用户。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareSemver } from '../shared/version-util'
import {
  RELEASES_WEB,
  apiSources,
  downloadSources,
  fetchLatestVersionWithoutApi,
} from '../shared/github-mirrors'

/** 控制面内核产物在 Release 里的附件名。 */
export const CONTROL_ASSET_NAME = 'cfpilot-kernel-control.js'
/** 数据面内核产物在 Release 里的附件名。 */
export const DATA_ASSET_NAME = 'cfpilot-kernel-dataplane.js'

/** GitHub 仓库。 */
const REPO = 'xmwengxing/CFPilot'

/** GitHub Releases API（可被环境变量覆盖，测试用）。 */
const RELEASES_API =
  process.env.CFPILOT_KERNEL_API_BASE ?? `https://api.github.com/repos/${REPO}/releases`

/** 远程查询 / 下载的默认超时时间（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 20_000

/** 单个内核产物的字节数上限（10MB）。 */
const MAX_ASSET_BYTES = 10 * 1024 * 1024

/** 缓存根目录的环境变量（测试用）。 */
const CACHE_DIR_ENV = 'CFPILOT_KERNEL_CACHE_DIR'
/** 本地内置内核目录的环境变量（测试 / 开发用）。 */
const LOCAL_DIR_ENV = 'CFPILOT_KERNEL_DIR'
/** 关闭远程内核获取的环境变量（设为 0 / false / off 即关闭）。 */
const REMOTE_OFF_ENV = 'CFPILOT_KERNEL_REMOTE'

/**
 * 构建指纹的正则。
 *
 * 产物里的形式：`var BUILD_VERSION = "a946dfa-1f2e3d4c"`。
 * 早期格式是纯数字时间戳（`202610251200`），一并兼容。
 */
const BUILD_RE = /["']([0-9a-f]{7,10}-(?:[0-9a-f]{4,16}|[0-9]{12}))["']/
const BUILD_NUMERIC_RE = /["'](\d{10,14})["']/

/** 远程可用内核的信息。 */
export interface RemoteKernelInfo {
  /** 内核版本（semver，如 "0.7.6"） */
  version: string
  /** 控制面产物下载地址 */
  controlUrl: string
  /** 数据面产物下载地址 */
  dataUrl: string
}

/** 实际用于部署的内核。 */
export interface KernelBundle {
  /** 控制面产物源码 */
  control: string
  /** 数据面产物源码 */
  data: string
  /** 内核版本（semver） */
  version: string
  /** 来源说明（"远程 0.7.6" / "内置 0.7.5"） */
  source: string
}

/* ------------------------------------------------------------------ */
/* GitHub Releases                                                     */
/* ------------------------------------------------------------------ */

interface GitHubAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets?: GitHubAsset[]
}

/**
 * 从 tag 里提取版本号（不含前缀）。
 *
 * 接受的 tag 形态（与 Go 版 isReleaseTag 保持一致）：
 *   v         —— 当前正式（release-desktop.yml 的 tag_name）
 *   desktop-v —— Go 版工作流触发用
 *   gui-v     —— Electron 时代过渡
 *
 * 不是合法 semver 时返回空串。
 */
export function versionFromTag(tag: string): string {
  const text = tag.trim()
  for (const prefix of ['desktop-v', 'gui-v', 'v']) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length)
      return /^\d+\.\d+\.\d+/.test(rest) ? rest : ''
    }
  }
  return ''
}

/**
 * 查询最新 Release 里的内核资产；查不到返回 null（**不要抛错**）。
 *
 * 「最新」的定义：**版本号最高的、且同时带两个内核资产的发行版**。
 *
 * 跳过 draft 与 prerelease —— 预发布版不该被当成正式内核发出去。
 */
export async function fetchRemoteKernelInfo(
  options: { timeoutMs?: number } = {}
): Promise<RemoteKernelInfo | null> {
  // 显式关闭远程（受限网络 / 离线环境 / 自动化流水线）
  if (isRemoteDisabled()) return null

  const releases = await fetchReleasesWithFallback(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (releases.length === 0) {
    // 连 API 与免 API 通道都拿不到 —— 按「查不到」处理
    return null
  }

  // 按版本降序排列（同版本时以先出现者为准）
  const sorted = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ release, version: versionFromTag(release.tag_name) }))
    .filter((item) => item.version !== '')
    .sort((a, b) => compareSemver(b.version, a.version))

  for (const item of sorted) {
    const controlUrl = findAssetUrl(item.release.assets ?? [], CONTROL_ASSET_NAME)
    const dataUrl = findAssetUrl(item.release.assets ?? [], DATA_ASSET_NAME)
    if (!controlUrl || !dataUrl) {
      // 这个发行版没带完整的内核资产，跳过
      continue
    }
    return { version: item.version, controlUrl, dataUrl }
  }
  return null
}

/**
 * 查 Release 列表，带**镜像回退**。
 *
 * ## 三级通道
 *
 *  1. 直连 `api.github.com`
 *  2. 镜像代理的 `api.github.com`（实测多数镜像的 API 通道不通，但有的能用）
 *  3. **免 API 通道**：只用 `github.com` 的 URL
 *     （`releases/latest` 的 302 里带版本号）——
 *     这条最可靠，因为**任何下载镜像都能代理 github.com**。
 *
 * 第 3 条拿不到「全部资产列表」，只能按命名约定构造已知资产名的 URL。
 * 对本项目够用：内核两个产物的名字是**固定名**。
 *
 * @returns 拿到的发行版列表；全失败返回空数组
 */
async function fetchReleasesWithFallback(timeoutMs: number): Promise<GitHubRelease[]> {
  // ---- 通道 1 + 2：API（含镜像）----
  const apiUrl = `${RELEASES_API}?per_page=20`
  for (const source of apiSources(apiUrl)) {
    try {
      const response = await fetch(source.url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CFPilot-CLI',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) continue
      const payload: unknown = await response.json()
      if (!Array.isArray(payload)) continue
      const releases = payload.filter(isGitHubRelease)
      if (releases.length > 0) return releases
    } catch {
      // 试下一个源
    }
  }

  // ---- 通道 3：免 API ----
  const version = await fetchLatestVersionWithoutApi(timeoutMs)
  if (!version) return []

  // 按固定名构造两个内核资产的 URL
  const controlUrl = `${RELEASES_WEB}/latest/download/${CONTROL_ASSET_NAME}`
  const dataUrl = `${RELEASES_WEB}/latest/download/${DATA_ASSET_NAME}`
  const pseudo: GitHubRelease = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: CONTROL_ASSET_NAME, browser_download_url: controlUrl },
      { name: DATA_ASSET_NAME, browser_download_url: dataUrl },
    ],
  }
  return [pseudo]
}

/** 在附件列表里找指定名字的资产下载地址。 */
function findAssetUrl(assets: GitHubAsset[], name: string): string {
  for (const asset of assets) {
    if (asset.name.trim().toLowerCase() === name) return asset.browser_download_url
  }
  return ''
}

/**
 * 远程内核是否被显式关闭。
 *
 * 受限网络 / 离线环境里，每次部署都去连 GitHub 会平白拖慢；
 * 设 `CFPILOT_KERNEL_REMOTE=0` 即可只用内置内核。
 */
function isRemoteDisabled(): boolean {
  const raw = process.env[REMOTE_OFF_ENV]?.trim().toLowerCase()
  if (!raw) return false
  return ['0', 'false', 'no', 'off'].includes(raw)
}

/** 收窄 GitHub Releases 的响应项。 */
function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (typeof item.tag_name !== 'string') return false
  if (item.assets !== undefined && !Array.isArray(item.assets)) return false
  return true
}

/* ------------------------------------------------------------------ */
/* 下载与缓存                                                          */
/* ------------------------------------------------------------------ */

/**
 * 下载单个内核产物。
 *
 * 带 20 秒超时与 10MB 大小上限（防止下到 HTML 错误页或垃圾数据）。
 */
async function downloadAsset(url: string, timeoutMs: number): Promise<string> {
  if (!url.trim()) throw new Error('下载地址为空')

  // 直连 + 各镜像（国内直连 GitHub 经常超时）
  const errors: string[] = []
  for (const source of downloadSources(url)) {
    try {
      const response = await fetch(source.url, {
        headers: { 'User-Agent': 'CFPilot-CLI' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        errors.push(`${source.name}: HTTP ${response.status}`)
        continue
      }

      // 先看 Content-Length，能提前拒掉明显超限的
      const declared = response.headers.get('content-length')
      if (declared) {
        const size = Number(declared)
        if (Number.isFinite(size) && size > MAX_ASSET_BYTES) {
          errors.push(`${source.name}: 超过 ${MAX_ASSET_BYTES} 字节上限`)
          continue
        }
      }

      return await readBodyWithLimit(response)
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`所有下载源均失败 —— ${errors.join('；')}`)
}

/**
 * 读取响应体，超过上限就中断。
 *
 * 不能直接 `res.text()`：那是**先下完再判断**，一个超大文件能把内存吃光。
 */
async function readBodyWithLimit(response: Response): Promise<string> {
  const body = response.body
  if (!body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_ASSET_BYTES) {
      throw new Error(`内核产物超过 ${MAX_ASSET_BYTES} 字节上限，疑似异常内容`)
    }
    return text
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk = value as Uint8Array
      total += chunk.byteLength
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`内核产物超过 ${MAX_ASSET_BYTES} 字节上限，疑似异常内容`)
      }
      // stream: true 让跨 chunk 的多字节字符不被截断
      out += decoder.decode(chunk, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  out += decoder.decode()
  return out
}

/** 缓存根目录。 */
function cacheRoot(): string {
  const override = process.env[CACHE_DIR_ENV]?.trim()
  if (override) return override
  return join(homedir(), '.cfpilot', 'kernel')
}

/** 某个版本的内核缓存目录。 */
function cacheDir(version: string): string {
  return join(cacheRoot(), version)
}

/** 读缓存文件；没有或为空时返回 null。 */
async function readCached(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** 原子写缓存文件（先写临时文件再改名）。 */
async function writeCached(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // ⚠️ 临时文件必须和目标**同目录** —— 跨磁盘 rename 会失败（EXDEV）
  const tmp = `${path}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, path)
  } catch {
    // 缓存写失败不影响本次使用，只是下次要重新下载
    await writeFile(path, content, 'utf8').catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* 本地内置产物                                                        */
/* ------------------------------------------------------------------ */

/**
 * 当前模块所在目录（同时兼容 ESM 与 CJS）。
 *
 * CLI 以 ESM 运行（import.meta.url 可用），
 * GUI 会把本模块打成 CJS 库（import.meta 为 undefined，需用 __dirname）。
 */
function moduleDir(): string {
  try {
    const meta = import.meta
    if (meta && typeof meta.url === 'string') return dirname(fileURLToPath(meta.url))
  } catch {
    /* CJS 产物：import.meta 不存在，走下面的 __dirname */
  }
  return typeof __dirname === 'string' ? __dirname : process.cwd()
}

/**
 * 读取本地内置的内核产物。
 *
 * 候选路径的含义：
 *   - `../worker-core/dist/`   打包后（packages/cli/dist/）的同级目录
 *   - `../../worker-core/dist/` 开发时（packages/cli/src/deploy/）的仓库根
 *   - `../assets/`             npm 包内置资产（packages/cli/assets/）
 *   - `../../assets/`          源码目录下的同一份资产
 *   - `cwd/packages/worker-core/dist/` 以仓库根为 cwd 时的兜底
 */
export async function loadBuiltinBundle(fileName: string): Promise<string> {
  const override = process.env[LOCAL_DIR_ENV]?.trim()
  const candidates = override
    ? [resolve(override, fileName)]
    : [
        resolve(moduleDir(), `../worker-core/dist/${fileName}`),
        resolve(moduleDir(), `../../worker-core/dist/${fileName}`),
        resolve(moduleDir(), `../assets/${fileName}`),
        resolve(moduleDir(), `../../assets/${fileName}`),
        resolve(process.cwd(), `packages/worker-core/dist/${fileName}`),
      ]
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, 'utf8')
      if (text.length > 0) return text
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    `未找到 ${fileName}，请先执行 npm run build -w @cfpilot/worker-core`
  )
}

/** 从产物源码里提取构建指纹；读不到返回空串。 */
export function extractBuildVersion(source: string): string {
  const matched = BUILD_RE.exec(source)
  if (matched?.[1]) return matched[1]
  const numeric = BUILD_NUMERIC_RE.exec(source)
  if (numeric?.[1]) return numeric[1]
  return ''
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 取「应该用于部署」的内核。
 *
 * 远程版本比 currentVersion 新 → 用远程；否则用本地内置。
 *
 * 网络失败（离线 / 限流 / 下载中断）**不会抛错**，一律回退本地内置产物，
 * 并在 `source` 里标明来源是「内置」。
 *
 * @param currentVersion 当前应用版本（semver），用于和远程版本比大小
 * @param options.log 日志回调（用于提示「远程不可用，已回退内置」）
 */
export async function loadKernelBundle(
  currentVersion: string,
  options: { log?: (message: string) => void; timeoutMs?: number } = {}
): Promise<KernelBundle> {
  const log = options.log ?? (() => {})
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const remote = await fetchRemoteKernelInfo({ timeoutMs })

  if (remote && compareSemver(remote.version, currentVersion) > 0) {
    try {
      const bundle = await fetchRemoteKernel(remote, timeoutMs)
      return {
        control: bundle.control,
        data: bundle.data,
        version: remote.version,
        source: `远程 ${remote.version}`,
      }
    } catch (err) {
      // 远程下载失败 → 落回本地内置（不抛错：离线是正常情况）
      log(
        `· 远程内核 ${remote.version} 获取失败，改用内置内核：` +
          (err instanceof Error ? err.message : String(err))
      )
    }
  }

  const control = await loadBuiltinBundle('control.js')
  const data = await loadBuiltinBundle('dataplane.js')
  return {
    control,
    data,
    version: currentVersion,
    source: `内置 ${currentVersion}`,
  }
}

/**
 * 取指定版本的远程内核产物（优先命中缓存）。
 */
async function fetchRemoteKernel(
  info: RemoteKernelInfo,
  timeoutMs: number
): Promise<{ control: string; data: string }> {
  const dir = cacheDir(info.version)
  const controlPath = join(dir, 'control.js')
  const dataPath = join(dir, 'dataplane.js')

  // ---- 1. 命中缓存就不下载 ----
  const cachedControl = await readCached(controlPath)
  const cachedData = await readCached(dataPath)
  if (cachedControl && cachedData) {
    return { control: cachedControl, data: cachedData }
  }

  // ---- 2. 下载 ----
  const control = cachedControl ?? (await downloadAsset(info.controlUrl, timeoutMs))
  const data = cachedData ?? (await downloadAsset(info.dataUrl, timeoutMs))
  if (!control.trim()) throw new Error('下载到的控制面产物为空')
  if (!data.trim()) throw new Error('下载到的数据面产物为空')

  // ---- 3. 落缓存（失败不影响本次使用，只是下次要重新下载）----
  await writeCached(controlPath, control).catch(() => undefined)
  await writeCached(dataPath, data).catch(() => undefined)

  return { control, data }
}
