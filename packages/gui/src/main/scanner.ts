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
  /** probe 模式的测速路径 */
  probePath: string
  /** 是否跳过测速 */
  skipSpeed: boolean
  /** 候选采样数 */
  sample: number
  /** 保留条数 */
  top: number
  /** 测速方式：auto（默认，按目标是否提供探针端点决定）/ probe / url */
  speedMode?: 'auto' | 'probe' | 'url'
  /** 公开测速地址（url 模式） */
  speedUrl?: string
  /** 进入测速的候选数 */
  speedLimit?: number
  /** 测速并发连接数 */
  speedConnections?: number
  /** 测速时长（ms） */
  speedDurationMs?: number
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
  detectProxyInterference: (host?: string) => Promise<{
    clean: boolean
    findings: Array<{ message: string; advice: string }>
  }>
  /** 决定测速方式：目标有探针端点则 probe，否则 url */
  resolveSpeedMode: (
    host: string,
    probePath: string,
    explicit?: 'probe' | 'url' | 'auto'
  ) => Promise<{ mode: 'probe' | 'url'; reason: string }>
  /** 预检并挑选可用的公开测速地址 */
  pickAvailableSpeedUrl: (candidates: string[]) => Promise<string>
  SPEED_URL_PRESETS: Array<{ url: string; label: string }>
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
 *
 * 测速方式自动决策：
 *   - 目标有 CFPilot 探针端点 → probe 模式（走项目自身路径，最忠实）
 *   - 否则 → url 模式（公开测速地址，任何项目都能测出速度）
 *
 * 两种方式都只作用于**已通过 101 校验**的 IP，所以不会产出 -1 节点。
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
    report({ type: 'error', message: '未能生成候选 IP（检查网络或用自定义网段）' })
    return { entries: [], copyable: '', stats: {} }
  }

  // 测速方式：用户显式指定优先，否则按目标是否提供探针端点自动选择
  let speedMode: 'probe' | 'url' = 'probe'
  let speedUrl = options.speedUrl ?? ''
  if (!options.skipSpeed) {
    const decided = await lib.resolveSpeedMode(options.host, options.probePath, options.speedMode)
    speedMode = decided.mode
    report({ type: 'stage', stage: 0, name: decided.reason, total: 0 })
    if (speedMode === 'url') {
      speedUrl = await lib.pickAvailableSpeedUrl([
        speedUrl,
        ...lib.SPEED_URL_PRESETS.map((p: { url: string }) => p.url),
      ])
    }
  }

  const summary = await lib.runScan({
    host: options.host,
    port: options.port,
    candidates,
    wsPath: options.wsPath,
    probePath: options.probePath,
    skipSpeed: options.skipSpeed,
    speedMode,
    speedUrl,
    speedConnections: options.speedConnections,
    speedDurationMs: options.speedDurationMs,
    speedLimit: options.speedLimit,
    top: options.top,
    onProgress: report,
  })

  return {
    entries: summary.entries,
    copyable: lib.formatCopyable(summary.entries),
    stats: summary.stats,
  }
}

/**
 * 检测本机是否有代理工具在接管流量。
 *
 * 复用 scanner-cli 的 net-env 模块 —— 命令行版与图形版共用同一套判定，
 * 避免两边口径不一致。
 */
export async function detectProxyInterference(host?: string): Promise<{
  clean: boolean
  findings: Array<{ message: string; advice: string }>
}> {
  const lib = loadScannerLib()
  if (typeof lib.detectProxyInterference !== 'function') {
    return { clean: true, findings: [] }
  }
  return await lib.detectProxyInterference(host)
}
