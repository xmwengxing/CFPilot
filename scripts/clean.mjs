// 清理构建产物与本地调试状态
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const targets = [
  'packages/worker-core/dist',
  'packages/scanner-cli/dist',
  'packages/deploy-wizard/dist',
  'packages/worker-core/.wrangler',
  'packages/worker-core/src/ui/panel.generated.ts',
]

for (const target of targets) {
  rmSync(resolve(root, target), { recursive: true, force: true })
  console.log(`[clean] 已删除 ${target}`)
}
