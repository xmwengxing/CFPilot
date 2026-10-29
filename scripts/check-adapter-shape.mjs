// 精确校验 adapter.js 的返回值**外壳结构**与界面期望一致。
//
// ## 为什么需要这个脚本（2026-10-26 第二次踩同类坑）
//
// 上一版的 check-adapter-contract.mjs 只检查「字段是否存在」，
// 抓不到「外壳结构错了」这类问题：
//
//     // 界面期望对象外壳
//     const result = await window.cfpilot.listKvOptions(id)
//     kvOptions = result.options            ← 期望 { options: [...] }
//
//     // 适配层返回裸数组 → result.options 是 undefined
//     // → 后续 kvOptions.filter(...) 抛
//     //   "Cannot read properties of undefined (reading 'length')"
//
// 用户实测就卡在这一步（检测账号后报错，其他功能全做不下去）。
//
// ## 两类方法要区别对待
//
// **A. 透传型**（后端返回值形状已经正确）
//    适配层直接 `return post(...)` 或 `.then(r => r)`，不加工。
//    这类方法无法通过静态分析确认字段 —— 需要**运行时验证**。
//
// **B. 转换型**（后端形状与界面期望不同）
//    适配层必须重新组装对象。这类必须检查字段。
//
// 本脚本对 A 类只检查「没有多余的包装」，对 B 类检查字段完整性。
// 真正的运行时验证见 check-adapter-runtime.mjs。
import { readFileSync } from 'node:fs'

const adapter = readFileSync('packages/desktop/webui/adapter.js', 'utf8')

/**
 * 契约表
 *   kind: 'passthrough' 后端形状正确，直接透传
 *   kind: 'wrap'        适配层必须重新组装，检查以下字段
 *   kind: 'array'       必须返回裸数组
 */
const CONTRACTS = [
  // ---- 转换型：必须重新组装 ----
  {
    name: 'listKvOptions',
    kind: 'wrap',
    fields: ['options'],
    why: '界面 `kvOptions = result.options`，后端返回的也是 {options}，但必须保证字段存在',
  },
  {
    name: 'listProfiles',
    kind: 'array',
    why: '界面直接用 profiles.length / .filter / .find，且每项必须有 active 字段',
  },
  {
    name: 'listScanCountries',
    kind: 'array',
    why: '界面 `list = await api.listScanCountries()` 后直接 list.length',
  },
  {
    name: 'listScanCountryGroups',
    kind: 'passthrough',
    why: '界面读分组机房码（亚洲组/美国组按钮），后端给 {groups} 时只取 groups，异常时返回 {}',
  },
  {
    name: 'updateProfile',
    kind: 'wrap',
    fields: ['ok', 'error'],
    why: '后端返回 {ok, profile}，界面读 saved.ok / saved.error',
  },
  {
    name: 'saveCredentials',
    kind: 'wrap',
    fields: ['saved'],
    why: 'Electron 版返回 {saved}，后端返回 {ok, profile}',
  },
  {
    name: 'wipeCredentials',
    kind: 'wrap',
    fields: ['wiped'],
    why: 'Electron 版返回 {wiped}，后端返回 {ok, note}',
  },
  {
    name: 'detectScanHost',
    kind: 'wrap',
    fields: ['ok', 'host', 'source'],
    why: '后端只返回 {host, source}，界面判 result.ok',
  },
  {
    name: 'detectScanPath',
    kind: 'wrap',
    fields: ['ok', 'path', 'source'],
    why: '后端只返回 {path, source}，界面判 result.ok',
  },
  {
    name: 'checkEnvironment',
    kind: 'wrap',
    fields: ['clean', 'findings'],
    why: '后端返回 {findings:[{kind,message,level}]}，界面判 result.clean',
  },

  // ---- 透传型：后端形状已正确，直接返回 ----
  { name: 'credentialsState', kind: 'passthrough', why: '后端返回 {hasToken, accountId, kvNamespaceId}，与界面一致' },
  { name: 'detectAccount', kind: 'passthrough', why: '后端返回 {accountId, accountName, accounts}，界面只读前两个' },
  { name: 'checkUpdate', kind: 'passthrough', why: '后端返回 {current, latest, hasUpdate, downloadUrl, notes, error}' },
  { name: 'deleteProfile', kind: 'passthrough', why: '后端返回 {deleted, activeId}' },
  { name: 'switchProfile', kind: 'passthrough', why: '后端返回 {ok, activeId}' },
  { name: 'checkDeployed', kind: 'passthrough', why: '后端返回 DeployStatus' },
  { name: 'runDeploy', kind: 'passthrough', why: '异步任务，结果走 SSE' },
  { name: 'runScan', kind: 'passthrough', why: '异步任务，结果走 SSE' },
  { name: 'downloadUpdate', kind: 'passthrough', why: '后端返回 {started, target, note}；file 由 SSE 提供' },
  { name: 'applyUpdate', kind: 'passthrough', why: '后端返回 {ok, error?, path?}' },
  { name: 'serviceStatus', kind: 'passthrough', why: '后端返回 {port, host, version, ...}' },
]

function extractMethod(src, name) {
  const re = new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?(?:function\\s*\\(|\\()`, 'm')
  const m = re.exec(src)
  if (!m) return null
  const start = m.index
  const rest = src.slice(start + m[0].length)
  const nextRe = /\n\s{4}[a-zA-Z_$][\w$]*\s*:/
  const nm = nextRe.exec(rest)
  const end = nm ? start + m[0].length + nm.index : src.length
  return src.slice(start, end)
}

let bad = 0

console.log('=== 适配层返回值外壳契约校验 ===\n')

for (const c of CONTRACTS) {
  const body = extractMethod(adapter, c.name)
  if (body === null) {
    console.log(`FAIL  ${c.name}  —— 方法未找到`)
    bad++
    continue
  }

  let ok = true
  let detail = ''

  if (c.kind === 'array') {
    // 必须返回裸数组。
    //
    // ⚠️ 判定不能只看 `return {`：`listScanCountries` 里有
    // `.map(function(c) { return { code, name } })` 这种回调，
    // 会被误判成「返回对象外壳」。
    //
    // 真正的判据：**返回语句里的对象是否被当成了整体返回值的外壳**。
    // 具体就是检查有没有 `.then(... => ({ xxx: ... }))` 或在方法体末尾
    // 直接 `return { xxx: [...]` 的形式。这里退一步：
    // 只要返回的是 `.map(...)` / `.filter(...)` / 变量 / `[]` 或
    // `FALLBACK` 这类数组来源，就认为是裸数组；只有形如
    // `return { 单层字段名: ` 且该字段不是 createProfile 那种模板
    // 才判为外壳。
    const looksArray =
      /return\s+FALLBACK/.test(body) ||
      /\.filter\(/.test(body) ||
      /\.map\(/.test(body) ||
      /return\s+\[\]/.test(body)

    // 检查是否有「整体包一层对象」的迹象：.then(r => ({ xxx: ... }))
    const wrapsInThen = /\.then\(\s*(?:function\s*\([^)]*\)\s*\{\s*)?return\s*\{\s*[a-zA-Z_$][\w$]*\s*:/.test(
      body
    )

    ok = looksArray && !wrapsInThen
    detail = ok ? '返回裸数组 ✓' : wrapsInThen ? '在 .then 里包了对象外壳' : '无法确认返回裸数组'
  } else if (c.kind === 'wrap') {
    // 必须产出指定字段
    const missing = c.fields.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(body))
    ok = missing.length === 0
    detail = ok ? `含全部字段 ${c.fields.join(' / ')} ✓` : `缺字段：${missing.join(', ')}`
  } else {
    // 透传：只要不把结果包成别的形状即可。这里只检查方法存在且有返回。
    ok = /return\s/.test(body)
    detail = '透传（形状由后端保证）'
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  [${c.kind}] ${c.name}`)
  if (!ok) {
    console.log(`        ${detail}`)
    console.log(`        原因：${c.why}`)
    bad++
  } else if (c.kind !== 'passthrough') {
    console.log(`        ${detail}`)
  }
}

console.log(
  bad === 0
    ? `\n全部通过：${CONTRACTS.length} 个方法的返回契约校验通过。`
    : `\n${bad} 项不匹配 —— 界面会在运行时读 undefined 后崩溃。`
)
process.exit(bad ? 1 : 0)
