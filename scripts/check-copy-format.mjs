/**
 * 文案格式自检：只扫**可见正文**里的格式笔误。
 *
 * ## 扫什么
 *
 *   1. 中文标点前有多余空格（「HTTPS 。」）
 *   2. 正文里的连续空格
 *   3. 中文之间夹空格（「第三方优选器 导出的」）
 *   4. 半角标点紧跟中文（「输出 socks5://…，」这类除外）
 *
 * ## 不扫什么（及原因）
 *
 * - **跨行的空格**：HTML 源码为了可读会把中文折行，浏览器把折行折叠成一个空格。
 *   那是**全文件通用的排版风格**，不是笔误 —— 按跨行规则扫会把每一处折行都报出来，
 *   噪声压过信号。所以只查**同一行内**的多余空格。
 * - **注释 / 脚本 / 样式**：不是用户看到的文案。
 * - **`<code>` / `<pre>` 里的内容**：那是语法示例（端口、URL、表达式），
 *   半角标点是正确写法。
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/check-copy-format.mjs <html...>')
  process.exit(2)
}

const ZH = '\\u4e00-\\u9fff'
const RULES = [
  { name: '中文标点前有多余空格', re: new RegExp(`[${ZH}][ \\t]+[。，、；：！？）】》」』]`) },
  { name: '英文/数字与中文标点之间有多余空格', re: /[A-Za-z0-9][ \t]+[。，、；：！？）】》」』]/ },
  { name: '中文标点后有多余空格', re: /[。，、；：！？][ \t]+/ },
  { name: '正文里有连续空格', re: /[^\s<>"] {2,}[^\s<>"]/ },
  { name: '中文之间夹空格', re: new RegExp(`[${ZH}] [${ZH}]`) },
  { name: '半角标点紧跟中文', re: new RegExp(`[${ZH}][,;!?]`) },
]

/**
 * 把文件切成「可见正文」与「非正文」两类：
 * 非正文的位置用等长空白占位，保证行号与列号仍然对得上。
 */
function maskNonText(html) {
  // 用哨兵字符占位（不是空格）：`<code>路径</code>，` 这种结构，
  // 用空格占位会被误判成「中文标点前有多余空格」。
  const keep = (s) => s.replace(/[^\n]/g, '\u0000')
  return html
    .replace(/<!--[\s\S]*?-->/g, keep)
    .replace(/<script[\s\S]*?<\/script>/gi, keep)
    .replace(/<style[\s\S]*?<\/style>/gi, keep)
    .replace(/<code[\s\S]*?<\/code>/gi, keep)
    .replace(/<pre[\s\S]*?<\/pre>/gi, keep)
}

let bad = 0
for (const file of files) {
  const html = readFileSync(file, 'utf8')
  const masked = maskNonText(html)
  masked.split('\n').forEach((line, i) => {
    // 去掉标签，只留正文。
    // ⚠️ 标签用**哨兵字符**占位（不能用空格）：标签后面紧跟中文标点时，
    // 用空格占位会被误判成「标点前有多余空格」。
    const text = line.replace(/<[^>]*>/g, (m) => '\u0000'.repeat(m.length))
    if (!text.trim()) return
    for (const rule of RULES) {
      const m = rule.re.exec(text)
      if (!m) continue
      const at = m.index
      const ctx = line
        .slice(Math.max(0, at - 26), at + m[0].length + 26)
        .replace(/\s+/g, ' ')
        .trim()
      console.log(`${file}:${i + 1}  [${rule.name}]  …${ctx}…`)
      bad++
      break
    }
  })
}

console.log(bad === 0 ? '\n✓ 正文格式自检通过' : `\n共 ${bad} 处`)
process.exit(bad ? 1 : 0)
