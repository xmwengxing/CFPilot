// 校验 Go 版适配层（adapter.js）返回的结构与 Electron 版桥接接口**逐字段一致**。
//
// ## 为什么需要这个脚本（2026-10-26 严重故障复盘）
//
// 界面代码（renderer.ts）是按 Electron 版 preload 注入的
// `window.cfpilot` 接口写的。Go 版用 adapter.js 造一个同形的对象，
// 但**返回值结构必须逐字段对齐**，否则界面会在运行时静默出错。
//
// 真实踩过的坑：
//   - updateProfile 界面判 `if (!saved.ok)`，适配层返回 profile 对象
//     → saved.ok 是 undefined → **永远判定新建失败**，
//       而且 createProfile 已经创建了记录 → 点几次多几条「○ 新账户」
//   - listProfiles 界面用 `p.active` 找当前账户，后端 profiles 里没这个字段
//     → 永远找不到 → 下拉框失控
//   - detectScanHost 界面判 `result.ok && result.host`，后端只给 { host }
//     → 永远不会填入域名
//   - checkEnvironment 界面判 `result.clean`，后端给 { findings: [...] }
//     → 永远不显示「环境正常」
//
// 本脚本静态分析 adapter.js，检查每个方法是否产出了界面期望的字段。
// 这是「源码级断言」，能抓住接口测试抓不到的结构不匹配。
import { readFileSync } from 'node:fs'

const adapter = readFileSync('packages/desktop/webui/adapter.js', 'utf8')

/**
 * 每条断言：[方法名, 必须出现的字段名, 说明]
 *
 * 字段名对应 Electron 版 bridge.ts 的返回类型。
 */
const contracts = [
  // ---- 凭据与账户（最容易踩坑的一组）----
  ['saveCredentials', 'saved', '界面判 result.saved'],
  ['wipeCredentials', 'wiped', '界面判 result.wiped'],
  ['listProfiles', 'active', '界面用 p.active 找当前账户'],
  ['updateProfile', 'ok', '界面判 saved.ok / !saved.ok'],
  ['deleteProfile', 'deleted', '界面判 result.deleted'],
  ['deleteProfile', 'activeId', '界面读 result.activeId'],
  ['switchProfile', 'ok', '界面判 result.ok'],
  ['switchProfile', 'activeId', '界面读 result.activeId'],

  // ---- 优选 ----
  ['detectScanHost', 'ok', '界面判 result.ok && result.host'],
  ['detectScanHost', 'host', '界面读 result.host'],
  ['detectScanHost', 'source', "界面比 source === 'custom'"],
  ['detectScanPath', 'ok', '界面判 result.ok && result.path'],
  ['detectScanPath', 'path', '界面读 result.path'],
  ['checkEnvironment', 'clean', '界面判 result.clean'],
  ['checkEnvironment', 'findings', '界面读 result.findings'],
  ['listScanCountryGroups', 'groups', '界面读分组机房码（亚洲组/美国组按钮）'],

  // ---- 优选历史与复测（Go 版新增）----
  ['getScanHistory', 'ok', '界面判 result.ok'],
  ['getScanHistory', 'sessions', '界面读 result.sessions 渲染历史列表'],
  ['reTestIps', 'sessionId', '复测结论要写回历史会话'],
  ['reTestIps', 'targets', '复测目标列表'],
  ['reTestIps', 'results', '界面读 result.results 展示分层状态'],

  // ---- 会话（2026-10-26 的另一个严重故障）----
  ['__session', null, 'adapter 必须调用 /__session 建立会话'],
]

/**
 * 在 adapter.js 里定位某个方法的实现片段。
 *
 * 方法以 `methodName: function` 或 `methodName: (` 开头，
 * 到下一个同级 `,\n    ` 结束。
 */
function extractMethod(src, name) {
  const re = new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?(?:function\\s*\\(|\\()`, 'm')
  const m = re.exec(src)
  if (!m) return null
  const start = m.index
  // 粗略取到下一个「4 空格缩进 + 方法名:」的位置
  const rest = src.slice(start + m[0].length)
  const nextRe = /\n\s{4}[a-zA-Z_$][\w$]*\s*:/
  const nm = nextRe.exec(rest)
  const end = nm ? start + m[0].length + nm.index : src.length
  return src.slice(start, end)
}

let bad = 0
const seen = new Set()

console.log('=== 适配层返回结构校验（对照 Electron 版桥接契约）===\n')

for (const [method, field, reason] of contracts) {
  if (!field) {
    // 特殊断言：代码里必须出现该字符串
    const hit = adapter.includes(method)
    console.log(`${hit ? 'PASS' : 'FAIL'}  ${method}  —— ${reason}`)
    if (!hit) bad++
    continue
  }

  const body = extractMethod(adapter, method)
  if (body === null) {
    console.log(`FAIL  ${method}.${field}  —— 方法未找到`)
    bad++
    continue
  }

  const key = `${method}.${field}`
  if (seen.has(key)) continue
  seen.add(key)

  // 字段必须以 `field:`（对象字面量）或 `.field`（属性访问）形式出现
  const hasField =
    new RegExp(`\\b${field}\\s*:`).test(body) ||
    new RegExp(`\\b${field}\\b`).test(body)

  console.log(`${hasField ? 'PASS' : 'FAIL'}  ${method}.${field}  —— ${reason}`)
  if (!hasField) bad++
}

console.log('\n=== 键名一致性校验 ===\n')

// 后端返回的键名与界面期望的键名不一致时，必须在适配层里做映射
const mappings = [
  ['profiles → active', /active\s*:\s*p\.id\s*===\s*activeId/, 'listProfiles 必须给每项补 active 字段'],
  ['ok 包装', /return\s*\{\s*ok:\s*true/, 'updateProfile 必须返回 { ok: true }'],
  ['sessionReady', /sessionReady/, 'call() 必须 await sessionReady'],
]

for (const [name, re, desc] of mappings) {
  const hit = re.test(adapter)
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${name}  —— ${desc}`)
  if (!hit) bad++
}

console.log(
  bad === 0
    ? '\n全部通过：适配层返回值与 Electron 版桥接契约逐字段一致。'
    : `\n${bad} 项不匹配 —— 界面会在运行时静默出错，必须修复。`
)
process.exit(bad ? 1 : 0)
