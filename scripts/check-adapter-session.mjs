// 校验适配层的**会话 → SSE** 建立逻辑（2026-10-28 真实故障）。
//
// ## 背景：两个连环 bug
//
// ① **SSE 抢跑在会话建立之前**
//    适配层在换 Cookie 的 fetch 还没落地时就 `new EventSource('/api/events')`，
//    服务端回 401。按 HTML 规范，EventSource 收到**非 200** 会
//    **永久失败、不重连** → 整个会话都收不到实时日志。
//    表现：点「开始优选」后运行日志窗口一片空白。
//
// ② **「没有启动令牌」被当成「会话失效」**（修 ① 时引入的回归）
//    启动令牌是一次性的，用过就从地址栏抹掉（防泄露）。
//    用户**按 F5 刷新**后 URL 里没有 `t` 参数 ——
//    但**会话 Cookie 还活着**，所有 API 调用都正常。
//    当时的代码直接 `return Promise.resolve(false)`，
//    于是 `ensureStream()` 认为「会话没了」→ **SSE 永远不建立** →
//    刷新一次，实时日志就永久失联。
//
// ## 本脚本做什么
//
// 在**桩环境**里真的跑一遍适配层（不是静态 grep），断言：
//
//   A. 有启动令牌 → 等令牌换完 Cookie 再建 SSE
//   B. 无启动令牌但 Cookie 仍有效（刷新场景）→ **照样建 SSE**  ← 关键回归点
//   C. 会话确实失效（探针 401）→ 不建 SSE，并给出可诊断的提示
//
// 用法：node scripts/check-adapter-session.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ADAPTER = join(here, '..', 'packages', 'desktop', 'webui', 'adapter.js')
const src = readFileSync(ADAPTER, 'utf8')

let bad = 0
const ok = (msg) => console.log(`PASS  ${msg}`)
const fail = (msg) => {
  console.log(`FAIL  ${msg}`)
  bad++
}

/**
 * 在桩环境里跑适配层。
 *
 * @param opts.search        location.search（决定有没有启动令牌）
 * @param opts.sessionStatus 探测会话的那个接口返回什么状态
 * @param opts.tokenStatus   换令牌的接口返回什么状态
 */
async function runAdapter(opts) {
  const events = []
  let esCreated = 0
  let fetched = []

  const fakeFetch = async (url) => {
    const u = String(url)
    fetched.push(u)
    if (u.startsWith('/__session')) {
      return { ok: opts.tokenStatus === 200, status: opts.tokenStatus, text: async () => '' }
    }
    if (u.startsWith('/api/service/status')) {
      return { ok: opts.sessionStatus === 200, status: opts.sessionStatus, text: async () => '' }
    }
    return { ok: true, status: 200, text: async () => '{}' }
  }

  class FakeEventSource {
    constructor(url) {
      events.push(url)
      esCreated++
      this.readyState = 0
      this.listeners = {}
    }
    addEventListener(name, fn) {
      ;(this.listeners[name] ||= []).push(fn)
    }
    close() {}
  }

  const win = {
    location: { search: opts.search, pathname: '/', hash: '', href: 'http://127.0.0.1/' },
    cfpilot: undefined,
    fetch: fakeFetch,
    EventSource: FakeEventSource,
    localStorage: { getItem: () => null, setItem: () => {} },
    history: { replaceState: () => {} },
    console: { error: () => {}, warn: () => {}, log: () => {} },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    Promise,
    URLSearchParams,
    Response: class {},
    FormData: class {},
  }
  win.window = win
  win.globalThis = win

  // 用 Function 构造执行环境（适配层是 IIFE，直接 eval 会污染真实全局）
  const fn = new Function('window', 'document', 'location', 'fetch', 'EventSource', 'localStorage', 'history', 'console', 'btoa', 'setTimeout', 'clearTimeout', 'Promise', 'URLSearchParams', 'Response', 'FormData', src)
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } },
    documentElement: { classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
  }
  fn(win, doc, win.location, fakeFetch, FakeEventSource, win.localStorage, win.history, win.console, win.btoa, setTimeout, clearTimeout, Promise, URLSearchParams, win.Response, win.FormData)

  // 等适配层内部的 promise 链落地
  await new Promise((r) => setTimeout(r, 60))
  return { esCreated, events, fetched, cfpilot: win.cfpilot }
}

// ---- A. 有启动令牌 → 先换会话再建 SSE ----
{
  const r = await runAdapter({ search: '?t=boot123', sessionStatus: 200, tokenStatus: 200 })
  if (r.esCreated === 1) ok('A. 有启动令牌时建立了 SSE（1 条连接）')
  else fail(`A. 有启动令牌时应建立 1 条 SSE，实际 ${r.esCreated}`)

  const tokenIdx = r.fetched.findIndex((u) => u.startsWith('/__session'))
  const sseIdx = r.fetched.findIndex((u) => u.startsWith('/api/service/status'))
  if (tokenIdx >= 0 && sseIdx >= 0 && tokenIdx < sseIdx) {
    ok('A. 顺序正确：先换会话，再探会话')
  } else {
    fail(`A. 顺序不对（token@${tokenIdx} probe@${sseIdx}）`)
  }
}

// ---- B. 无启动令牌（刷新场景）但 Cookie 有效 → 仍要建 SSE ← 关键回归点 ----
{
  const r = await runAdapter({ search: '', sessionStatus: 200, tokenStatus: 200 })
  if (r.esCreated === 1) ok('B. 刷新后（无令牌、Cookie 有效）仍建立了 SSE  ← 关键回归点')
  else fail(`B. 刷新后应建立 1 条 SSE，实际 ${r.esCreated} —— 实时日志会永久失联！`)

  const probed = r.fetched.some((u) => u.startsWith('/api/service/status'))
  if (probed) ok('B. 无令牌时会探一次会话（而不是直接判定失效）')
  else fail('B. 无令牌时应探一次会话')
}

// ---- C. 会话确实失效 → 不建 SSE ----
{
  const r = await runAdapter({ search: '', sessionStatus: 401, tokenStatus: 200 })
  if (r.esCreated === 0) ok('C. 会话确实失效时不建 SSE（不产生无意义的 401）')
  else fail(`C. 会话失效时不该建 SSE，实际 ${r.esCreated}`)
}

// ---- D. 网络层失败要给出可诊断提示（不是 "Failed to fetch"）----
{
  if (/无法连接本地服务/.test(src)) ok('D. 网络失败有可诊断提示（不再是裸的 "Failed to fetch"）')
  else fail('D. 网络层失败应给出「无法连接本地服务」这类可诊断提示')
}

// ---- E. EventSource 死了要能重建 ----
{
  if (/readyState === 2/.test(src) || /CLOSED/.test(src)) {
    ok('E. EventSource 永久失败后会置空，允许重建')
  } else {
    fail('E. EventSource 永久失败后应置空（否则永远建不回来）')
  }
}

console.log(
  bad === 0
    ? '\n全部通过：刷新页面后实时日志仍然可用，会话失效时能给出可诊断提示。'
    : `\n${bad} 项未通过`
)
process.exit(bad ? 1 : 0)
