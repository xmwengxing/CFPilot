/**
 * 构建 CFPilot 界面（纯前端产物，不含任何宿主外壳）。
 *
 * ## 为什么把界面独立成一个包
 *
 * 界面源码原本在 `packages/gui/src/renderer/` 下，而 `gc`（Electron 外壳）
 * 与 Go 版共用它。0.6.4 起不再发布 Electron 版，外壳代码移出仓库，
 * 但**界面本身要继续维护** —— 所以把它抽成独立的 `@cfpilot/ui`：
 *
 *   @cfpilot/ui（本包）  ← 界面源码与构建，唯一来源
 *         ↓ 产物 dist/
 *   packages/desktop     ← go:embed 打进 exe
 *   （本地的 Electron 外壳，不入库） ← 直接消费 dist/
 *
 * 好处：
 *   1. 界面源码不再依附于任何一个外壳，语义清晰
 *   2. 以后即使用别的技术包壳（Tauri / Wails / 纯浏览器），都不用再搬家
 *   3. 界面可以独立构建与校验，不必等整个 Electron 工程
 *
 * ## 产物
 *
 *   dist/index.html    —— 原样拷贝（不做任何注入）
 *   dist/renderer.js   —— 由 src/renderer.ts 打包
 *
 * ⚠️ 这里**不注入 adapter.js**：那是 Go 版专属的适配层，
 *    由 `scripts/build-desktop.mjs` 在拷贝到 desktop 时插入。
 *    本包产出的 index.html 保持纯净，Electron 版与 Go 版都以它为基准。
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const srcDir = join(pkgRoot, 'src')
const outDir = join(pkgRoot, 'dist')

const version = JSON.parse(readFileSync(join(pkgRoot, '..', '..', 'package.json'), 'utf8')).version
console.log(`[ui] 构建 CFPilot 界面 v${version}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// ---- 1. index.html 原样拷贝 ----
copyFileSync(join(srcDir, 'index.html'), join(outDir, 'index.html'))
const htmlKb = (statSync(join(outDir, 'index.html')).size / 1024).toFixed(1)
console.log(`[ui] index.html (${htmlKb} KB)`)

// ---- 2. renderer.ts → renderer.js ----
await build({
  entryPoints: [join(srcDir, 'renderer.ts')],
  outfile: join(outDir, 'renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  // 界面里如果引用了 Node 内置模块，说明写错了 —— 直接报错暴露
  external: [],
})

const jsKb = (statSync(join(outDir, 'renderer.js')).size / 1024).toFixed(1)
console.log(`[ui] renderer.js (${jsKb} KB)`)

// ---- 3. 产物自检：必须含关键元素 ----
const js = readFileSync(join(outDir, 'renderer.js'), 'utf8')
const html = readFileSync(join(outDir, 'index.html'), 'utf8')

const checks = [
  ['renderer.js 引用 window.cfpilot', js.includes('cfpilot')],
  ['renderer.js 有回填逻辑', js.includes('pushScanResults') || js.includes('增量回填')],
  ['index.html 有增量/覆盖回填两个按钮', html.includes('btnPushAppend') && html.includes('btnPushReplace')],
  ['index.html 有网络环境弹窗', html.includes('envModal')],
  ['index.html 无 adapter 注入（应保持纯净）', !html.includes('adapter.js')],

  // 定时任务清单：编辑只针对**单条**任务。
  //
  // 多选后统一编辑本身是错的 —— 各任务设置可能不同，一个字段填什么值
  // 要套到哪些任务上说不清。所以工具栏只留「刷新 / 删除所选」，
  // 编辑入口是每行末尾的「编辑」按钮。
  ['index.html 任务表无「编辑所选」', !html.includes('btnTaskEdit')],
  ['index.html 任务表无「保存应用」', !html.includes('btnTaskSave')],
  ['renderer.js 无「编辑所选」引用', !js.includes('btnTaskEdit')],
  ['renderer.js 有行内「编辑」按钮', js.includes('data-task-edit')],

  // 数据源页：完整优选会写 KV 且耗时 1–3 分钟，入口已撤掉。
  ['index.html 无「一键完整优选」按钮', !html.includes('btnSrcQuick')],
  ['renderer.js 无「一键完整优选」引用', !js.includes('btnSrcQuick')],

  // 可拖曳调高的表格容器（任务表 + 数据源表）
  ['index.html 任务表有拖曳手柄', html.includes('data-resize="taskTableScroll"')],
  ['index.html 数据源表有拖曳手柄', html.includes('data-resize="srcSourcesScroll"')],
  ['index.html 有拖曳手柄样式', html.includes('.table-resizer')],
  ['renderer.js 绑定了拖曳手柄', js.includes('pointerdown')],
]

let bad = 0
for (const [name, ok] of checks) {
  if (!ok) {
    console.error(`[ui] ❌ ${name}`)
    bad++
  }
}
if (bad > 0) {
  console.error(`[ui] 产物自检失败 ${bad} 项`)
  process.exit(1)
}
console.log('[ui] 产物自检通过')
