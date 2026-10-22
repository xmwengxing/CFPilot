/**
 * 本地真连接优选：直接复用 scanner-cli 的库函数
 *
 * ## 为什么能直接复用
 *
 * scanner-cli 的扫描逻辑本来就是库函数（不是 CLI 耦合的）：
 *   - `resolveCandidates()`：网段 → 候选 IP
 *   - `runScan()`：三阶扫描（TCP 初筛 → WS 101 校验 → 下行测速）
 *   - `formatCopyable()`：生成可直接粘贴的 `IP:Port#机房` 列表
 *
 * 这些都在 Electron 主进程里跑（主进程有完整 Node 能力，能开 TLS 套接字），
 * 不需要起子进程，也不需要系统里装 Node。
 *
 * 构建时 scanner-lib 被 esbuild 打成 dist/main/scanner-lib.mjs（ESM），
 * 与主进程的 CJS 产物互不干扰：用动态 import() 加载即可。
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** scanner 的类型（避免编译期跨包引用带来的路径问题） */
export interface ScanEntry {
  ip: string
  port: number
  colo: string
  latency: number
  speed: number
}

export interface ScanEvent {
  type: 'stage' | 'progress' | 'result' | 'done' | 'error'
  stage?: number
  name?: string
  total?: number
  done?: number
  message?: string
  entry?: ScanEntry
  count?: number
}

export interface ScanOptions {
  /** Worker 域名（TLS SNI / HTTP Host） */
  host: string
  /** 端口 */
  port: number
  /** 阶段二校验的 WS 路径 */
  wsPath: string
  /** 阶段三测速路径 */
  probePath: string
  /** 是否跳过测速 */
  skipSpeed: boolean
  /** 候选采样数 */
  sample: number
  /** 保留条数 */
  top: number
  /** 进度回调 */
  onProgress?: (event: ScanEvent) => void
}

/** scanner 库模块 */
interface ScannerLib {
  resolveCandidates: (o: { sample?: number; cidr?: string | string[]; seed?: number }) => Promise<string[]>
  runScan: (o: Record<string, unknown>) => Promise<{
    entries: ScanEntry[]
    stats: Record<string, number>
  }>
  formatCopyable: (e: ScanEntry[]) => string
}

/** 定位 scanner 库文件（构建产物） */
function findScannerLib(): string {
  const candidates = [
    join(__dirname, 'scanner-lib.js'),
    join(__dirname, '../main/scanner-lib.js'),
    join(process.cwd(), 'packages/gui/dist/main/scanner-lib.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `未找到 scanner 库文件，试过：${candidates.join('、')}。请先执行 npm run build -w @cfpilot/gui`
  )
}

/**
 * 执行一次三阶扫描。
 *
 * 库文件与主进程同为 CJS，直接 require 即可。
 */
/**
 * 加载 scanner 库。
 *
 * 库文件与主进程同为 CJS，用 createRequire 从 CJS 上下文加载。
 */
function loadScannerLib(): ScannerLib {
  const libPath = findScannerLib()
  const req = createRequire(__filename)
  return req(libPath) as ScannerLib
}

/**
 * 执行一次三阶扫描。
 */
export async function runLocalScan(options: ScanOptions): Promise<{
  entries: ScanEntry[]
  copyable: string
  stats: Record<string, number>
}> {
  const lib = loadScannerLib()

  const report = (event: ScanEvent): void => {
    options.onProgress?.(event)
  }

  report({ type: 'stage', stage: 1, name: '生成候选 IP', total: 0 })
  const candidates = await lib.resolveCandidates({ sample: options.sample })
  if (candidates.length === 0) {
    report({ type: 'error', message: '未能生成候选 IP（检查网络或用 --cidr 指定网段）' })
    return { entries: [], copyable: '', stats: {} }
  }

  const summary = await lib.runScan({
    host: options.host,
    port: options.port,
    candidates,
    wsPath: options.wsPath,
    probePath: options.probePath,
    skipSpeed: options.skipSpeed,
    top: options.top,
    onProgress: report,
  })

  return {
    entries: summary.entries,
    copyable: lib.formatCopyable(summary.entries),
    stats: summary.stats,
  }
}
