// 构建 cfpilot-scanner CLI：esbuild 打包为单文件 ESM，并加上 shebang
import { build } from 'esbuild'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
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

chmodSync(outFile, 0o755)
const size = readFileSync(outFile).length
console.log(`[scanner-cli] 已生成 ${outFile} (${(size / 1024).toFixed(1)} KB)`)
