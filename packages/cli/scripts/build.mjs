// 构建 cfpilot CLI：esbuild 打包为单文件 ESM，并加上 shebang
import { build } from 'esbuild'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = resolve(pkgRoot, 'dist')
const outFile = resolve(outDir, 'cli.js')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [resolve(pkgRoot, 'src/cli.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
})

// 守卫：产物必须以且仅以一个 shebang 开头（源码里不要再写 #!）
const lines = readFileSync(outFile, 'utf8').split('\n')
if (!lines[0].startsWith('#!')) {
  throw new Error('[cfpilot] 产物缺少 shebang，无法作为可执行命令运行')
}
if (lines[1]?.startsWith('#!')) {
  writeFileSync(outFile, [lines[0], ...lines.slice(2)].join('\n'), 'utf8')
  console.warn('[cfpilot] 已修正产物中重复的 shebang（源码里不要再写 #!）')
}

// 守卫：部署所需的两个内核资产必须随包分发，否则部署功能不可用。
//
// ⚠️ 必须检查 **control.js + dataplane.js** 两个（Pages 双项目分别上传），
// 只检查合并版 worker.js 会漏掉「只同步了合并版」这个真实事故
// （npm 包缺少 control/dataplane → 部署报「产物为空，跳过部署」）。
//
// 产物是压缩后的 ESM，default 导出形式是 `export{a as default}`，
// 不是 `export default` —— 两种都要认。
const REQUIRED_ASSETS = ['control.js', 'dataplane.js']
let assetTotal = 0
for (const name of REQUIRED_ASSETS) {
  const p = resolve(pkgRoot, 'assets', name)
  if (!existsSync(p)) {
    throw new Error(
      `[cfpilot] 缺少内核资产 assets/${name}\n` +
        '  请执行：npm run build -w @cfpilot/worker-core && npm run build -w cfpilot'
    )
  }
  const text = readFileSync(p, 'utf8')
  const looksLikeKernel =
    text.includes('export default') || /export\s*\{[^}]*as\s+default/.test(text)
  if (!looksLikeKernel || text.length < 10000) {
    throw new Error(
      `[cfpilot] 内核资产异常（assets/${name}，${(text.length / 1024).toFixed(1)} KB）\n` +
        '  请执行：npm run build -w @cfpilot/worker-core && npm run build -w cfpilot'
    )
  }
  assetTotal += text.length
}

chmodSync(outFile, 0o755)
const size = readFileSync(outFile).length
const assetKb = (assetTotal / 1024).toFixed(1)
console.log(`[cfpilot] 已生成 ${outFile} (${(size / 1024).toFixed(1)} KB)`)
console.log(`[cfpilot] 内核资产 ${assetKb} KB`)
