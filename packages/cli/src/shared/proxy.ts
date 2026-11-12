/**
 * 让 CLI 走用户配置的代理。
 *
 * ## 为什么需要
 *
 * CLI 要访问 GitHub（查版本、下载内核），而国内网络下直连 GitHub 常常超时。
 * 用户在 PowerShell 里设了 `$env:HTTPS_PROXY`，却发现**依然连不上** ——
 * 因为 Node 的 `fetch`（undici）**默认不读环境变量**，
 * 必须显式打开 `NODE_USE_ENV_PROXY=1`（Node 24+ 内置）。
 *
 * 这个开关只能在**进程启动前**设置（undici 在模块加载时读它），
 * 所以必须在入口处、任何 fetch 之前设好。
 *
 * ## 与桌面版的语义一致
 *
 * 桌面版（Go）走的是：环境变量 → Windows 系统代理 → 直连。
 * CLI 读不到 Windows 系统代理（那是 GUI 侧的能力），
 * 但用户在终端里设环境变量是常规做法 —— 两边至少都认环境变量。
 */

/**
 * 打开 fetch 的环境变量代理支持。
 *
 * 必须在**第一次 fetch 之前**调用。
 *
 * @returns 是否真的打开了（false = 当前 Node 不支持，或用户没设代理变量）
 */
export function enableEnvProxy(): boolean {
  // 用户显式关掉了就别管
  if (process.env.NODE_USE_ENV_PROXY === '0') return false

  // 没有任何代理变量可读就别开
  const hasProxyVar = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(
    (key) => (process.env[key] ?? '').trim() !== ''
  )
  if (!hasProxyVar) return false

  // 已经有值就别覆盖（用户可能自己设了）
  if (process.env.NODE_USE_ENV_PROXY === '1') return true

  process.env.NODE_USE_ENV_PROXY = '1'
  return true
}

/**
 * 描述当前会用的代理（用于日志与排障）。
 *
 * @returns 代理说明；没设代理时返回「直连」
 */
export function describeProxy(): string {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const raw = (process.env[key] ?? '').trim()
    if (raw) return `${key} ${raw}`
  }
  return '直连'
}
