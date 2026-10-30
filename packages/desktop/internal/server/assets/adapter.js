/**
 * CFPilot 界面适配层（Go 版专用）
 *
 * ## 这个文件解决什么问题
 *
 * 界面的业务代码（renderer.ts，1100+ 行）到处调用
 * `window.cfpilot.xxx()` —— 那是 Electron 的 preload 注入的 IPC 桥。
 * Go 版没有 preload，只有 HTTP 接口。
 *
 * 本文件在 window 上造一个**与 Electron 版完全同形**的 `window.cfpilot` 对象，
 * 内部把每个方法翻译成 `fetch('/api/...')`。
 *
 * 于是：
 *   - renderer.ts **一行都不用改**
 *   - 两个版本共用同一份界面源码
 *   - 以后改界面只需改一处
 *
 * ## 加载顺序（重要）
 *
 * index.html 里必须先加载本文件、再加载 renderer.js：
 *
 *   <script src="./adapter.js"></script>
 *   <script src="./renderer.js"></script>
 *
 * renderer.ts 在 DOMContentLoaded 时就取 `window.cfpilot` 并调用，
 * 晚一步就拿到 undefined。
 *
 * ## 事件推送：SSE → 回调
 *
 * Electron 的 `onLog(cb)` 是 `webContents.send` 的订阅；
 * 这里用**一条**共享的 EventSource 连接，把四种事件分发给各自的回调列表。
 * 每个界面通常只调一次 onXxx，但允许多个订阅者（便于将来分模块）。
 */
(function () {
  'use strict'

  /* ------------------------------------------------------------------ */
  /* 会话建立（关键：一切 API 的前置条件）                                */
  /* ------------------------------------------------------------------ */

  /**
   * 用 URL 里的 `?t=<启动令牌>` 换取会话 Cookie。
   *
   * ## 为什么必须有这一步（2026-10-26 真实故障）
   *
   * 后端的安全模型是：
   *   1. 启动时生成一次性令牌，拼在欢迎 URL 里：`/?t=abc123`
   *   2. 前端用这个令牌请求 `/__session?t=abc123`，后端返回
   *      `Set-Cookie: cfpilot_session=...; HttpOnly; SameSite=Strict`
   *   3. 之后所有 `/api/*` 请求靠这个 Cookie 鉴权
   *
   * **但最初的实现里，前端从来没有调用过 `/__session`** ——
   * 结果所有 API 都是 401，界面上「添加并保存」直接报
   * 「未授权：请从托盘菜单打开界面」。
   *
   * 更隐蔽的是：我用 curl / Invoke-WebRequest 测试时**手动调了 `/__session`**，
   * 所以自动化测试全过 —— 典型的「测试用手动步骤掩盖了真实缺陷」。
   * 只有真实浏览器打开界面才暴露。
   *
   * ## 为什么要返回 Promise
   *
   * 会话建立必须**先完成**，否则后续 window.cfpilot 的任何调用都会 401。
   * 所以这里把 Promise 存起来，`call()` 里 await 它。
   */
  const sessionReady = (function establishSession() {
    // 从 URL 取启动令牌
    var params = new URLSearchParams(location.search)
    var bootToken = params.get('t') || ''

    if (!bootToken) {
      // 没有令牌：可能是**刷新后 URL 被清理**（令牌用过即从地址栏抹掉），
      // 或用户直接访问根路径。
      //
      // ⚠️ **Cookie 可能仍然有效** —— 不能就此判定「会话未建立」。
      //
      // 之前这里直接 `return Promise.resolve(false)`，
      // 于是刷新页面后 `ensureStream()` 认为会话没了 → **SSE 永远不建立**
      // → 实时日志（优选进度、部署日志）全部收不到。
      // 表现：点「开始优选」后运行日志窗口一片空白。
      //
      // 所以这里**探一次**：拿现有的会话 Cookie 问一个受保护的接口，
      // 通了就算会话还在（后面的 SSE 就能带上 Cookie 建立）。
      return fetch('/api/service/status', {
        method: 'GET',
        credentials: 'same-origin',
      })
        .then(function (res) {
          return res.ok
        })
        .catch(function () {
          return false
        })
    }

    return fetch('/__session?t=' + encodeURIComponent(bootToken), {
      method: 'GET',
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) {
          console.error('[cfpilot] 会话建立失败（HTTP ' + res.status + '），可能是启动令牌已失效')
          return false
        }
        return true
      })
      .catch(function (err) {
        console.error('[cfpilot] 会话建立失败', err)
        return false
      })
      .then(function (ok) {
        // 令牌用过就从地址栏抹掉，避免：
        //   1. 刷新页面时重复使用（后端一次性令牌，第二次会 403）
        //   2. 截图/分享时泄露令牌
        try {
          if (ok && location.search) {
            var clean = location.pathname + location.hash
            history.replaceState(null, '', clean)
          }
        } catch (e) {
          /* 某些环境（file://）不支持，忽略 */
        }
        return ok
      })
  })()

  /* ------------------------------------------------------------------ */
  /* 基础请求                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 调用后端 API。
   *
   * 约定：后端返回 { error: '...' } 时抛异常 ——
   * 与 Electron 版 ipcRenderer.invoke 抛异常的行为对齐，
   * 界面的 try/catch 不用改。
   *
   * ⚠️ 所有请求都先 `await sessionReady`：会话没建好就发请求必然 401。
   */
  async function call(method, path, body) {
    // 等会话建立完成（已建立则立即返回）
    await sessionReady

    const opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      // 带上 Cookie（会话鉴权靠它）
      credentials: 'same-origin',
    }
    if (body !== undefined) opts.body = JSON.stringify(body)

    // ⚠️ **网络层失败要给出可诊断的提示**。
    //
    // `fetch` 抛出的 TypeError 消息固定是 "Failed to fetch" ——
    // 用户看到「读取日志失败：Failed to fetch」完全不知道发生了什么。
    // 最常见的原因就是**本地服务已经退出**（崩溃 / 被托盘菜单关掉）。
    let res
    try {
      res = await fetch(path, opts)
    } catch (err) {
      throw new Error(
        '无法连接本地服务（可能已退出，请从托盘菜单重新打开 CFPilot）：' +
          (err && err.message ? err.message : String(err))
      )
    }
    let data = null
    const text = await res.text()
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }

    if (!res.ok) {
      const msg =
        (data && data.error) ||
        (res.status === 401
          ? '未授权：请从托盘菜单重新打开界面'
          : '请求失败（HTTP ' + res.status + '）')
      throw new Error(msg)
    }
    if (data && typeof data === 'object' && typeof data.error === 'string' && data.error) {
      // 200 但带 error 字段（部分接口这么用）
      throw new Error(data.error)
    }
    return data
  }

  const post = (path, body) => call('POST', path, body === undefined ? {} : body)
  const get = (path) => call('GET', path)

  /* ------------------------------------------------------------------ */
  /* SSE 事件总线                                                        */
  /* ------------------------------------------------------------------ */

  /** 各事件的订阅者列表 */
  const listeners = {
    log: [],
    'deploy-status': [],
    'scan-result': [],
    'update-progress': [],
    'update-done': [],
  }

  let es = null
  let esReady = false

  /**
   * 真正建立 SSE 连接。
   *
   * 只在**会话已建立**之后才调用 —— 见 ensureStream 的说明。
   */
  function openStream() {
    if (es) return
    es = new EventSource('/api/events')

    es.addEventListener('open', function () {
      esReady = true
    })

    Object.keys(listeners).forEach(function (name) {
      es.addEventListener(name, function (e) {
        let payload = null
        try {
          payload = JSON.parse(e.data)
        } catch {
          return
        }
        listeners[name].forEach(function (cb) {
          try {
            cb(payload)
          } catch (err) {
            // 单个回调出错不能影响其它订阅者
            console.error('[cfpilot] 事件回调异常', name, err)
          }
        })
      })
    })

    es.addEventListener('error', function () {
      esReady = false
      // ⚠️ **必须把 es 置空**，否则这条连接就彻底废了。
      //
      // EventSource 的规范行为：收到**非 200 响应**（比如 401）时，
      // 浏览器会「永久失败」这条连接 —— **不会自动重连**。
      // 而 es 变量还指着这个已死的对象 → ensureStream() 里的
      // `if (es) return` 会认为「已经建好了」→ 永远不再重建。
      //
      // 症状：界面能打开、按钮能点，但**实时日志一条都不来**
      //（只有界面自己打的日志有）。
      //
      // 所以这里主动清空，让下次 ensureStream() 能重建。
      // （网络类错误 EventSource 自己会重连，但那种情况
      //   readyState 是 CONNECTING 而不是 CLOSED，不该重建。）
      if (es && es.readyState === 2 /* CLOSED */) {
        es = null
      }
    })
  }

  /**
   * 建立（或复用）SSE 连接。
   *
   * ## ⚠️ 必须等会话建立完成再连
   *
   * `/api/events` 走会话校验，没有 Cookie 就是 **401**。
   * 而 EventSource 收到非 200 响应会**永久失败**（不重连）——
   * 于是「会话 Cookie 还没种下就发起 SSE」会一次性毁掉整条推送通道。
   *
   * 真实故障（2026-10-28）：`sessionReady` 的 fetch 与
   * `new EventSource(...)` 几乎同时发出，EventSource 先落地 → 401 →
   * 之后**整个会话都收不到任何实时日志**，
   * 表现为「点开始部署只显示『开始部署』，后面再没有新日志」。
   *
   * 现在改成：等 `sessionReady` 落地后再建连接。
   */
  function ensureStream() {
    if (es) return
    if (!sessionReady) return
    sessionReady.then(function (ok) {
      if (es) return
      if (!ok) {
        console.error('[cfpilot] 会话已失效，实时日志不可用（请从托盘菜单重新打开界面）')
        return
      }
      openStream()
    })
  }

  /**
   * 订阅一个事件。
   *
   * 返回取消订阅函数 —— 与 Electron 版的 `onXxx` 返回值语义一致
   * （renderer.ts 里会保存返回值并在必要时调用）。
   */
  function subscribe(name, cb) {
    if (typeof cb !== 'function') return function () {}
    listeners[name].push(cb)
    ensureStream()
    return function () {
      const i = listeners[name].indexOf(cb)
      if (i >= 0) listeners[name].splice(i, 1)
    }
  }

  /* ------------------------------------------------------------------ */
  /* window.cfpilot —— 与 Electron preload 同形                          */
  /* ------------------------------------------------------------------ */

  /**
   * 兼容 Electron 版的参数形态。
   *
   * Electron 版里 `runDeploy(params, kvNamespaceId)` 是两个参数，
   * 这里合并成一个对象再发给后端。
   */
  function mergeDeployParams(params, kvNamespaceId) {
    const out = Object.assign({}, params || {})
    if (kvNamespaceId) out.kvNamespaceId = kvNamespaceId
    return out
  }

  const api = {
    /* ---------------- 部署 ---------------- */

    runDeploy: function (params, kvNamespaceId) {
      return post('/api/deploy/run', mergeDeployParams(params, kvNamespaceId))
    },

    checkDeployed: function (kvNamespaceId) {
      return post('/api/deploy/check', { kvNamespaceId: kvNamespaceId || '' })
    },

    // 读取清单里保存的面板凭据（面板地址 / 密码 / UUID / WS 路径）。
    //
    // 云端环境变量是加密的，所以这是用户拿回面板密码的唯一途径。
    getDeployCredentials: function (kvNamespaceId) {
      return post('/api/deploy/credentials', { kvNamespaceId: kvNamespaceId || '' })
    },

    /* ---------------- 凭据与账户 ----------------
     *
     * ## ⚠️ 返回值必须与 Electron 版**逐字段一致**（2026-10-26 严重故障）
     *
     * 界面代码（renderer.ts）是按 Electron 版的桥接契约写的，
     *
     *     const saved = await window.cfpilot.updateProfile(id, {...})
     *     if (!saved.ok) { log('新建账户失败：' + saved.error) }
     *
     * 我最初让适配层返回 `r.profile`（对象），于是 `saved.ok` 是 undefined
     * → **永远判定为失败**，而且 createProfile 已经先创建了一条记录，
     * 点几次就多几条「○ 新账户」。
     *
     * 正确契约（来自 packages/gui/src/main/bridge.ts）：
     *
     *   saveCredentials      → { saved: boolean }
     *   wipeCredentials      → { wiped: boolean }
     *   listProfiles         → ProfileView[]  ← 每项必须带 active 字段
     *   createProfile        → ProfileView
     *   updateProfile        → { ok: boolean, error?: string }
     *   deleteProfile        → { deleted: boolean, activeId: string }
     *   switchProfile        → { ok: boolean, activeId: string }
     *   currentProfile       → ProfileView | null
     *   credentialsState     → { hasToken, accountId, kvNamespaceId }
     */

    saveCredentials: function (input) {
      // 后端返回 { ok, profile }；Electron 版返回 { saved }。
      // 原样透传会让 `result.saved` 是 undefined，界面无法判断成功。
      return post('/api/cred/save', input || {}).then(function () {
        return { saved: true }
      })
    },

    wipeCredentials: function () {
      return post('/api/cred/wipe').then(function () {
        return { wiped: true }
      })
    },

    credentialsState: function () {
      // 后端已返回 { hasToken, accountId, kvNamespaceId, ... }，字段名一致
      return get('/api/cred/state')
    },

    listProfiles: function () {
      // ⚠️ 必须给每一项补上 `active` 字段。
      // 后端返回的是 { profiles, activeId } —— profiles 里没有 active，
      // 而界面用 `profiles.find(p => p.active)` 找当前账户，
      // 不补就会永远是 undefined → 下拉框选不中、切换逻辑失效。
      return get('/api/profile/list').then(function (r) {
        var list = (r && r.profiles) || []
        var activeId = (r && r.activeId) || ''
        return list.map(function (p) {
          return Object.assign({}, p, { active: p.id === activeId })
        })
      })
    },

    createProfile: function (name) {
      return post('/api/profile/create', { name: name || '' }).then(function (r) {
        var p = (r && r.profile) || null
        if (!p) throw new Error('新建账户失败：后端没有返回账户信息')
        // 与 listProfiles 保持一致：新建的账户即为激活项
        return Object.assign({}, p, { active: true })
      })
    },

    updateProfile: function (id, patch) {
      // ⚠️ 返回 { ok, error? }，不是 profile 对象
      return post('/api/profile/update', Object.assign({ id: id }, patch || {}))
        .then(function () {
          return { ok: true }
        })
        .catch(function (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        })
    },

    deleteProfile: function (id) {
      // 后端返回 { deleted, activeId }，与 Electron 版一致
      return post('/api/profile/delete', { id: id })
    },

    switchProfile: function (id) {
      // 后端返回 { ok, activeId }，与 Electron 版一致
      return post('/api/profile/switch', { id: id })
    },

    currentProfile: function () {
      return get('/api/profile/current').then(function (r) {
        var p = (r && r.profile) || null
        return p ? Object.assign({}, p, { active: true }) : null
      })
    },

    /* ---------------- 账号与 KV ---------------- */

    detectAccount: function () {
      return post('/api/account/detect')
    },

    // 链式代理：取内嵌脚本（原文 + 手动执行命令）
    chainScript: function () {
      return get('/api/chain/script')
    },

    // 链式代理：本机 ssh 远程执行部署脚本。
    //
    // ⚠️ 这是一个**长请求**（装 sing-box + 起 systemd，慢机器上要几十秒），
    // 所以不走 post() 的默认超时策略 —— 见下方 call 的实现说明。
    // 后端上限 3 分钟，超时会带着已收到的输出返回 ok:false。
    chainDeploy: function (params) {
      return post('/api/chain/run', {
        host: (params && params.host) || '',
        port: (params && params.port) || 1080,
      })
    },

    listKvOptions: function (accountId) {
      // ⚠️ 返回 `{ options: [...] }`，不是裸数组！
      //
      // 界面代码是：
      //     const result = await window.cfpilot.listKvOptions(id)
      //     kvOptions = result.options        ← 期望对象外壳
      //
      // 早期我返回裸数组，于是 result.options 是 undefined，
      // 后面 kvOptions.filter(...) 直接抛
      // 「Cannot read properties of undefined (reading 'length')」。
      return post('/api/kv/list', { accountId: accountId || '' }).then(function (r) {
        return { options: (r && r.options) || [] }
      })
    },

    createKvNamespace: function (accountId, title) {
      // 界面期望直接拿到 { id, title }，后端返回的也是这个形状
      return post('/api/kv/create', {
        accountId: accountId || '',
        title: title || '',
      })
    },

    /* ---------------- 优选 ---------------- */

    runScan: function (params) {
      // Electron 版是「等扫描完成再 resolve」，这里保持同样语义：
      // 启动扫描后等待 scan-result 事件，拿到结果再 resolve。
      // 这样 renderer.ts 里 `const result = await api.runScan(...)`
      // 那一行完全不用改。
      return new Promise(function (resolve, reject) {
        let settled = false

        const unsub = subscribe('scan-result', function (payload) {
          if (settled) return
          settled = true
          unsub()
          clearTimeout(timer)
          if (payload && payload.ok === false) {
            reject(new Error((payload && payload.error) || '优选失败'))
          } else {
            resolve(payload)
          }
        })

        // 兜底超时：扫描最长按 10 分钟算（候选多 + 网络慢）
        const timer = setTimeout(function () {
          if (settled) return
          settled = true
          unsub()
          reject(new Error('优选超时（超过 10 分钟未返回结果）'))
        }, 10 * 60 * 1000)

        post('/api/scan/run', params || {}).catch(function (err) {
          if (settled) return
          settled = true
          unsub()
          clearTimeout(timer)
          reject(err)
        })
      })
    },

    detectScanHost: function () {
      // ⚠️ 界面判断的是 `result.ok && result.host`，后端只返回 { host, source }
      // → ok 是 undefined，永远不会填域名。这里补上 ok 字段。
      return post('/api/scan/detect-host')
        .then(function (r) {
          if (r && r.host) {
            return {
              ok: true,
              host: r.host,
              // 后端给的是中文 source（"自定义域名" / "pages.dev 子域名"），
              // 界面比的是 'custom' / 'pages'
              source: String(r.source || '').indexOf('自定义') >= 0 ? 'custom' : 'pages',
            }
          }
          return { ok: false, error: (r && r.error) || '未能识别数据面域名' }
        })
        .catch(function (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        })
    },

    detectScanPath: function () {
      // 同上：界面判断 `result.ok && result.path`
      return post('/api/scan/detect-path')
        .then(function (r) {
          if (r && r.path) {
            return {
              ok: true,
              path: r.path,
              source: String(r.source || '').indexOf('KV') >= 0 ? 'kv' : 'env',
            }
          }
          return { ok: false, error: (r && r.error) || '未能识别 WS 路径' }
        })
        .catch(function (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        })
    },

    /**
     * 自动获取面板的一次性扫描令牌。
     *
     * 用保存的面板密码登录控制面，再调 /api/v1/scanner-token 换令牌。
     * 用户不用手动去面板点「生成令牌」。
     */
    /**
     * 把优选结果回填到面板的「手动优选 IP」。
     *
     * 服务端会现取临时令牌（10 分钟有效）再回填，
     * 所以不会出现「优选跑太久令牌过期」的问题。
     */
    pushScanResults: function (lines) {
      return post('/api/scan/push-results', { lines: lines || [] })
    },

    fetchScannerToken: function (host, password) {
      return post('/api/scan/scanner-token', {
        host: host || '',
        password: password || '',
      })
    },

    listScanCountries: function () {
      // 后端返回 { countries: [{code,name,group,colos}, ...] }，
      // `code` 是**国家码**（HK / JP / US），机房码放在 colos 里。
      //
      // 这里不再内置兜底表：界面只靠快捷分组（ASIA / US 关键字）
      // 也能完成筛选，内置一份国家表只会与后端漂移。
      return get('/api/scan/countries')
        .then(function (r) {
          var list = (r && r.countries) || []
          if (!Array.isArray(list)) return []
          return list.map(function (c) {
            return {
              code: String((c && c.code) || ''),
              name: String((c && c.name) || (c && c.code) || ''),
              group: String((c && c.group) || 'OTHER'),
              colos: Array.isArray(c && c.colos) ? c.colos.map(String) : [],
            }
          }).filter(function (c) {
            return c.code !== ''
          })
        })
        .catch(function () {
          return []
        })
    },

    listScanCountryGroups: function () {
      // 后端返回 { groups: { ASIA: [国家码], US: [国家码] } }。
      // 分组表只在后端维护一份；拿不到时返回 {} ——
      // 快捷分组的 ASIA / US 关键字仍然可用（后端自己会展开）。
      return get('/api/scan/countries')
        .then(function (r) {
          var g = (r && r.groups) || {}
          var out = {}
          Object.keys(g).forEach(function (k) {
            if (Array.isArray(g[k])) out[k] = g[k].map(String)
          })
          return out
        })
        .catch(function () {
          return {}
        })
    },

    checkEnvironment: function () {
      // ⚠️ 界面判断的是 `result.clean`（布尔），后端返回的是
      // { findings: [{kind, message, level}] } —— 缺 clean 字段，
      // 于是「环境正常」永远不会显示。这里做转换。
      return post('/api/scan/env-check')
        .then(function (r) {
          var findings = (r && r.findings) || []
          // 有任意一条 level=warn 就认为环境不干净
          var clean = !findings.some(function (f) {
            return f && f.level === 'warn'
          })
          return {
            clean: clean,
            // 界面用的是 string[]，后端给的是对象数组 → 拍平成文案
            findings: findings.map(function (f) {
              return (f && f.message) || String(f)
            }),
          }
        })
        .catch(function (err) {
          // 检测失败不该阻断优选，当作「无法判断」处理
          return {
            clean: true,
            findings: ['环境检测失败：' + (err && err.message ? err.message : String(err))],
          }
        })
    },

    /* ---------------- 一键优选 ---------------- */

    /**
     * 一键优选并回填面板。
     *
     * 与托盘菜单里的「一键优选 IP」是**同一个后端接口**：
     * 后台跑完整优选 + 回填面板，完成后由后端弹系统通知。
     */
    quickScan: function () {
      return post('/api/scan/quick')
    },

    /* ---------------- 优选历史与复测（Go 版新增） ---------------- */

    /**
     * 读取本机保存的优选历史（最新在前）。
     *
     * 优选成功由**后端**自动留底（本地优选 / 一键优选都会写），
     * 界面只读不写 —— 避免双写竞态。
     */
    getScanHistory: function () {
      return get('/api/scan/history')
        .then(function (r) {
          return {
            ok: !!(r && r.ok),
            sessions: (r && r.sessions) || [],
            error: (r && r.error) || '',
          }
        })
        .catch(function (err) {
          return {
            ok: false,
            sessions: [],
            error: err && err.message ? err.message : String(err),
          }
        })
    },

    /** 删除一条优选历史会话 */
    deleteScanHistory: function (id) {
      return call('DELETE', '/api/scan/history?id=' + encodeURIComponent(id || ''))
    },

    /**
     * 对选中的 IP 跑分层可用性复测（TCP → TLS → WS101，可选测速）。
     *
     * ⚠️ host / wsPath / probePath 必须用**历史会话里保存的参数**，
     * 不是当前表单的值 —— 否则改过表单后复测会打到错误的域名上。
     * 传 sessionId 时复测结论会写回该历史会话的条目。
     */
    reTestIps: function (params) {
      return post('/api/scan/re-test', {
        sessionId: (params && params.sessionId) || '',
        host: (params && params.host) || '',
        wsPath: (params && params.wsPath) || '',
        probePath: (params && params.probePath) || '',
        withSpeed: !!(params && params.withSpeed),
        targets: (params && params.targets) || [],
      }).then(function (r) {
        return {
          ok: !!(r && r.ok),
          results: (r && r.results) || [],
          error: (r && r.error) || '',
        }
      })
    },

    /* ---------------- 日志 ---------------- */

    /**
     * 读取本机日志文件（末尾若干行）。
     *
     * @param tail 取末尾多少行（默认 500，后端上限 5000）
     */
    getLogs: function (tail) {
      return get('/api/logs?tail=' + (tail || 500))
    },

    /**
     * 在文件管理器中打开文件所在的文件夹。
     *
     * 日志页的「打开日志文件所在文件夹」用它 ——
     * 后端 /api/update/reveal 接受任意文件路径并打开它**所在的目录**，
     * 所以不必为日志单独加一个接口。
     */
    revealFile: function (file) {
      return post('/api/update/reveal', { file: file || '' })
    },

    /* ---------------- 更新 ---------------- */

    checkUpdate: function () {
      return post('/api/update/check')
    },

    downloadUpdate: function (url, version) {
      return post('/api/update/download', {
        url: url,
        version: version || '',
      })
    },

    applyUpdate: function (file) {
      // Go 版不做自动替换（单二进制无法覆盖自己，且自动替换未签名
      // 的镜像文件风险更高）。改为在文件管理器里定位文件，让用户手动替换。
      return post('/api/update/reveal', { file: file })
    },

    /* ---------------- 服务管理（Go 版新增） ---------------- */

    serviceStatus: function () {
      return get('/api/service/status')
    },

    setServicePort: function (port) {
      return post('/api/service/port', { port: port })
    },

    /* ---------------- 系统 ---------------- */

    openExternal: function (url) {
      // 只放行 https，避免被构造出 javascript: / file: 等协议
      if (!/^https:\/\//i.test(url)) return Promise.resolve()
      window.open(url, '_blank', 'noopener,noreferrer')
      return Promise.resolve()
    },

    /* ---------------- 事件订阅 ---------------- */

    onLog: function (cb) {
      return subscribe('log', cb)
    },

    onDeployStatus: function (cb) {
      return subscribe('deploy-status', cb)
    },

    onScanResult: function (cb) {
      return subscribe('scan-result', cb)
    },

    onUpdateProgress: function (cb) {
      return subscribe('update-progress', cb)
    },

    /* ---------------- 版本信息 ---------------- */

    // 界面上「一键部署」下方的版本显示会读这个（Electron 版来自 app.getVersion）
    appVersion: 'unknown',
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * ⚠️ `window.cfpilot` 必须**最先**赋值。
   *
   * 曾经的写法是先 `ensureStream()` 再 `window.cfpilot = api`，
   * 结果：只要 EventSource 构造抛异常（浏览器禁用 / 连接数超限 /
   * 加载顺序异常），整个脚本就中断在那一行，
   * `window.cfpilot` 永远不会被赋值 →
   * renderer.ts 里所有 `window.cfpilot.xxx()` 全部 TypeError →
   * 界面看起来「加载出来了」，但国家列表、账户、部署按钮**全部无反应**。
   *
   * 真实症状：机房国家列表一直停在「正在加载国家列表…」。
   *
   * 所以现在：先挂对象，再干那些可能失败的初始化，且每步各自兜住异常。
   */
  window.cfpilot = api

  // 建立 SSE 连接（失败不影响 API 可用性）
  try {
    ensureStream()
  } catch (err) {
    console.error('[cfpilot] SSE 连接建立失败（实时日志不可用，但功能仍可使用）', err)
  }

  // 取版本号填入（失败保持 unknown）
  try {
    api
      .serviceStatus()
      .then(function (st) {
        if (st && st.version) api.appVersion = st.version
      })
      .catch(function () {
        /* 取不到就保持 unknown，不阻断界面 */
      })
  } catch (err) {
    console.error('[cfpilot] 读取版本失败', err)
  }
})()
