/**
 * 把 worker-core 的构建产物同步为 cfpilot 的内置资产。
 *
 * 发布到 npm 后，用户不需要本地编译内核就能直接部署。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const monorepo = resolve(pkgRoot, '../..')
const source = resolve(monorepo, 'packages/worker-core/dist/worker.js')
const targetDir = resolve(pkgRoot, 'assets')
const target = resolve(targetDir, 'cfpilot-worker.js')

// 产物缺失时自动构建 worker-core
//
// ⚠️ npm workspaces 按字母序执行：cli < worker-core，
// 所以 `npm run build --workspaces` 时 cli 会先跑，
// 那时 worker-core/dist 还不存在。这里自动补构建。
if (!existsSync(source)) {
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

if (!existsSync(source)) {
  console.error('[cfpilot] 构建后仍找不到 worker-core/dist/worker.js')
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
const kb = (statSync(target).size / 1024).toFixed(1)
console.log(`[cfpilot] 已同步内核资产 → assets/cfpilot-worker.js (${kb} KB)`)
