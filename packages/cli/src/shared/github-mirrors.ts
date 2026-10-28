/**
 * GitHub 访问的镜像回退。
 *
 * ## 为什么需要
 *
 * 国内网络直连 `api.github.com` 经常超时（实测 12 秒超时连不上），
 * 直连 `github.com` 也可能被重置。
 * 结果就是「检查更新」「拉远程内核」这些本来该有兜底的操作直接失败。
 *
 * ## 两层回退
 *
 * ### 一、下载镜像（已有）
 *
 * 把**完整的 github.com URL** 前缀一个代理域名即可：
 *
 *     https://ghfast.top/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
 *
 * 代理会自己去源站取。实测 `ghfast.top` 可用（62KB 的内核产物正常取回）。
 *
 * ### 二、API 镜像（新增，但不可靠）
 *
 * 同理：`https://ghfast.top/https://api.github.com/repos/...`
 * 但实测**多数镜像的 API 通道不通**，只能当最后手段。
 *
 * ### 三、免 API 通道（新增，最可靠）
 *
 * GitHub 的 Releases API 不是唯一入口。`github.com` 上有两个
 * **不需要 API** 的稳定入口：
 *
 *   1. 取最新版本：
 *      `GET https://github.com/<owner>/<repo>/releases/latest`
 *      → 302 重定向到 `.../releases/tag/v0.8.1`
 *      → **从 Location 里就能读出版本号**
 *
 *   2. 取固定名资产：
 *      `GET https://github.com/<owner>/<repo>/releases/latest/download/<固定名>`
 *      → 302 到具体版本的资产
 *
 * 这两个都只用 `github.com` 的 URL，
 * 所以**任何下载镜像都能代理**（上面那层已经好使）。
 *
 * 代价：拿不到「全部资产列表」，只能按**命名约定**构造 URL。
 * 本项目的资产命名是稳定的（见 ASSET_NAMES）：
 *
 *   cfpilot-<版本>-<os>-<arch>[.exe]   桌面版三平台
 *   cfpilot-kernel-control.js           数据面内核（固定名）
 *   cfpilot-kernel-dataplane.js         控制面内核（固定名）
 *   CFPilot-control.zip / CFPilot-dataplane.zip
 *
 * ⚠️ 与 Go 版 packages/desktop/internal/update/update.go 语义一致
 * （AGENTS.md §2.2：两端行为必须一致）。
 */

/** 一个下载镜像。 */
export interface Mirror {
  /** 镜像名（用于日志与提示） */
  name: string
  /** URL 前缀，用法：prefix + 完整原始 URL */
  prefix: string
}

/**
 * 下载镜像列表（按实测可用性排序）。
 *
 * 顺序很重要：第一个成功的就用它，所以把实测可用的放前面。
 */
export const MIRRORS: Mirror[] = [
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
]

/**
 * GitHub 仓库。
 *
 * 两端必须一致（改了要同步 Go 版）。
 */
export const GITHUB_OWNER = 'xmwengxing'
export const GITHUB_REPO = 'CFPilot'

/** Releases API 基址。 */
export const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

/** github.com 上的发行版页基址（免 API 通道用）。 */
export const RELEASES_WEB = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

/**
 * 固定名资产（与版本无关）。
 *
 * 可以直接用 `releases/latest/download/<名字>` 取，不用先知道版本。
 */
export const FIXED_ASSET_NAMES = {
  kernelControl: 'cfpilot-kernel-control.js',
  kernelData: 'cfpilot-kernel-dataplane.js',
  controlZip: 'CFPilot-control.zip',
  dataZip: 'CFPilot-dataplane.zip',
} as const

/**
 * 桌面版平台资产的命名模板。
 *
 * 与 Go 版 internal/update/update.go 的资产名保持一致。
 */
export function desktopAssetName(version: string, os: string, arch: string): string {
  const ext = os === 'windows' ? '.exe' : ''
  return `cfpilot-${version}-${os}-${arch}${ext}`
}

/**
 * 生成一个「下载候选源」列表：直连 + 各镜像。
 *
 * @param url 原始的 github.com / api.github.com 完整 URL
 */
export function downloadSources(url: string): Array<{ name: string; url: string }> {
  const sources: Array<{ name: string; url: string }> = [{ name: 'GitHub', url }]
  for (const m of MIRRORS) {
    sources.push({ name: m.name, url: m.prefix + url })
  }
  return sources
}

/**
 * 生成一个「API 查询候选源」列表：直连 + 各镜像。
 *
 * @param apiUrl api.github.com 的完整 URL
 */
export function apiSources(apiUrl: string): Array<{ name: string; url: string }> {
  const sources: Array<{ name: string; url: string }> = [{ name: 'GitHub API', url: apiUrl }]
  for (const m of MIRRORS) {
    sources.push({ name: `${m.name} API`, url: m.prefix + apiUrl })
  }
  return sources
}

/**
 * 从「免 API 通道」解析最新版本号。
 *
 * 做法：`GET <repo>/releases/latest` → 302 → Location 里带 `tag/v0.8.1`。
 *
 * ⚠️ 用 `redirect: 'manual'` 手动处理重定向：
 * - Node 的 fetch 默认**跟随**重定向，拿到的是最终页面（HTML），拿不到 Location；
 * - 浏览器的 fetch 同样默认跟随，而且**跨域时读不到 Location 头**。
 *
 * 所以这里对每一级都手动跟一步，只跟到拿到 Location 为止。
 *
 * @param timeoutMs 超时
 * @returns 版本号（如 "0.8.1"），失败返回空串
 */
export async function fetchLatestVersionWithoutApi(timeoutMs: number): Promise<string> {
  const url = `${RELEASES_WEB}/latest`

  for (const source of downloadSources(url)) {
    try {
      const response = await fetch(source.url, {
        headers: { 'User-Agent': 'CFPilot-CLI' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 3xx：Location 里有版本号
      const location = response.headers.get('location') ?? ''
      const version = versionFromReleaseUrl(location)
      if (version) return version
      // 某些代理会把 302 吃掉直接返回 200 —— 那就说明它代理得不对，放弃
    } catch {
      // 试下一个源
    }
  }
  return ''
}

/**
 * 从发行版 URL 里解析版本号。
 *
 * 支持：
 *   https://github.com/owner/repo/releases/tag/v0.8.1  → 0.8.1
 *   .../releases/download/v0.8.1/cfpilot-kernel-control.js → 0.8.1
 */
export function versionFromReleaseUrl(url: string): string {
  if (!url) return ''
  const m = url.match(/\/releases\/(?:tag|download)\/v?([0-9]+(?:\.[0-9]+)*)/i)
  return m ? m[1]! : ''
}
