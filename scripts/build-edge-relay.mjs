#!/usr/bin/env node
/**
 * 把权威 edge 工程（packages/edge-relay/）编译成 CLI/桌面版内置资产。
 *
 * 产出（packages/cli/assets/edge-relay/）：
 *   - worker.js      : index.ts + proto.ts 经 esbuild 打包成单文件 ESM（import "./proto.ts" 被内联）
 *   - dashboard.html : 面板原样拷贝（部署时替换 DEFAULT_API 为实际 WorkerUrl）
 *   - schema.sql     : 两份 migrations 合并（供需要 SQL 文本的场景；运行时用 src 常量）
 *
 * 为什么构建期预编译：运行时零编译、零依赖（CLI 零运行时依赖铁律），
 * esbuild 只是 devDependency。
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const relaySrc = join(repoRoot, 'packages', 'edge-relay', 'cf-worker-relay')
const outDir = join(repoRoot, 'packages', 'cli', 'assets', 'edge-relay')

const entry = join(relaySrc, 'src', 'index.ts')
const dashSrc = join(relaySrc, 'dashboard.html')
if (!existsSync(entry) || !existsSync(dashSrc)) {
  throw new Error('[edge-relay] 缺少权威源码，先确认 packages/edge-relay 已同步')
}

mkdirSync(outDir, { recursive: true })

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  legalComments: 'none',
  loader: { '.html': 'text' },
})
const code = result.outputFiles[0].text
if (!code.includes('export') || code.length < 2000) {
  throw new Error('[edge-relay] 编译产物异常（无 export 或过小）')
}
writeFileSync(join(outDir, 'worker.js'), code, 'utf8')
const dashboardHtml = readFileSync(dashSrc, 'utf8')
writeFileSync(join(outDir, 'dashboard.html'), dashboardHtml, 'utf8')

// Pages Direct Upload 的 manifest 机制（文件路径→内容 hash）较复杂且易错；
// 监测面板本质是单页 HTML，改为「返回一个 Worker」部署：把 HTML 包成 ES module
// Worker，复用已真机验证的 deployPagesWorker。API 200 且真实可用。
const dashboardWorker =
  `const HTML = ${JSON.stringify(dashboardHtml)};\n` +
  'export default {\n' +
  '  fetch() {\n' +
  '    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });\n' +
  '  }\n' +
  '}\n'
writeFileSync(join(outDir, 'dashboard-worker.js'), dashboardWorker, 'utf8')

const m1 = readFileSync(join(relaySrc, 'migrations', '0001_init.sql'), 'utf8')
const m2 = readFileSync(join(relaySrc, 'migrations', '0002_auth.sql'), 'utf8')
writeFileSync(join(outDir, 'schema.sql'), `${m1}\n${m2}\n`, 'utf8')

console.log(
  `[edge-relay] 已生成资产：worker.js ${(code.length / 1024).toFixed(1)}KB / ` +
  `dashboard.html ${(readFileSync(dashSrc).length / 1024).toFixed(1)}KB / schema.sql`
)
