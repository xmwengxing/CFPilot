// 校验日志栏折叠/展开的 CSS 与 JS 修复是否真的进了产物。
// 背景：折叠后调整窗口大小，日志标题栏曾被顶出窗口下沿导致无法点击（只能重启）。
//
// 注意：renderer.js 是 minify 过的，变量名会被重命名（savedLogHeight -> e），
// 所以 JS 侧只能校验「行为特征」而不是符号名。
import { readFileSync } from 'node:fs'

const html = readFileSync('packages/gui/dist/renderer/index.html', 'utf8')
const js = readFileSync('packages/gui/dist/renderer/renderer.js', 'utf8')

const checks = [
  // ---- CSS 侧 ----
  ['.collapsed 重置高度为 auto', /\.log-panel\.collapsed\s*\{[^}]*height:\s*auto\s*!important/],
  ['log-panel 允许 flex 收缩', /\.log-panel\s*\{[^}]*flex-shrink:\s*1/],
  ['log-panel min-height 兜底', /\.log-panel\s*\{[^}]*min-height:\s*30px/],
  ['log-panel max-height 限制', /\.log-panel\s*\{[^}]*max-height:\s*60%/],
  ['log-head 吸附顶部', /\.log-head\s*\{[^}]*position:\s*sticky/],
  ['折叠时标题条顶对齐', /collapsed\s+\.log-head\s*\{[^}]*align-self:\s*flex-start/],

  // ---- JS 侧（按行为特征）----
  // 折叠前把 style.height 摘走存起来，展开时还回去
  ['折叠前暂存并还原拖拽高度', /style\.height=""\)[^;]{0,40}style\.height=/],
  // 监听 window resize 做越界兜底
  ['监听 window resize 校正越界', /addEventListener\("resize"/],
  // 用 getBoundingClientRect 量真实几何 + 拿 innerHeight 比较
  ['按真实几何判断是否越界', /getBoundingClientRect\(\)[^;]{0,120}innerHeight|innerHeight[^;]{0,120}getBoundingClientRect\(\)/],
]

let bad = 0
for (const [name, re] of checks) {
  const hit = re.test(html) || re.test(js)
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${name}`)
  if (!hit) bad++
}
console.log(bad === 0 ? '\n全部通过：日志栏折叠后不会再被窗口边缘遮挡。' : `\n${bad} 项未通过`)
process.exit(bad ? 1 : 0)
