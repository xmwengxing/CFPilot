// 面板产物契约检查：解码内嵌面板，校验「多段 script/style 都被正确注入」。
//
// ## 为什么需要这个脚本（2026-10-28 真实事故）
//
// `packages/worker-core/scripts/gen-panel.mjs` 早期用
// `/<script>([\s\S]*?)<\/script>/g` 把所有 script 段统一替换成**同一个**占位符，
// 而 `String.replace(字符串, ...)` 只替换第一个：
//   - `inlineJs` 被最后一段覆盖 → **前一段代码整段丢失**；
//   - 第二个占位符原样留在 HTML 里 → 浏览器里是一个 SyntaxError 的死 `<script>`。
//
// panel.html 里有两段 script（主题切换 + 主应用），于是主题切换整段消失 ——
// 表现为「面板右上角色盘点了不切亮色主题」，而桌面版（packages/ui 不做这个提取）正常。
// 这个差异只在真机浏览器里暴露，构建和单测都不会报错。
//
// 因此这里把「产物必须包含哪些东西」变成硬断言。
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generated = readFileSync(resolve(root, 'packages/worker-core/src/ui/panel.generated.ts'), 'utf8')

const match = /'([A-Za-z0-9+/=]+)'/.exec(generated)
if (!match) {
  console.error('[check-panel-bundle] 无法从 panel.generated.ts 里取出 Base64 载荷')
  process.exit(1)
}

let html = ''
try {
  html = gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8')
} catch (e) {
  console.error(`[check-panel-bundle] 面板载荷解压失败：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

const problems = []
const scriptCount = [...html.matchAll(/<script[^>]*>/g)].length

// 1) 占位符必须全部替换干净（漏一个 = 死 script / 丢样式）
if (/@@CFPILOT_[A-Z]+(?:_\d+)?@@/.test(html)) {
  problems.push('仍有 @@CFPILOT_*@@ 占位符残留（gen-panel 的替换没覆盖全部段落）')
}

// 2) 面板至少要有两段 script（主题切换 + 主应用）；少一段说明有段落被吃掉
if (scriptCount < 2) {
  problems.push(`只找到 ${scriptCount} 段 <script>，主题切换或主应用有一段落丢失`)
}

// 3) 主题切换脚本必须存活（关键字取样：localStorage 键 + 按钮 id）
if (!html.includes('cfpilot.theme')) {
  problems.push('主题切换脚本丢失（找不到 localStorage 键 cfpilot.theme）')
}
if (!html.includes('btnTheme')) {
  problems.push('主题切换按钮丢失（找不到 #btnTheme）')
}
if (!html.includes('theme-light')) {
  problems.push('亮色主题样式块丢失（找不到 #theme-light）')
}

// 4) 运行概览页的自适应订阅地址输入框
if (!html.includes('subAdaptive')) {
  problems.push('运行概览页缺少自适应订阅地址输入框（#subAdaptive）')
}

// 5) 主应用脚本必须还在（否则整个面板是死的）
if (!html.includes('navigator.clipboard') && !html.includes('data-copy')) {
  problems.push('主应用脚本疑似丢失（找不到复制相关逻辑）')
}

if (problems.length > 0) {
  console.error('[check-panel-bundle] 失败：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`[check-panel-bundle] 通过：${scriptCount} 段 script 全部注入，主题切换与自适应订阅卡片均在（${(html.length / 1024).toFixed(1)} KB）`)
