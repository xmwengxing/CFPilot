// 构建 cfpilot-deploy CLI
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
  entryPoints: [resolve(pkgRoot, 'src/cli.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
})

// 守卫：产物必须以且仅以一个 shebang 开头。
// 源码里若也写了 #!，esbuild 会让两行 #! 同时出现，
// 而 Node 只认第一行，第二行会直接抛 SyntaxError。
const lines = readFileSync(outFile, 'utf8').split('\n')
if (!lines[0].startsWith('#!')) {
  throw new Error('[deploy-wizard] 产物缺少 shebang，无法作为可执行命令运行')
}
if (lines[1]?.startsWith('#!')) {
  writeFileSync(outFile, [lines[0], ...lines.slice(2)].join('\n'), 'utf8')
  console.warn('[deploy-wizard] 已修正产物中重复的 shebang（源码里不要再写 #!）')
}

chmodSync(outFile, 0o755)
console.log(`[deploy-wizard] 已生成 ${outFile}`)
