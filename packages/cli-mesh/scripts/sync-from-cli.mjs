// 把 packages/cli 的构建产物复制到 cfpilot-mesh 包内。
//
// cfpilot-mesh 与 cfpilot 共用同一份 CLI 源码与 dist（同一 bin: dist/cli.js），
// 只是 npm 包名 / bin 名不同。npm 的 files 不能引用包外路径，
// 所以发布前把 cli 的产物同步进来。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const cliDir = resolve(pkgDir, '..', 'cli')

const cliDist = join(cliDir, 'dist')
if (!existsSync(join(cliDist, 'cli.js'))) {
  console.error('[cli-mesh] 找不到 packages/cli/dist/cli.js，请先运行 npm run build -w cfpilot')
  process.exit(1)
}

for (const d of ['dist', 'assets']) {
  cpSync(join(cliDir, d), join(pkgDir, d), { recursive: true, force: true })
}

// README：基于 cli 的说明，开头说明这是 +mesh 包名
const cliReadme = existsSync(join(cliDir, 'README.md'))
  ? readFileSync(join(cliDir, 'README.md'), 'utf8')
  : '# cfpilot-mesh\n'
const banner = [
  '# cfpilot-mesh',
  '',
  '> 这是 CFPilot CLI 的 **+mesh 组网版** npm 包名，功能与 `cfpilot` 完全一致，',
  '> 额外提供 `cfpilot-mesh mesh <动作>` 子命令（异地组网管理）。',
  '> 两个包同版本发布，可任选其一；需要 mesh 子命令时用本包。',
  '',
  '---',
  '',
].join('\n')
writeFileSync(join(pkgDir, 'README.md'), banner + cliReadme)

console.log('[cli-mesh] 已从 packages/cli 同步 dist / assets / README')
