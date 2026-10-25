/**
 * 应用内更新
 *
 * 不用 electron-updater：它依赖代码签名与特定的更新服务器配置。
 * 这里直接查 GitHub Releases API，下载 portable exe 并替换自己——
 * 对本项目够用，且没有签名要求（用户手动确认后才执行）。
 *
 * ## 流程
 *
 * 1. 查 Releases 列表，找 tag 为 `gui-v*` 的最新版本
 * 2. 与当前版本比较；有新版本就下载对应的 portable exe
 * 3. 下载完成后，提示用户重启应用完成替换
 * 4. 替换由外部脚本执行：本进程正在运行，无法直接覆盖自己
 *
 * ## 镜像回退（2026-10-25）
 *
 * GitHub 的 `objects.githubusercontent.com` 在国内经常连不上或极慢。
 * 因此下载按以下顺序尝试，任一个成功即停：
 *
 *   1. 直连 GitHub（`browser_download_url`）
 *   2. `ghproxy` 类镜像（前缀代理原 URL）
 *   3. `jsDelivr`（仅对仓库文件有效，对 Release 资产通常无效，作为最后兜底）
 *
 * 每个源失败都会在日志里说明原因，用户能看到「卡在哪个源」。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'

const REPO = 'xmwengxing/CFPilot'
const API = `https://api.github.com/repos/${REPO}/releases`

/**
 * 下载镜像前缀。
 *
 * 用法：`<prefix><原始 URL>`。这些是社区维护的 GitHub 加速代理，
 * 只代理 HTTPS 的 github 域名；不改变文件内容。
 *
 * ⚠️ 第三方镜像**可能失效或篡改内容**，因此：
 *   - 只在直连失败时才用；
 *   - 用完不做签名校验（本项目没签名），但会在日志里明确提示走的是镜像。
 */
const DOWNLOAD_MIRRORS = [
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
]

export interface ReleaseInfo {
  version: string
  tag: string
  url: string
  publishedAt: string
  notes: string
}

export interface UpdateCheckResult {
  current: string
  latest: string | null
  hasUpdate: boolean
  downloadUrl: string | null
  notes: string
  error?: string
}

/** 解析语义化版本号（忽略前缀与非数字段） */
function parseVersion(tag: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(tag)
  if (!m) return [0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 比较两个版本：a > b 返回正数 */
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 拉取 Releases 列表（只取未预发布） */
async function fetchReleases(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${API}?per_page=20`, {
    headers: {
      'User-Agent': 'CFPilot-GUI',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    throw new Error(`GitHub API 返回 ${response.status}`)
  }
  const data = (await response.json()) as unknown
  if (!Array.isArray(data)) throw new Error('GitHub API 返回格式异常')
  return data as Array<Record<string, unknown>>
}

/** 找到最新的 GUI 版本发行版 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const result: UpdateCheckResult = {
    current,
    latest: null,
    hasUpdate: false,
    downloadUrl: null,
    notes: '',
  }
  try {
    const releases = await fetchReleases()
    const candidates = releases
      .filter((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('gui-v'))
      .filter((r) => r.draft !== true && r.prerelease !== true)
      .map((r) => {
        const tag = String(r.tag_name)
        const assets = (r.assets ?? []) as Array<Record<string, unknown>>
        const portable = assets.find(
          (a) => typeof a.name === 'string' && a.name.includes('portable') && a.name.endsWith('.exe')
        )
        return {
          tag,
          version: tag.replace(/^gui-v/, ''),
          url: typeof portable?.browser_download_url === 'string' ? portable.browser_download_url : null,
          publishedAt: String(r.published_at ?? ''),
          notes: String(r.body ?? ''),
        }
      })
      .filter((c) => c.url !== null)
      .sort((a, b) => compare(parseVersion(b.tag), parseVersion(a.tag)))

    const latest = candidates[0]
    if (!latest) {
      result.error = '没有找到 GUI 发行版'
      return result
    }
    result.latest = latest.version
    result.notes = latest.notes.slice(0, 2000)
    result.downloadUrl = latest.url
    result.hasUpdate = compare(parseVersion(latest.tag), parseVersion(current)) > 0
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }
}

/** 下载进度回调 */
export interface DownloadProgress {
  /** 已下载字节 */
  received: number
  /** 总字节（0 表示服务端没给 content-length） */
  total: number
  /** 当前尝试的源名称（`GitHub` / `ghproxy.net` …） */
  source: string
  /** 第几次尝试（从 1 开始） */
  attempt: number
}

/**
 * 从单个 URL 下载，失败抛错。
 *
 * 内部完成：建目录 → fetch → 流式写盘 → 校验大小。
 * 失败时删掉半截文件，避免下一轮被误判成「已下载」。
 */
async function downloadFrom(
  url: string,
  target: string,
  sourceName: string,
  attempt: number,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CFPilot-GUI' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const source = Readable.fromWeb(response.body as never)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.({ received, total, source: sourceName, attempt })
  })

  try {
    await pipeline(source, createWriteStream(target))
  } catch (err) {
    // 清掉半截文件，否则下次可能被当成完整包
    try {
      rmSync(target, { force: true })
    } catch {
      /* 忽略 */
    }
    throw err
  }

  // 有 content-length 时校验完整性（镜像有时会截断）
  if (total > 0 && received !== total) {
    try {
      rmSync(target, { force: true })
    } catch {
      /* 忽略 */
    }
    throw new Error(`下载不完整：${received}/${total} 字节`)
  }

  return target
}

/**
 * 下载新版本到临时目录。
 *
 * ## 镜像回退（2026-10-25）
 *
 * 依次尝试：直连 GitHub → 各镜像。任一成功即返回。
 * 每个源失败都会通过 `onLog` 告诉调用方，用户能看到卡在哪。
 *
 * @param url     GitHub 原始下载地址
 * @param onLog   日志回调（可选）
 * @param onProgress 进度回调（可选）
 */
export async function downloadUpdate(
  url: string,
  _win: BrowserWindow | null,
  onProgress?: (p: DownloadProgress) => void,
  onLog?: (message: string, level: 'info' | 'warn' | 'err' | 'ok') => void
): Promise<string> {
  const dir = join(app.getPath('temp'), 'cfpilot-update')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = join(dir, 'CFPilot-new.exe')

  // 候选源：直连优先，镜像兜底
  const sources = [
    { name: 'GitHub', url },
    ...DOWNLOAD_MIRRORS.map((m) => ({ name: m.name, url: `${m.prefix}${url}` })),
  ]

  const errors: string[] = []
  for (const [index, source] of sources.entries()) {
    const attempt = index + 1
    if (attempt > 1) {
      onLog?.(`直连失败，改用镜像 ${source.name}…`, 'warn')
    } else {
      onLog?.(`从 ${source.name} 下载…`, 'info')
    }
    try {
      const file = await downloadFrom(source.url, target, source.name, attempt, onProgress)
      if (attempt > 1) {
        onLog?.(`已通过镜像 ${source.name} 下载完成（注意：第三方镜像，建议核对版本号）`, 'warn')
      } else {
        onLog?.(`下载完成（${source.name}）`, 'ok')
      }
      return file
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${source.name}: ${message}`)
      onLog?.(`${source.name} 下载失败：${message}`, 'err')
    }
  }

  throw new Error(`所有下载源均失败 —— ${errors.join('；')}`)
}

/**
 * 用新版本替换当前可执行文件。
 *
 * 当前进程正占用着 exe，无法直接覆盖，因此：
 *   1. 把新文件放到 exe 同目录（.new.exe）
 *   2. 写一个替换脚本，等本进程退出后执行
 *   3. 脚本删掉旧 exe、把新文件改名、再重新启动
 */
export async function applyUpdate(
  newFile: string,
  win: BrowserWindow | null
): Promise<{ ok: boolean; error?: string }> {
  try {
    const exePath = app.getPath('exe')
    const exeDir = dirname(exePath)
    const staged = join(exeDir, 'CFPilot.new.exe')
    const script = join(exeDir, 'cfpilot-update.cmd')

    // 复制到 exe 同目录（替换时需要同卷）
    readFileSync(newFile)
    writeFileSync(staged, readFileSync(newFile))

    // 替换脚本：等本进程退出后再动文件
    const cmd = [
      '@echo off',
      'timeout /t 3 /nobreak >nul',
      `del /f /q "${exePath}"`,
      `move /y "${staged}" "${exePath}"`,
      `del /f /q "${script}"`,
      `start "" "${exePath}"`,
      'exit',
    ].join('\r\n')
    writeFileSync(script, cmd, 'utf8')

    // 启动脚本后退出本进程
    // 用 spawn（而非 execFile）：detached 是 spawn 的选项，execFile 不支持
    spawn('cmd', ['/c', 'start', '', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    setTimeout(() => {
      win?.webContents.send('log', { message: '正在重启以完成更新…', level: 'ok', at: Date.now() })
      app.quit()
    }, 800)

    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    win?.webContents.send('log', { message: '更新失败：' + message, level: 'err', at: Date.now() })
    return { ok: false, error: message }
  }
}

/** 清理临时下载文件 */
export function cleanupUpdateFiles(): void {
  try {
    const dir = join(app.getPath('temp'), 'cfpilot-update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

/** 临时文件大小（用于日志） */
export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
