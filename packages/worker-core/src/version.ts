/**
 * 构建版本标识。
 *
 * 由 scripts/build.mjs 通过 esbuild 的 define 注入；
 * 直接运行源码（未构建）时为 'dev'。
 */
declare const __CFP_BUILD__: string | undefined
declare const __CFP_PKG_VERSION__: string | undefined

/** 当前构建版本号（`<git短hash>-<源码内容哈希>`，精确到内容） */
export const BUILD_VERSION: string =
  typeof __CFP_BUILD__ === 'string' ? __CFP_BUILD__ : 'dev'

/**
 * 语义版本号（如 `0.9.4`），构建期从 `packages/worker-core/package.json` 注入。
 *
 * 与 `BUILD_VERSION` 分工：
 *   - `PKG_VERSION` 人读友好 —— 用户看它确认「部署的是哪个版本」；
 *   - `BUILD_VERSION` 精确到内容 —— 程序看它判断「线上与本地是不是同一份代码」。
 */
export const PKG_VERSION: string =
  typeof __CFP_PKG_VERSION__ === 'string' ? __CFP_PKG_VERSION__ : 'dev'

/** 版本查询路径：部署向导用它判断线上跑的是否与本地产物同版本 */
export const VERSION_PATH = '/__cfp_version'

/** 版本查询响应 */
export function versionResponse(): Response {
  return new Response(
    JSON.stringify({ build: BUILD_VERSION, version: PKG_VERSION, ts: Date.now() }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    }
  )
}
