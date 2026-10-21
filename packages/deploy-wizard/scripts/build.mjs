// 构建 cfpilot-deploy CLI
import { build } from 'esbuild'
import { chmodSync, mkdirSync } from 'node:fs'
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

chmodSync(outFile, 0o755)
console.log(`[deploy-wizard] 已生成 ${outFile}`)
