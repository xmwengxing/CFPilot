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

// 1) 提取**每一段**内联 script / style，交给 esbuild 压缩
//
// ⚠️ 必须按「段」分别处理，不能只留最后一段。
//
// 早期实现用 `/<script>([\s\S]*?)<\/script>/g` 把所有 script 都替换成**同一个**
// 占位符 `@@CFPILOT_JS@@`，而 `String.replace(字符串, ...)` **只替换第一个**：
//   1. `inlineJs` 被最后一段覆盖 → 前一段的代码**整段丢失**；
//   2. 第二个占位符原样留在 HTML 里 → 浏览器里是一个 SyntaxError 的死 `<script>`。
//
// 真实事故（2026-10-28 用户报「面板右上色盘点了不切亮色主题」）：
// panel.html 里有两段 script（主题切换 + 主应用），主题那段被整段吃掉 ——
// 桌面版（packages/ui）没有这个提取步骤，所以只有 Pages 面板坏。
const jsBlocks = []
const cssBlocks = []
let html = source
  .replace(/<script>([\s\S]*?)<\/script>/g, (_match, code) => {
    jsBlocks.push(code)
    return `<script>@@CFPILOT_JS_${jsBlocks.length - 1}@@</script>`
  })
  .replace(/<style>([\s\S]*?)<\/style>/g, (_match, code) => {
    cssBlocks.push(code)
    return `<style>@@CFPILOT_CSS_${cssBlocks.length - 1}@@</style>`
  })

/** 逐段压缩（空段保持为空，避免产出一个空 `<script></script>` 里的多余空白） */
async function minifyAll(blocks, loader) {
  const out = []
  for (const code of blocks) {
    out.push(
      code.trim()
        ? (await transform(code, { loader, minify: true, target: loader === 'js' ? 'es2020' : undefined })).code
        : ''
    )
  }
  return out
}

const minifiedScripts = await minifyAll(jsBlocks, 'js')
const minifiedStyles = await minifyAll(cssBlocks, 'css')

// 2) 去掉注释与多余空白，再把压缩后的片段放回原位
//
// ⚠️ 必须先把换行统一成 LF：
//   git 的 autocrlf 会在不同环境下把同一份源文件检出成 CRLF 或 LF，
//   而字节不同 → gzip 输出不同 → 面板产物不同 → CI 的
//   「构建产物与仓库一致」校验必然失败。
//   统一成 LF 后，产物与检出方式、平台、zlib 版本都无关。
//
// ⚠️ 替换必须用**函数形式**：字符串形式会把 `$&` / `$1` 当成替换模式，
//    而压缩后的 JS 里完全可能出现 `$`。
html = html
  .replace(/\r\n/g, '\n')
  .replace(/@@CFPILOT_JS_(\d+)@@/g, (_m, i) => minifiedScripts[Number(i)] ?? '')
  .replace(/@@CFPILOT_CSS_(\d+)@@/g, (_m, i) => minifiedStyles[Number(i)] ?? '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\n\s*/g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim()

// 自检：占位符必须全部替换干净（漏一个就是死 <script> / 丢样式）
const leftover = /@@CFPILOT_[A-Z]+(?:_\d+)?@@/.exec(html)
if (leftover) {
  throw new Error(`[gen-panel] 占位符未被替换：${leftover[0]}（script ${jsBlocks.length} 段 / style ${cssBlocks.length} 段）`)
}
if (jsBlocks.length === 0) {
  throw new Error('[gen-panel] panel.html 里没有找到任何内联 <script>，面板将完全不可用')
}

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
