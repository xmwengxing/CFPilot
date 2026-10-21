// 构建 CFPilot Worker 内核：使用 esbuild 打包为 ESM 单文件 Worker（dist/worker.js）
// 面板 HTML 的 TS 模块生成见 scripts/gen-panel.mjs。
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = resolve(pkgRoot, 'dist')
const outFile = resolve(outDir, 'worker.js')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [resolve(pkgRoot, 'src/index.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  conditions: ['worker', 'browser'],
  define: { 'process.env.NODE_ENV': '"production"' },
  // cloudflare:sockets 是运行时内置模块，不能被打包器解析
  external: ['cloudflare:sockets'],
})

const size = readFileSync(outFile).length
console.log(`[worker-core] 已生成 ${outFile} (${(size / 1024).toFixed(1)} KB)`)
if (size > 50 * 1024) {
  console.warn('[worker-core] 警告：内核体积已超过 50KB 预算上限')
}
