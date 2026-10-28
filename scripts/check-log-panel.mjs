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

// ---- 拖拽手柄的定位上下文（2026-10-28 真实故障） ----
//
// `.log-resizer` 是 `position: absolute; top: -3px`，
// 它的**定位参照物**必须是 `.log-panel`（`position: relative`）。
//
// 真实故障：`.log-panel` 那条规则因为**前面少了一个 `/*`**，
// 被 CSS 解析器的错误恢复逻辑整条吞掉 ——
// 解析器遇到非法 token 会一路跳过，直到遇见 `;` 或 `}`，
// 而那条规则的结尾 `}` 正好成了吞掉它的终点。
//
// 结果：`.log-panel` 变成 `position: static`，
// 手柄的定位参照物退化成视口 → 手柄跑到 y = -3（视口上方，**点不到**），
// 用户表现为「日志窗口不能拖了，固定大小」。
//
// 所以这条断言不能少。

const panelRule = html.match(/\.log-panel\s*\{([^}]*)\}/)
if (!panelRule) {
  console.log('FAIL  找不到 .log-panel 规则（可能被 CSS 解析错误吞掉了）')
  bad++
} else if (!/position:\s*relative/.test(panelRule[1])) {
  console.log('FAIL  .log-panel 缺少 position: relative（拖拽手柄会定位到视口，拖不动）')
  bad++
} else {
  console.log('PASS  .log-panel 有 position: relative（拖拽手柄定位正确）')
}

// ---- CSS 注释必须配平（防止再出现「少一个 /*」吞规则」） ----
//
// CSS 注释不嵌套，所以 `/*` 与 `*/` 必须严格交替。
// 一旦多出一个 `*/`（比如注释开头被误删），
// 后面直到下一个 `*/` 的内容都会被当成非法 CSS 吞掉 ——
// 症状是「某条规则莫名其妙不生效」，极难排查。
//
// 这里对 <style> 块做一次严格的配平扫描。

{
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  if (!styleMatch) {
    console.log('FAIL  找不到 <style> 块')
    bad++
  } else {
    const css = styleMatch[1]
    let depth = 0
    let i = 0
    let unbalanced = null
    while (i < css.length) {
      if (css.startsWith('/*', i)) {
        depth++
        i += 2
        continue
      }
      if (css.startsWith('*/', i)) {
        depth--
        if (depth < 0 && !unbalanced) {
          unbalanced = { at: i, ctx: css.slice(Math.max(0, i - 120), i + 40) }
        }
        i += 2
        continue
      }
      i++
    }
    if (unbalanced) {
      console.log('FAIL  CSS 注释不配平：出现了没有对应 /* 的 */')
      console.log(`      位置附近：…${unbalanced.ctx.replace(/\s+/g, ' ')}…`)
      bad++
    } else if (depth !== 0) {
      console.log(`FAIL  CSS 注释未闭合（缺少 ${depth} 个 */）`)
      bad++
    } else {
      console.log('PASS  CSS 注释配平（不会有规则被解析错误吞掉）')
    }
  }
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
