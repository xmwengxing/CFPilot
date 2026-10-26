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
  /* 基础请求                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 调用后端 API。
   *
   * 约定：后端返回 { error: '...' } 时抛异常 ——
   * 与 Electron 版 ipcRenderer.invoke 抛异常的行为对齐，
   * 界面的 try/catch 不用改。
   */
  async function call(method, path, body) {
    const opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      // 带上 Cookie（会话鉴权靠它）
      credentials: 'same-origin',
    }
    if (body !== undefined) opts.body = JSON.stringify(body)

    const res = await fetch(path, opts)
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

  /** 建立（或复用）SSE 连接 */
  function ensureStream() {
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
      // EventSource 会自动重连；连接断开时把标志复位，
      // 下次订阅时能重新走 open 流程
      esReady = false
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

    /* ---------------- 凭据与账户 ---------------- */

    saveCredentials: function (input) {
      return post('/api/cred/save', input || {})
    },

    wipeCredentials: function () {
      return post('/api/cred/wipe')
    },

    credentialsState: function () {
      return get('/api/cred/state')
    },

    listProfiles: function () {
      // 后端返回 { profiles, activeId }，界面只关心 profiles
      return get('/api/profile/list').then(function (r) {
        return (r && r.profiles) || []
      })
    },

    createProfile: function (name) {
      return post('/api/profile/create', { name: name || '' }).then(function (r) {
        return r && r.profile
      })
    },

    updateProfile: function (id, patch) {
      const body = Object.assign({ id: id }, patch || {})
      return post('/api/profile/update', body).then(function (r) {
        return r && r.profile
      })
    },

    deleteProfile: function (id) {
      return post('/api/profile/delete', { id: id })
    },

    switchProfile: function (id) {
      return post('/api/profile/switch', { id: id })
    },

    currentProfile: function () {
      return get('/api/profile/current').then(function (r) {
        return (r && r.profile) || null
      })
    },

    /* ---------------- 账号与 KV ---------------- */

    detectAccount: function () {
      return post('/api/account/detect')
    },

    listKvOptions: function (accountId) {
      return post('/api/kv/list', { accountId: accountId || '' }).then(function (r) {
        return (r && r.options) || []
      })
    },

    createKvNamespace: function (accountId, title) {
      return post('/api/kv/create', { accountId: accountId || '', title: title || '' })
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
      return post('/api/scan/detect-host')
    },

    detectScanPath: function () {
      return post('/api/scan/detect-path')
    },

    listScanCountries: function () {
      // 后端返回 { countries: [{code,name}, ...] }。
      // 这里做两件事保证界面不空：
      //   1. 结构不符时返回内置兜底列表（界面至少有东西可选）
      //   2. 保证每项都有 code / name（缺 name 时用 code 顶上）
      var FALLBACK = [
        ['HKG', '香港'], ['TPE', '台北'], ['NRT', '东京'], ['KIX', '大阪'],
        ['ICN', '首尔'], ['SIN', '新加坡'], ['BKK', '曼谷'], ['KUL', '吉隆坡'],
        ['MNL', '马尼拉'], ['SGN', '胡志明'], ['BOM', '孟买'],
        ['SYD', '悉尼'], ['MEL', '墨尔本'], ['AKL', '奥克兰'],
        ['LAX', '洛杉矶'], ['SJC', '圣何塞'], ['SEA', '西雅图'],
        ['DFW', '达拉斯'], ['ORD', '芝加哥'], ['IAD', '华盛顿'], ['EWR', '纽瓦克'],
        ['YYZ', '多伦多'], ['LHR', '伦敦'], ['MAN', '曼彻斯特'],
        ['AMS', '阿姆斯特丹'], ['FRA', '法兰克福'], ['CDG', '巴黎'],
        ['MAD', '马德里'], ['MXP', '米兰'], ['ARN', '斯德哥尔摩'],
        ['WAW', '华沙'], ['IST', '伊斯坦布尔'], ['DXB', '迪拜'],
        ['TLV', '特拉维夫'], ['JNB', '约翰内斯堡'], ['GRU', '圣保罗'],
        ['EZE', '布宜诺斯艾利斯'], ['MEX', '墨西哥城'],
      ]
      return get('/api/scan/countries')
        .then(function (r) {
          var list = (r && r.countries) || []
          if (!Array.isArray(list) || list.length === 0) {
            return FALLBACK.map(function (p) {
              return { code: p[0], name: p[1] }
            })
          }
          return list.map(function (c) {
            return {
              code: String((c && c.code) || ''),
              name: String((c && c.name) || (c && c.code) || ''),
            }
          }).filter(function (c) {
            return c.code !== ''
          })
        })
        .catch(function () {
          // 接口挂了也要让界面能用
          return FALLBACK.map(function (p) {
            return { code: p[0], name: p[1] }
          })
        })
    },

    checkEnvironment: function () {
      return post('/api/scan/env-check')
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
