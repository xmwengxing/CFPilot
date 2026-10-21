// 生成内嵌中文面板的 TypeScript 模块。
//
// Worker 运行时无法读取外部文件，因此面板 HTML 必须编译进内核。
// 为了守住 worker-core 的 80KB 体积预算，这里做三步处理：
//   1. 用 esbuild 压缩内联的 <script> 与 <style>
//   2. 去掉 HTML 注释与多余空白
//   3. gzip 后以 Base64 嵌入（运行时用 DecompressionStream 解压，只做一次）
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const htmlPath = resolve(pkgRoot, 'src/ui/panel.html')
const generatedPath = resolve(pkgRoot, 'src/ui/panel.generated.ts')

const source = readFileSync(htmlPath, 'utf8')

// 1) 提取内联的 script / style，交给 esbuild 压缩
let inlineJs = ''
let inlineCss = ''
let html = source
  .replace(/<script>([\s\S]*?)<\/script>/g, (_match, code) => {
    inlineJs = code
    return '<script>@@CFPILOT_JS@@</script>'
  })
  .replace(/<style>([\s\S]*?)<\/style>/g, (_match, code) => {
    inlineCss = code
    return '<style>@@CFPILOT_CSS@@</style>'
  })

const minifiedJs = inlineJs
  ? (await transform(inlineJs, { loader: 'js', minify: true, target: 'es2020' })).code
  : ''
const minifiedCss = inlineCss
  ? (await transform(inlineCss, { loader: 'css', minify: true })).code
  : ''

// 2) 去掉注释与多余空白，再把压缩后的片段放回原位
html = html
  .replace('@@CFPILOT_JS@@', () => minifiedJs)
  .replace('@@CFPILOT_CSS@@', () => minifiedCss)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\n\s*/g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim()

// 3) gzip + Base64
//
// 注意：zlib 写入的 gzip 头里第 10 个字节是「操作系统标识」
// （Windows 为 0x0a，Linux/macOS 为 0x03）。这个字节与内容无关，
// 却会让同一份源码在不同平台上构建出字节不同的产物，
// 导致 CI 里「构建产物与仓库一致」的校验误报。
// 这里统一改写为 0xff（unknown），让产物跨平台完全一致。
const compressed = gzipSync(Buffer.from(html, 'utf8'), { level: 9 })
compressed[9] = 0xff
const base64 = compressed.toString('base64')

const banner = `// 由 packages/worker-core/scripts/gen-panel.mjs 自动生成，请勿手工编辑。\n`
writeFileSync(
  generatedPath,
  `${banner}export const PANEL_HTML_GZIP_B64: string = '${base64}'\n`,
  'utf8'
)

console.log(
  `[worker-core] 已生成 ${generatedPath} (原始 ${Buffer.byteLength(source)}B → 压缩 ${compressed.length}B)`
)
