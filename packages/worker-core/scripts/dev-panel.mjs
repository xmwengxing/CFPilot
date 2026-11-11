/**
 * 本地预览面板用的 wrangler dev 启动脚本。
 *
 * 用法：node scripts/dev-panel.mjs [端口]（默认 8788）
 *
 * 面板默认的路径是**随机后缀**（每次部署都变），本地没法直接点开链接，
 * 所以这里用 `wrangler.local.jsonc` 固定路径与密码。
 *
 * ⚠️ 单独一个 .mjs 是为了绕开命令行的引号转义：
 *   1. `spawn('npx.cmd', …)` 在 Windows 上报 EINVAL（.cmd 不能直接 spawn）；
 *   2. 走 shell 会把 `--define X:"value"` 的双引号吃掉，wrangler 报
 *      「Invalid define value (must be an entity name or JS literal)」。
 *   解决办法：`--define` 的值改用**单引号**包 JS 字面量 ——
 *   单引号在 cmd 与 PowerShell 里都不会被吃掉。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TXT_LIST_SENTINEL } from './sentinel.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const port = process.argv[2] || '8788'
// 配置文件：默认用本地预览那份；`dev` 脚本传 wrangler.jsonc 走完整形态。
const config = process.argv[3] || 'wrangler.local.jsonc'
// 构建标识：面板「系统内核版本」显示用。`dev` 与 `dev:panel` 原本给的值不同。
const buildLabel = process.argv[4] || 'local-preview'
// 版本号从 package.json 读 —— 写死会随升版失同步。
const pkgVersion = JSON.parse(
  readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')
).version

const args = [
  'dev',
  '--local',
  '--ip',
  '127.0.0.1',
  '--port',
  port,
  '--config',
  config,
  '--define',
  // 哨兵值与 build.mjs 同源；这里同样拆开写，避免明文进仓库。
  `__CFP_SENTINEL__:'${TXT_LIST_SENTINEL}'`,
  '--define',
  `__CFP_BUILD__:'${buildLabel}'`,
  '--define',
  `__CFP_PKG_VERSION__:'${pkgVersion}'`,
]

const wranglerBin = resolve(pkgRoot, '../../node_modules/.bin/wrangler.cmd')
const child = spawn(wranglerBin, args, {
  cwd: pkgRoot,
  stdio: 'inherit',
  shell: true,
})

child.on('exit', (code) => process.exit(code ?? 0))
