/**
 * 把 worker-core 的构建产物同步为 cfpilot 的内置资产。
 *
 * 发布到 npm 后，用户不需要本地编译内核就能直接部署。
 *
 * ## ⚠️ 必须同步**三个**文件，不只是合并版
 *
 * Pages 双项目部署需要**分别**上传控制面与数据面：
 *   control.js    → 控制面（面板 / 订阅）
 *   dataplane.js  → 数据面（代理入站）
 *
 * 早期这里只复制合并版 `worker.js`（单项目时代的产物），
 * 于是发布到 npm 的包**缺少 control.js / dataplane.js**，
 * `loadBundle()` 找不到文件 → 部署直接报「产物为空，跳过部署」。
 *
 * 即：npx cfpilot deploy 在 npm 上是坏的。
 * 合并版 worker.js 仍然保留（兼容旧调用方），但不再是部署所需。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const monorepo = resolve(pkgRoot, '../..')
const distDir = resolve(monorepo, 'packages/worker-core/dist')
const targetDir = resolve(pkgRoot, 'assets')

/** 要同步的产物：文件名 → 说明。 */
const ASSETS = [
  { file: 'control.js', desc: '控制面（面板 / 订阅）' },
  { file: 'dataplane.js', desc: '数据面（代理入站）' },
  { file: 'worker.js', desc: '合并版（兼容保留）' },
]

// 产物缺失时自动构建 worker-core
//
// ⚠️ npm workspaces 按字母序执行：cli < worker-core，
// 所以 `npm run build --workspaces` 时 cli 会先跑，
// 那时 worker-core/dist 还不存在。这里自动补构建。
const needBuild = ASSETS.some((a) => !existsSync(resolve(distDir, a.file)))
if (needBuild) {
  console.log('[cfpilot] worker-core 产物缺失，正在构建…')
  const { execSync } = await import('node:child_process')
  try {
    execSync('npm run build -w @cfpilot/worker-core', {
      cwd: monorepo,
      stdio: 'inherit',
    })
  } catch {
    console.error('[cfpilot] 自动构建 worker-core 失败')
    console.error('[cfpilot] 请手动执行：npm run build -w @cfpilot/worker-core')
    process.exit(1)
  }
}

mkdirSync(targetDir, { recursive: true })

let total = 0
for (const asset of ASSETS) {
  const source = resolve(distDir, asset.file)
  if (!existsSync(source)) {
    console.error(`[cfpilot] 缺少 worker-core/dist/${asset.file}，构建未产出？`)
    process.exit(1)
  }
  const target = resolve(targetDir, asset.file)
  copyFileSync(source, target)
  const kb = statSync(target).size / 1024
  total += kb
  console.log(`[cfpilot] 已同步 ${asset.file} (${kb.toFixed(1)} KB) — ${asset.desc}`)
}

console.log(`[cfpilot] 内核资产合计 ${total.toFixed(1)} KB → assets/`)
