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
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'

const REPO = 'xmwengxing/CFPilot'
const API = `https://api.github.com/repos/${REPO}/releases`

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

/** 下载新版本到临时目录 */
export async function downloadUpdate(
  url: string,
  win: BrowserWindow | null,
  onProgress?: (received: number, total: number) => void
): Promise<string> {
  const dir = join(app.getPath('temp'), 'cfpilot-update')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = join(dir, 'CFPilot-new.exe')

  const response = await fetch(url, {
    headers: { 'User-Agent': 'CFPilot-GUI' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const source = Readable.fromWeb(response.body as never)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.(received, total)
  })
  await pipeline(source, createWriteStream(target))
  return target
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
