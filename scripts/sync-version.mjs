// 统一版本号：根 package.json 是唯一版本源，本脚本把版本传播到全部 workspace 包。
//
// ## 为什么需要这个脚本（2026-10-24 定版）
//
// 1. 版本漂移事故：version.ts 是硬编码常量，升级 package.json 时漏改它——
//    cfpilot-scanner 发布了 0.3.0，CLI --version 却报 0.2.0。
// 2. 用户要求：所有包版本号统一，无论各包本身是否有代码变动，只要出现更新并升级
//    就同步版本号，免去逐包管理版本号的麻烦。
//
// 因此约定（铁律）：
//   - 根 package.json 的 version 是唯一版本源，任何包都不允许单独改版本号；
//   - 升级版本的唯一入口：npm run version:bump -- <新版本号>（改根 + 全量同步）；
//   - 本脚本同时负责：① 各 workspace 包 package.json 的 version 字段；
//     ② 包内 src/version.ts 的 VERSION / NAME 常量（仅限「脚本生成」的文件）。
//     gui 没有 version.ts（版本由发布 tag 写回 package.json），只同步 package.json。
//     worker-core 的 version.ts 是构建注入的 BUILD_VERSION / VERSION_PATH，
//     与包版本无关且被 entry 引用，禁止覆盖——见下方 GENERATED_VERSION_TS。
//   - publish 前由各包 prepublishOnly 再兜底同步一次，保证 npm 包内版本号不会漂移。
//
// 用法：
//   node scripts/sync-version.mjs              # 同步全部 workspace 包
//   node scripts/sync-version.mjs <包目录>      # 只同步一个包（prepublishOnly 用）
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, obj) => writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`)

/** version.ts 由本脚本生成的标记：没有这个标记的一律视为手写文件，不覆盖 */
const MARKER = '// 本文件由 scripts/sync-version.mjs'

/**
 * 允许生成 src/version.ts 的包（相对仓库根的目录）。
 * 只有这两个包的 version.ts 是纯版本常量；新增 npm 包时把目录加进来。
 * worker-core / gui 不在此列：前者是构建注入文件，后者无此文件。
 */
const GENERATED_VERSION_TS = new Set(['packages/scanner-cli', 'packages/deploy-wizard'])

// 唯一版本源：根 package.json
const rootPkg = readJson(resolve(repoRoot, 'package.json'))
const unifiedVersion = rootPkg.version
if (!/^\d+\.\d+\.\d+/.test(unifiedVersion)) {
  console.error(`[sync-version] 根 package.json 版本号非法：${unifiedVersion}`)
  process.exit(1)
}

const arg = process.argv[2]
const allPackages = rootPkg.workspaces.map((w) => resolve(repoRoot, w))
const targets = arg ? [resolve(repoRoot, arg)] : allPackages

for (const pkgRoot of targets) {
  const rel = relative(repoRoot, pkgRoot).replaceAll('\\', '/')
  const pkgFile = resolve(pkgRoot, 'package.json')
  let pkg
  try {
    pkg = readJson(pkgFile)
  } catch (err) {
    console.error(`[sync-version] 读取 ${pkgFile} 失败：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // ① package.json version 字段
  if (pkg.version === unifiedVersion) {
    console.log(`[sync-version] ${pkg.name} package.json 已是最新 v${unifiedVersion}`)
  } else {
    pkg.version = unifiedVersion
    writeJson(pkgFile, pkg)
    console.log(`[sync-version] ${pkg.name} package.json → v${unifiedVersion}`)
  }

  // ② src/version.ts：仅白名单包生成；其余包有手写文件时原样保留
  if (!GENERATED_VERSION_TS.has(rel)) continue
  const versionFile = resolve(pkgRoot, 'src/version.ts')
  const content = `${MARKER} 从根 package.json 生成，请勿手改
export const VERSION = '${unifiedVersion}'
export const NAME = '${pkg.name}'
`
  let current = ''
  try {
    current = readFileSync(versionFile, 'utf8')
  } catch {
    /* 文件不存在则直接写 */
  }
  if (current && !current.startsWith(MARKER)) {
    console.log(`[sync-version] ${pkg.name} version.ts 为手写文件，跳过（如需接管请先加标记注释）`)
    continue
  }
  if (current === content) {
    console.log(`[sync-version] ${pkg.name} version.ts 已是最新 v${unifiedVersion}`)
  } else {
    writeFileSync(versionFile, content)
    console.log(`[sync-version] ${pkg.name} version.ts → v${unifiedVersion}`)
  }
}
