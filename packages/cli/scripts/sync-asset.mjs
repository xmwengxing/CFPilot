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

if (!existsSync(source)) {
  console.error('[cfpilot] 未找到 worker-core 构建产物')
  console.error('[cfpilot] 请先执行：npm run build -w @cfpilot/worker-core')
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
const kb = (statSync(target).size / 1024).toFixed(1)
console.log(`[cfpilot] 已同步内核资产 → assets/cfpilot-worker.js (${kb} KB)`)
