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

console.log(
  bad === 0 ? '\n全部通过：界面 ↔ 适配层 ↔ 后端 三方接口一致。' : `\n${bad} 项不一致 —— 界面会静默失效。`
)
process.exit(bad ? 1 : 0)
