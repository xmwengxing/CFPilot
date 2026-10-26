// 用真实 Token 走完整的业务链路（复现用户的真实操作序列）。
//
// ## 为什么需要这个（2026-10-26 连续两次漏检）
//
// 前两次的教训：
//   1. 只测 HTTP 接口 → 漏掉「前端忘了换会话」（全站 401）
//   2. 只测返回值字段存在 → 漏掉「外壳结构错了」
//      （listKvOptions 返回裸数组，界面读 .options 得到 undefined → 崩溃）
//
// 这两次都是「单测/接口测试全绿，用户一操作就崩」。
// 根因是我从没按用户的真实操作顺序走一遍。
//
// 本脚本严格按用户的点击序列执行，且**用真实 Token 打真实 API**：
//
//   1. 新建账户 → 保存 Token
//   2. 检测账号
//   3. 读 KV 列表          ← 用户在这里崩了
//   4. 筛选实例
//   5. 检查部署状态
//
// 用法：
//   CFPILOT_LIVE_TOKEN=cfat_xxx node scripts/check-live-flow.mjs <bootToken> [base]
import { readFileSync } from 'node:fs'

const bootToken = process.argv[2]
const BASE = process.argv[3] || 'http://127.0.0.1:19730'
const token = process.env.CFPILOT_LIVE_TOKEN

if (!bootToken) {
  console.error('用法: CFPILOT_LIVE_TOKEN=xxx node check-live-flow.mjs <bootToken> [base]')
  process.exit(1)
}
if (!token) {
  console.error('缺少 CFPILOT_LIVE_TOKEN 环境变量')
  process.exit(1)
}

/* ---------------- 浏览器垫片（与 runtime 测试一致）---------------- */

const nativeFetch = globalThis.fetch
let cookieJar = ''

globalThis.window = globalThis
globalThis.location = { search: '?t=' + bootToken, pathname: '/', hash: '' }
globalThis.history = { replaceState() {} }
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}
globalThis.EventSource = class {
  constructor() {}
  addEventListener() {}
  close() {}
}
globalThis.fetch = async function (url, opts = {}) {
  const full = url.startsWith('http') ? url : BASE + url
  const headers = Object.assign({}, opts.headers || {})
  if (cookieJar) headers['Cookie'] = cookieJar
  const res = await nativeFetch(full, { ...opts, headers, redirect: 'manual' })
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const kv = c.split(';')[0]
    if (kv) cookieJar = kv
  }
  return res
}

const origError = console.error
console.error = function (...args) {
  if (String(args[0] || '').includes('SSE')) return
  origError.apply(console, args)
}

/* ---------------- 加载适配层 ---------------- */

// eslint-disable-next-line no-eval
eval(readFileSync('packages/desktop/webui/adapter.js', 'utf8'))
const api = globalThis.cfpilot

/* ---------------- 按用户真实操作顺序执行 ---------------- */

const results = []
function step(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`)
}

async function main() {
  console.log('=== 真实业务链路（复现用户操作）===\n')

  // ---- 用户动作 1：新建账户 ----
  const created = await api.createProfile()
  step('1. 新建账户', !!(created && created.id), created.id)
  if (!created) throw new Error('新建失败，后续无法继续')

  // ---- 用户动作 2：填 Token 并保存 ----
  const saved = await api.updateProfile(created.id, { cfToken: token })
  step('2. 保存 Token', !!(saved && saved.ok), JSON.stringify(saved))
  if (!saved || !saved.ok) throw new Error('保存失败：' + (saved && saved.error))

  // ---- 用户动作 3：检测账号（真实 API）----
  let account
  try {
    account = await api.detectAccount()
    step('3. 检测账号', !!(account && account.accountId), account && account.accountName)
  } catch (e) {
    step('3. 检测账号', false, e.message)
    throw e
  }
  if (!account || !account.accountId) throw new Error('没有检测到账号')

  // ---- 用户动作 4：把账号信息写回 profile ----
  const upd = await api.updateProfile(created.id, {
    accountId: account.accountId,
    accountName: account.accountName,
  })
  step('4. 回写账号信息', !!(upd && upd.ok))

  // ---- 用户动作 5：读 KV 列表 ← 用户在这里崩了 ----
  let kvResult
  try {
    kvResult = await api.listKvOptions(account.accountId)
  } catch (e) {
    step('5. 读 KV 列表', false, e.message)
    throw e
  }

  // 关键断言：必须是 { options: [...] } 外壳
  const isWrapped = kvResult && typeof kvResult === 'object' && Array.isArray(kvResult.options)
  step('5a. listKvOptions 返回 { options: [...] }', isWrapped, typeof kvResult)
  if (!isWrapped) {
    console.log('      实际返回:', JSON.stringify(kvResult).slice(0, 200))
    throw new Error('外壳结构错误 —— 界面会读 undefined 后崩溃')
  }

  const kvOptions = kvResult.options
  step('5b. KV 列表可遍历', Array.isArray(kvOptions), `${kvOptions.length} 个`)

  // ---- 用户动作 6：筛选已部署实例（界面里的 .filter）----
  let instances
  try {
    instances = kvOptions.filter((o) => o.ownership === 'instance')
    step('6. 筛选 CFPilot 实例', true, `${instances.length} 个`)
  } catch (e) {
    step('6. 筛选 CFPilot 实例', false, e.message)
    throw e
  }

  if (instances.length > 0) {
    const i = instances[0]
    step('6b. 实例数据完整', !!(i.id && i.title && i.controlProject), `${i.title}`)
  }

  // ---- 用户动作 7：凭据状态（界面用来决定下一步）----
  const state = await api.credentialsState()
  step('7. 凭据状态', !!(state && typeof state.hasToken === 'boolean'), `hasToken=${state.hasToken}`)

  // ---- 用户动作 8：检查部署状态 ----
  const dep = await api.checkDeployed()
  step('8. 部署状态', !!(dep && typeof dep.state === 'string'), `state=${dep.state}`)

  // ---- 汇总 ----
  console.log()
  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) {
    console.log('全部通过 ✅ —— 用户可以正常走完「填 Token → 检测账号 → 选 KV」')
  } else {
    console.log(`${failed.length} 项失败 ❌`)
    for (const f of failed) console.log(`  - ${f.name}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('\n链路中断:', e.message)
  process.exit(1)
})
