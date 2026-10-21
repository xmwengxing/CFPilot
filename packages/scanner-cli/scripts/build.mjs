// 构建 cfpilot-scanner CLI：esbuild 打包为单文件 ESM，并加上 shebang
import { build } from 'esbuild'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = resolve(pkgRoot, 'dist')
const outFile = resolve(outDir, 'cli.js')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [resolve(pDir(), 'src/cli.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
})

function pDir() {
  return pkgRoot
}

// 守卫：产物必须以且仅以一个 shebang 开头（源码里不要再写 #!）
const lines = readFileSync(outFile, 'utf8').split('\n')
if (!lines[0].startsWith('#!')) {
  throw new Error('[scanner-cli] 产物缺少 shebang，无法作为可执行命令运行')
}
if (lines[1]?.startsWith('#!')) {
  writeFileSync(outFile, [lines[0], ...lines.slice(2)].join('\n'), 'utf8')
  console.warn('[scanner-cli] 已修正产物中重复的 shebang（源码里不要再写 #!）')
}

chmodSync(outFile, 0o755)
const size = readFileSync(outFile).length
console.log(`[scanner-cli] 已生成 ${outFile} (${(size / 1024).toFixed(1)} KB)`)
