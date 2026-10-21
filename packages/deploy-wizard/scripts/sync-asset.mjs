// 将 worker-core 的构建产物同步为 deploy-wizard 内置资产
// （发布到 npm 时用户无需本地编译即可部署）
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const monorepo = resolve(pkgRoot, '../..')
const source = resolve(monorepo, 'packages/worker-core/dist/worker.js')
const targetDir = resolve(pkgRoot, 'assets')
const target = resolve(targetDir, 'cfpilot-worker.js')

if (!existsSync(source)) {
  console.error('[deploy-wizard] 未找到 worker-core 构建产物，请先执行：npm run build -w @cfpilot/worker-core')
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
console.log(`[deploy-wizard] 已同步内核资产 ${target}`)
