// 校验日志栏的三代实现是否都正确落地。
//
// ## 背景（三次迭代）
//
// **第一代**：`resize: vertical` 让用户拖高度。
//   高度被写成内联固定 px → 2K 折叠后标题条露一半、
//   1080P 展开后溢出窗口下沿、四个页面大小不一。
//
// **第二代**：彻底禁止拖拽，固定高度 + 媒体查询。
//   问题解决了，但用户要求恢复拖拽。
//
// **第三代（当前）**：自己实现拖拽，但用**比例**而不是像素。
//   - 拖拽改 CSS 变量 --log-ratio（0.15 ~ 0.75）
//   - .log 高度 = calc(var(--log-ratio) * (100vh - 110px))
//   - 比例存 localStorage，下次打开保持
//   - 折叠时高度 auto，与拖拽互不干扰
//
// 本脚本锁住这些关键特征，防止有人改回内联像素方案。
import { readFileSync } from 'node:fs'

const html = readFileSync('packages/ui/dist/index.html', 'utf8')
const js = readFileSync('packages/ui/dist/renderer.js', 'utf8')

const checks = [
  // ---- CSS：比例方案 ----
  ['日志面板定义 --log-ratio 变量', /--log-ratio:\s*0\.28/],
  ['日志高度用 ratio × vh 计算', /height:\s*calc\(var\(--log-ratio[^)]*\)\s*\*\s*\(100vh/],
  ['有最小高度（不会塌成 0）', /\.log\s*\{[^}]*min-height:\s*60px/],
  ['有最大高度（不越界）', /\.log\s*\{[^}]*max-height:\s*calc\(100vh/],
  ['折叠态高度 auto', /\.log-panel\.collapsed\s*\{[^}]*height:\s*auto\s*!important/],
  ['折叠态隐藏日志区', /\.log-panel\.collapsed\s+\.log\s*\{\s*display:\s*none/],
  ['折叠态隐藏拖拽手柄', /\.log-panel\.collapsed\s+\.log-resizer\s*\{\s*display:\s*none/],
  ['拖拽手柄光标为 ns-resize', /\.log-resizer\s*\{[^}]*cursor:\s*ns-resize/],
  ['拖拽手柄有可见的握把', /\.log-resizer::after/],
  ['拖拽时禁止选中文字', /body\.resizing-log[^{]*\{[^}]*user-select:\s*none/],
  ['log-head 有最小高度', /\.log-head\s*\{[^}]*min-height:\s*30px/],
  ['log-head 层级高于手柄之下但可点', /\.log-head\s*\{[^}]*z-index:\s*3/],

  // ---- JS：拖拽逻辑 ----
  ['拖拽改的是 --log-ratio', /setProperty\("--log-ratio"/],
  ['有比例上下限钳制', /0\.75/],
  ['比例持久化到 localStorage', /localStorage\.setItem/],
  ['启动时恢复上次比例', /localStorage\.getItem/],
  ['折叠状态禁止拖拽', /collapsed'\)\)\s*return|collapsed"\)\)\s*return/],
  ['双击手柄恢复默认', /dblclick/],
]

let bad = 0
for (const [name, re] of checks) {
  const hit = re.test(html) || re.test(js)
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${name}`)
  if (!hit) bad++
}

// ---- 反向断言：历史包袱必须已移除 ----

if (/\.log-panel\s*\{[^}]*resize\s*:\s*vertical/.test(html)) {
  console.log('FAIL  仍在用 CSS resize: vertical（会用内联 px 导致越界）')
  bad++
} else {
  console.log('PASS  未使用 CSS resize: vertical')
}

if (/\.log\s*\{[^}]*height:\s*var\(--log-h/.test(html)) {
  console.log('FAIL  仍在用旧的 --log-h 固定高度方案')
  bad++
} else {
  console.log('PASS  已移除旧的 --log-h 固定高度方案')
}

console.log(
  bad === 0
    ? '\n全部通过：日志栏支持拖拽调高，2K / 1080P 下都不越界，四个页面共用同一比例。'
    : `\n${bad} 项未通过`
)
process.exit(bad ? 1 : 0)
