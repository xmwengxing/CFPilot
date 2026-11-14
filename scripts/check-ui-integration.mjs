// 检查 index.html + renderer.js 里是否存在「会静默失效」的隐患。
//
// ## 背景（2026-10-26 复盘）
//
// Go 版界面完全复用了 Electron 版的 renderer.ts，靠 adapter.js 提供
// `window.cfpilot`。这里所有「调用不存在的 API」或「字段名不匹配」
// 都会在运行时静默失败（被 try/catch 吞掉），用户只看到功能没反应。
//
// 本脚本做静态交叉校验：
//   1. renderer.js 里调用的每个 window.cfpilot.xxx 都必须在 adapter 里存在
//   2. adapter 里每处 `post('/api/...')` / `get('/api/...')` 都必须是后端真实路由
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const rendererPath = 'packages/ui/dist/renderer.js'
const adapterPath = 'packages/desktop/webui/adapter.js'
const serverDir = 'packages/desktop/internal/server'

for (const p of [rendererPath, adapterPath]) {
  if (!existsSync(p)) {
    console.error(`缺少文件：${p}（先跑 npm run build -w @cfpilot/ui）`)
    process.exit(1)
  }
}

const renderer = readFileSync(rendererPath, 'utf8')
const adapter = readFileSync(adapterPath, 'utf8')

let bad = 0

/* ---------------- 1. renderer 调用的方法必须在 adapter 里存在 ---------------- */

console.log('=== window.cfpilot 方法完整性 ===\n')

// 从 renderer 抓所有 window.cfpilot.xxx(
const used = new Set()
for (const m of renderer.matchAll(/window\.cfpilot\.([A-Za-z_$][\w$]*)\(/g)) {
  used.add(m[1])
}

// 从 adapter 抓所有方法名（形如 `name: function` 或 `name: (`）
const defined = new Set()
for (const m of adapter.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/gm)) {
  defined.add(m[1])
}

const missing = [...used].filter((n) => !defined.has(n)).sort()
if (missing.length > 0) {
  console.log(`FAIL  renderer 调用了 adapter 里不存在的 ${missing.length} 个方法：`)
  for (const n of missing) console.log(`        ${n}`)
  bad += missing.length
} else {
  console.log(`PASS  renderer 用到的 ${used.size} 个方法全部在 adapter 中实现`)
}

// 顺带列出 adapter 实现了但 renderer 没用的（不是错误，仅提示）
const unused = [...defined].filter((n) => !used.has(n)).sort()
if (unused.length > 0) {
  console.log(`\n提示：adapter 有 ${unused.length} 个方法界面暂未调用：${unused.join(', ')}`)
}

/* ---------------- 2. adapter 请求的路由必须存在 ---------------- */

console.log('\n=== API 路由完整性 ===\n')

// 收集后端注册的所有路由
//
// ⚠️ 不要写死 .go 文件清单：后端每加一个模块就会新开一个文件
//    （日志页的 log_routes.go 就是例子）。写死的清单会漏掉新文件 ——
//    于是「界面调了不存在的路由」变成**永久误报**，
//    报错久了大家就不再相信这个脚本的输出，真出问题时也看不见了。
// 这里直接扫 server 目录下的全部 .go 文件。
const routes = new Set()
for (const f of readdirSync(serverDir)) {
  if (!f.endsWith('.go')) continue
  const src = readFileSync(join(serverDir, f), 'utf8')
  for (const m of src.matchAll(/HandleFunc\("([^"]+)"/g)) {
    routes.add(m[1])
  }
}

// 收集 adapter 请求的路由（去掉查询串）
const requested = new Set()
for (const m of adapter.matchAll(/\b(?:post|get)\('(\/api\/[^']+)'/g)) {
  requested.add(m[1].split('?')[0])
}
// 动态拼的路径（如 /api/profile/update）已在上面覆盖

const notFound = [...requested].filter((r) => !routes.has(r)).sort()
if (notFound.length > 0) {
  console.log(`FAIL  adapter 请求了后端不存在的 ${notFound.length} 个路由：`)
  for (const r of notFound) console.log(`        ${r}`)
  bad += notFound.length
} else {
  console.log(`PASS  adapter 请求的 ${requested.size} 个路由全部存在`)
  for (const r of [...requested].sort()) console.log(`        ${r}`)
}

/* ---------------- 3. 关键字段名交叉校验 ---------------- */

console.log('\n=== 关键字段名一致性 ===\n')

// 界面读这些字段，adapter 必须产出
const fieldChecks = [
  ['profile.active', /\.active\b/, 'active'],
  ['update.ok', /\.ok\b/, 'ok'],
  ['update.error', /\.error\b/, 'error'],
  ['env.clean', /\.clean\b/, 'clean'],
]

for (const [label, re, field] of fieldChecks) {
  const usedInRenderer = re.test(renderer)
  const producedInAdapter = new RegExp(`\\b${field}\\s*:`).test(adapter)
  const ok = !usedInRenderer || producedInAdapter
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}（界面用=${usedInRenderer}, adapter 产出=${producedInAdapter}）`)
  if (!ok) bad++
}

/* ---------------- 4. 部署状态卡的版本文案 ---------------- */

console.log('\n=== 版本信息文案（三个来源不能混叫） ===\n')

// ⚠️ 必须读**源码**而不是 dist 产物：esbuild 会把中文转成 `\uXXXX`，
// 在产物里搜「已部署」永远搜不到（实测踩过，检查会假通过/假失败）。
const rendererSrc = readFileSync('packages/ui/src/renderer.ts', 'utf8')

// 三个版本来自三个地方，必须各有唯一名字：
//   已部署     ← Cloudflare 上正在跑的
//   最新发布   ← GitHub 上发布的最新内核
//   本程序内置 ← 当前桌面版自带的产物
//
// 早期三者挤在一行、两个都叫「线上」，用户分不清该不该更新（2026-10-31 报障）。
const versionLabels = ['已部署', '最新发布', '本程序内置']
for (const label of versionLabels) {
  const ok = rendererSrc.includes(label)
  console.log(`${ok ? 'PASS' : 'FAIL'}  renderer 含「${label}」`)
  if (!ok) bad++
}

// 「线上内核」是有歧义的历史叫法，不能再出现在状态卡里
const ambiguous = rendererSrc.includes('线上内核')
console.log(`${ambiguous ? 'FAIL' : 'PASS'}  状态卡不再使用有歧义的「线上内核」`)
if (ambiguous) bad++

/* ---------------- 5. 新建账户后「当前使用」必须切到新账户 ---------------- */
//
// 2026-11-05 真机：选「＋ 新建账户」→ 填 Token → 点「添加并保存」，
// 账户其实已建好并激活（store.Create 会写 ActiveID），但 refreshProfiles
// 无条件「previous === __new__ 就保持 __new__」，下拉仍停在「＋ 新建账户」，
// 用户以为没保存成功，还会再点一次多建一个空账户。
console.log('\n=== 新建账户后的「当前使用」归属 ===\n')

const profileChecks = [
  ['refreshProfiles 支持显式选中', /async function refreshProfiles\(selectId\?: string\)/, '新建后要能指定选中项'],
  ['新建成功分支传入 created.id', /refreshProfiles\(created\.id\)/, '保存成功后切到新账户'],
  ['显式选中优先于保持 __new__', /if \(selectId && profiles\.some/, '否则仍会被 __new__ 覆盖'],
]
for (const [label, re, desc] of profileChecks) {
  const ok = re.test(rendererSrc)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  —— ${desc}`)
  if (!ok) bad++
}

/* ---------------- 6. 部署按钮状态机 & 面板凭据两种入口 ---------------- */
//
// 2026-11-14 真机：点过「检查部署状态」后，按钮文案被固定下来；
// 再切换「自动判断 / 更新现有部署 / 全新部署」时按钮不跟着变，
// 且未检查状态下也能直接点部署。
console.log('\n=== 部署按钮状态机 & 面板凭据 ===\n')

const uiHtml = readFileSync('packages/ui/src/index.html', 'utf8')
const deployButtonChecks = [
  ['三种模式切换有监听', /querySelectorAll\('input\[name="mode"\]'\)/, '切换后必须重算按钮'],
  ['统一状态机存在', /function syncDeployButton\(\): void/, '按钮文案 / 可用性 / 提示集中计算'],
  ['未检查状态置灰', /btn\.disabled = .*!deployChecked/, '自动判断未检查时不允许部署'],
  ['忙碌态结束重新同步', /if \(!busy\) syncDeployButton\(\)/, '避免 setBusy(false) 无条件放开按钮'],
  ['自动判断引导提示', /请先点击「检查部署状态」按钮判断部署操作选择/, '切回自动判断时给出指引'],
  ['更新模式按钮名', /btn\.textContent = '更新现有部署'/, '按钮名与实际动作一致'],
  ['全新模式按钮名', /btn\.textContent = '全新部署'/, '按钮名与实际动作一致'],
]
for (const [label, re, desc] of deployButtonChecks) {
  const ok = re.test(rendererSrc)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  —— ${desc}`)
  if (!ok) bad++
}

const credChecks = [
  ['弹窗有自定义域名行', uiHtml.includes('id="credPanelCustomUrl"'), '两种面板地址都要展示'],
  ['凭据接口读自定义域名', rendererSrc.includes('panelCustomUrl'), '界面要消费后端返回的自定义域名链接'],
]
for (const [label, ok, desc] of credChecks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  —— ${desc}`)
  if (!ok) bad++
}

// 说明页：检查更新卡片置顶 + 发布说明渲染
const aboutSection = uiHtml.match(/<section class="page" id="page-about">([\s\S]*?)<\/section>/)
const updateCardChecks = [
  ['检查更新卡片在说明页最上方', Boolean(aboutSection) && aboutSection[1].trimStart().startsWith('<div class="card">') && aboutSection[1].includes('⬆️ 检查更新'), '用户进说明页第一眼看到更新'],
  ['发布说明容器存在', uiHtml.includes('id="updateNotes"'), '检查更新后展示更新内容'],
  ['renderer 消费 notes 渲染发布说明', /renderUpdateNotes\(/.test(rendererSrc), '不能只拿版本号不拿说明'],
]
for (const [label, ok, desc] of updateCardChecks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  —— ${desc}`)
  if (!ok) bad++
}

// 反代优选校验网址 + 质量报告/部署页修复（2026-11-14）
const relayVerifyChecks = [
  ['反代优选有校验网址填写框', uiHtml.includes('id="optRelayVerifyHosts"'), '终检候选能否转发 CF 网段站点'],
  ['renderer 传 verifyHosts', /verifyHosts: \(/.test(rendererSrc), '填写框要传给后端'],
  ['adapter 透传 verifyHosts', /verifyHosts: Array\.isArray\(p\.verifyHosts\)/.test(adapter), '界面参数要进 API'],
  ['部署实例未选账户有警告', /rt-warn/.test(rendererSrc) && rendererSrc.includes('未选择账户'), '部署前就要看见失败原因'],
  ['部署异步受理后保持置灰', /markDeployInFlight/.test(rendererSrc) && /markDeploySettled/.test(rendererSrc), '防止部署中途重复点击'],
  ['纯净度评分按分值着色', /function purityScoreColor/.test(rendererSrc), '0~10 绿 / 中黄 / 高分红'],
  ['场景适配不再挤成一行重复渲染', !rendererSrc.includes("'purity.scenarios'"), '报告底部已有独立单列展示'],
  // 反代优选结果与排序（2026-11-14）
  ['反代结果只显示保留条数内的入选项', /只列出入选的/.test(rendererSrc), '回填语义一目了然，不会误以为全部都会被回填'],
  ['反代结果显示各校验网址延迟', /verifyDetails/.test(rendererSrc) && /校验延迟/.test(rendererSrc), '每个候选对每个校验网址的耗时可见'],
  ['入口优选结果默认按下行速度排序', /scanComparators/.test(rendererSrc) && /speed: \(a, b\) => b\.speed - a\.speed/.test(rendererSrc), '最快的排最前'],
  ['入口优选结果表头可点击排序', /thEl\.onclick = \(\) => \{/.test(rendererSrc), '再点一次翻转方向'],
  ['优选历史表头可点击排序', /historySort =/.test(rendererSrc) && /historyComparators/.test(rendererSrc), '历史条目可按列排序'],
]
for (const [label, ok, desc] of relayVerifyChecks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  —— ${desc}`)
  if (!ok) bad++
}

console.log(
  bad === 0 ? '\n全部通过：界面 ↔ 适配层 ↔ 后端 三方接口一致。' : `\n${bad} 项不一致 —— 界面会静默失效。`
)
process.exit(bad ? 1 : 0)
