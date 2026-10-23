// 版本升级唯一入口：改根 package.json 版本号，然后全量同步到各 workspace 包。
//
// 用法：
//   npm run version:bump -- 0.4.0     # 显式指定
//   npm run version:bump -- patch     # 0.3.0 → 0.3.1
//   npm run version:bump -- minor     # 0.3.0 → 0.4.0
//   npm run version:bump -- major     # 0.3.0 → 1.0.0
//
// 只改根 package.json 并调用 sync-version.mjs；是否提交由调用方决定。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const rootPkgFile = resolve(repoRoot, 'package.json')

const input = process.argv[2]
if (!input) {
  console.error('用法：npm run version:bump -- <新版本号|major|minor|patch>')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(rootPkgFile, 'utf8'))
const cur = pkg.version
const semver = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur)
if (!semver) {
  console.error(`根 package.json 版本号无法解析：${cur}`)
  process.exit(1)
}

let next
if (['major', 'minor', 'patch'].includes(input)) {
  const [maj, min, pat] = [Number(semver[1]), Number(semver[2]), Number(semver[3])]
  if (input === 'major') next = `${maj + 1}.0.0`
  else if (input === 'minor') next = `${maj}.${min + 1}.0`
  else next = `${maj}.${min}.${pat + 1}`
} else if (/^\d+\.\d+\.\d+$/.test(input)) {
  next = input
} else {
  console.error(`版本号格式不正确：${input}（应为 x.y.z 或 major/minor/patch）`)
  process.exit(1)
}

if (next === cur) {
  console.log(`[bump-version] 版本号无变化（${cur}），仅执行同步`)
} else {
  pkg.version = next
  writeFileSync(rootPkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`[bump-version] 根 package.json v${cur} → v${next}`)
}

execFileSync(process.execPath, [resolve(here, 'sync-version.mjs')], { stdio: 'inherit' })
