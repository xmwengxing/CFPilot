/**
 * HTML 标签配对自检：抓**多写/漏写闭合标签**这类格式错误。
 *
 * ## 为什么需要
 *
 * 精简文案时经常顺手改句子，改到一半就会漏掉或多加一个闭合标签
 * （例如 `<b>…</b> …… </b>` —— 多出来那个会让后面整段都失去加粗）。
 * 这类错误**不会报错**，只会让页面局部样式走样，肉眼很难立刻发现。
 *
 * ## 查什么
 *
 * 1. 闭合标签没有对应的开标签（多写）
 * 2. 开标签没有对应的闭合标签（漏写）
 * 3. 结束标签与最近的开始标签不匹配（错位，例如 `<b><i></b></i>`）
 *
 * ## 不查什么
 *
 * - 空元素（`br` / `img` / `input` / `meta` …）不需要闭合；
 * - `<script>` / `<style>` / `<pre>` 内部的内容不按标签解析；
 * - 属性值里的尖括号不参与配对（先按引号切掉）。
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/check-html-tags.mjs <html...>')
  process.exit(2)
}

/** 不需要闭合标签的元素 */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 内容不按标签解析的元素 */
const RAW = new Set(['script', 'style', 'pre', 'textarea'])

let bad = 0
for (const file of files) {
  const html = readFileSync(file, 'utf8')
  // 去掉注释 —— 但**保留换行**，否则行号会整体偏移。
  const src = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const stack = []
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    // 跳过属性值里的尖括号
    let j = lt + 1
    let inQuote = ''
    while (j < src.length) {
      const ch = src[j]
      if (inQuote) {
        if (ch === inQuote) inQuote = ''
      } else if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    const inner = src.slice(lt + 1, j).trim()
    const line = src.slice(0, lt).split('\n').length
    i = j + 1
    if (!inner || inner.startsWith('!') || inner.startsWith('?')) continue

    const isEnd = inner.startsWith('/')
    const name = (isEnd ? inner.slice(1) : inner).split(/[\s/]/)[0].toLowerCase()
    if (!name) continue

    if (isEnd) {
      if (VOID.has(name)) continue
      const top = stack.pop()
      if (!top) {
        console.log(`${file}:${line}: 多余的结束标签 </${name}>`)
        bad++
      } else if (top !== name) {
        console.log(`${file}:${line}: 标签错位 —— 期望 </${top}>，实际 </${name}>`)
        bad++
      }
    } else if (!VOID.has(name) && !inner.endsWith('/')) {
      // raw 元素的内容整体跳过（连它的结束标签一起跳，
      // 否则 `</textarea>` 会被当成普通结束标签配对 → 误报）
      if (RAW.has(name)) {
        const close = src.toLowerCase().indexOf('</' + name, i)
        if (close < 0) {
          i = src.length
          continue
        }
        const gt = src.indexOf('>', close)
        i = gt < 0 ? src.length : gt + 1
        continue
      }
      stack.push(name)
    }
  }
  for (const left of stack) {
    console.log(`${file}: 缺少结束标签 </${left}>`)
    bad++
  }
}

console.log(bad === 0 ? '\n✓ 标签配对自检通过' : `\n共 ${bad} 处`)
process.exit(bad ? 1 : 0)
