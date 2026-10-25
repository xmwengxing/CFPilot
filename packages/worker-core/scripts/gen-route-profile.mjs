// 生成内嵌分流规则的 TypeScript 模块。
//
// Worker 运行时无法读取外部文件，因此 ini 必须编译进内核。
// 做法与 gen-panel.mjs 一致：gzip 后 Base64 嵌入，运行时解压一次。
//
// ⚠️ 可复现：不加时间戳，只对 ini 内容求哈希 ——
// ini 没变则产物稳定，CI 的资产校验才不会误报。
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const iniPath = resolve(pkgRoot, 'assets/route-profiles.ini')
const generatedPath = resolve(pkgRoot, 'src/route-profile.generated.ts')

const source = readFileSync(iniPath, 'utf8')
const gz = gzipSync(Buffer.from(source, 'utf8'), { level: 9 })
const b64 = gz.toString('base64')
const sha = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12)

const module = `/**
 * 内嵌分流规则配置 —— **由 scripts/gen-route-profile.mjs 自动生成，请勿手改**。
 *
 * 源文件：packages/worker-core/assets/route-profiles.ini
 * 内容哈希：${sha}
 *
 * 运行时通过 DecompressionStream 解压（只做一次，结果缓存在模块作用域）。
 * 为什么要内联：Worker 运行时读不到仓库里的文件，而铁律 8 要求零运行时依赖，
 * 因此不能改成「订阅时 fetch 远端配置」。
 */
const GZIP_BASE64 = '${b64}'

let cached: string | null = null

/** 解出 ini 原文（isolate 内只解压一次） */
export async function loadRouteProfileText(): Promise<string> {
  if (cached !== null) return cached
  const bytes = Uint8Array.from(atob(GZIP_BASE64), (c) => c.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  cached = await new Response(stream).text()
  return cached
}

/** 内容哈希（用于日志 / 排查「内置配置是哪一版」） */
export const ROUTE_PROFILE_SHA = '${sha}'
`

writeFileSync(generatedPath, module, 'utf8')
console.log(
  `[worker-core] 已生成 src/route-profile.generated.ts（原始 ${source.length}B → gzip+base64 ${b64.length}B，sha ${sha}）`
)
