// 在 Node 里真实执行 adapter.js，模拟浏览器的完整交互流程。
//
// ## 为什么必须这样做（2026-10-26 复盘）
//
// 之前的测试都是「直接打 HTTP 接口」，而真实缺陷全在 **adapter.js 的
// 返回值转换层**：
//   - updateProfile 返回 profile 对象 → 界面判 !saved.ok 永远失败
//   - listProfiles 没补 active 字段 → 界面找不到当前账户
//
// 接口层面全部 200，测试全绿，但用户点按钮就报错。
// 所以必须在 JS 运行时里真的跑一遍适配层代码。
//
// ## 做法
//
// 用一个极简的浏览器环境垫片（fetch / location / history / localStorage /
// EventSource / window），然后 eval adapter.js，拿到 window.cfpilot，
// 按界面的真实调用顺序执行。

import { readFileSync } from 'node:fs'

const BASE = process.env.CFPILOT_BASE || 'http://127.0.0.1:19730'
const bootToken = process.argv[2]

if (!bootToken) {
  console.error('用法: node check-adapter-runtime.mjs <bootToken>')
  process.exit(1)
}

/* ---------------- 浏览器环境垫片 ---------------- */

// ⚠️ 必须先保存原生 fetch 的引用，再覆盖 globalThis.fetch。
// 否则 browserFetch 内部调用 `fetch(...)` 会递归到它自己 → 栈溢出。
const nativeFetch = globalThis.fetch

let cookieJar = ''

const fakeLocation = {
  search: '?t=' + bootToken,
  pathname: '/',
  hash: '',
  href: BASE + '/?t=' + bootToken,
}

// Node 的 fetch 不会自动管 Cookie，这里手动维护
async function browserFetch(url, opts = {}) {
  const full = url.startsWith('http') ? url : BASE + url
  const headers = Object.assign({}, opts.headers || {})
  if (cookieJar) headers['Cookie'] = cookieJar

  const res = await nativeFetch(full, { ...opts, headers, redirect: 'manual' })

  // 收集 Set-Cookie
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  for (const c of setCookie) {
    const kv = c.split(';')[0]
    if (kv) cookieJar = kv
  }
  return res
}

class FakeEventSource {
  constructor() {
    this.listeners = {}
  }
  addEventListener(name, cb) {
    ;(this.listeners[name] ||= []).push(cb)
  }
  close() {}
}

const storage = new Map()

globalThis.window = globalThis
globalThis.location = fakeLocation
globalThis.history = {
  replaceState() {
    /* 模拟地址栏清理，不改 fakeLocation 以便测试 */
  },
}
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}
globalThis.EventSource = FakeEventSource
globalThis.fetch = browserFetch
// 确保其它代码拿到的也是垫片后的版本
globalThis.console.error = ((orig) =>
  function (...args) {
    // 屏蔽 SSE 噪音，但保留真实错误
    if (String(args[0] || '').includes('SSE')) return
    orig.apply(console, args)
  })(console.error)

/* ---------------- 加载 adapter.js ---------------- */

const src = readFileSync('packages/desktop/webui/adapter.js', 'utf8')
// adapter.js 是 IIFE，直接 eval 即可在全局挂上 window.cfpilot
// eslint-disable-next-line no-eval
eval(src)

const api = globalThis.cfpilot
if (!api) {
  console.error('FAIL  adapter.js 没有挂载 window.cfpilot')
  process.exit(1)
}

/* ---------------- 按界面的真实顺序调用 ---------------- */

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`)
}

async function main() {
  console.log('=== 模拟界面真实交互流程 ===\n')

  // 1. 初始化：凭据状态
  const st = await api.credentialsState()
  check('credentialsState 返回 hasToken', typeof st.hasToken === 'boolean', `hasToken=${st.hasToken}`)

  // 2. 初始化：账户列表（空）
  let profiles = await api.listProfiles()
  check('listProfiles 返回数组', Array.isArray(profiles), `长度=${profiles.length}`)

  // 3. 新建账户（界面的第一步）
  const created = await api.createProfile()
  check('createProfile 返回带 id', !!(created && created.id), `id=${created && created.id}`)
  check('createProfile 返回 active=true', created && created.active === true)

  // 4. 写入 Token（界面第二步）
  const saved = await api.updateProfile(created.id, { cfToken: 'cfat_RUNTIME_TEST' })
  check('updateProfile 返回 { ok: true }', !!(saved && saved.ok === true), JSON.stringify(saved))

  // 5. 再拉一次列表，验证 active 字段
  profiles = await api.listProfiles()
  check('listProfiles 有 1 条', profiles.length === 1, `长度=${profiles.length}`)
  const activeOne = profiles.find((p) => p.active)
  check('listProfiles 能通过 p.active 找到当前账户', !!activeOne, activeOne ? activeOne.id : '未找到')
  check('新账户带上 hasToken=true', profiles[0] && profiles[0].hasToken === true)

  // 6. 凭据状态应反映 Token
  const st2 = await api.credentialsState()
  check('保存后 hasToken=true', st2.hasToken === true)

  // 7. 重复新建（模拟用户点两次「新账户」）
  const created2 = await api.createProfile()
  const saved2 = await api.updateProfile(created2.id, { cfToken: 'cfat_SECOND' })
  check('第二次新建也成功', !!(saved2 && saved2.ok))
  profiles = await api.listProfiles()
  check('现在有 2 个账户', profiles.length === 2, `长度=${profiles.length}`)
  const activeCount = profiles.filter((p) => p.active).length
  check('有且只有一个 active', activeCount === 1, `active 数量=${activeCount}`)

  // 8. 切换账户
  const sw = await api.switchProfile(created.id)
  check('switchProfile 返回 ok', !!(sw && sw.ok), JSON.stringify(sw))
  check('switchProfile 返回 activeId', sw && sw.activeId === created.id)

  // 9. 删除账户
  const del = await api.deleteProfile(created2.id)
  check('deleteProfile 返回 deleted', !!(del && del.deleted === true))
  check('deleteProfile 返回 activeId', typeof (del && del.activeId) === 'string')
  profiles = await api.listProfiles()
  check('删除后剩 1 个', profiles.length === 1, `长度=${profiles.length}`)

  // 10. 其他初始化接口
  const countries = await api.listScanCountries()
  check('listScanCountries 有数据', Array.isArray(countries) && countries.length > 0, `${countries.length} 个`)

  // listKvOptions 在无账号 ID 时会正常报业务错误，只验证错误可读，不算失败
  try {
    const kv = await api.listKvOptions('')
    check('listKvOptions 返回数组', Array.isArray(kv), `长度=` + kv.length)
  } catch (e) {
    check('listKvOptions 无账号时给出可读错误', /账号|KV|Token/.test(e.message), e.message)
  }

  const env = await api.checkEnvironment()
  check('checkEnvironment 返回 clean 布尔', typeof env.clean === 'boolean', `clean=${env.clean}`)
  check('checkEnvironment 返回 findings 数组', Array.isArray(env.findings))

  // 11. 更新检查
  const upd = await api.checkUpdate()
  check('checkUpdate 返回 current/hasUpdate', typeof upd.current === 'string' && typeof upd.hasUpdate === 'boolean')

  // 汇总
  const failed = results.filter((r) => !r.ok)
  console.log()
  console.log(failed.length === 0 ? '全部通过 ✅' : `${failed.length} 项失败 ❌`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('运行失败:', err)
  process.exit(1)
})


