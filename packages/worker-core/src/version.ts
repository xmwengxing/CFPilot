/**
 * 构建版本标识。
 *
 * 由 scripts/build.mjs 通过 esbuild 的 define 注入；
 * 直接运行源码（未构建）时为 'dev'。
 */
declare const __CFP_BUILD__: string | undefined

/** 当前构建版本号 */
export const BUILD_VERSION: string =
  typeof __CFP_BUILD__ === 'string' ? __CFP_BUILD__ : 'dev'

/** 版本查询路径：部署向导用它判断线上跑的是否与本地产物同版本 */
export const VERSION_PATH = '/__cfp_version'

/** 版本查询响应 */
export function versionResponse(): Response {
  return new Response(JSON.stringify({ build: BUILD_VERSION, ts: Date.now() }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
