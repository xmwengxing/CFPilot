/**
 * 渲染层逻辑
 *
 * 注意：这里拿不到 Node 能力，也拿不到令牌明文。
 * 所有敏感操作通过 window.cfpilot 转主进程。
 */
import {
  escapeHtml,
  formatTaskTime,
  scanParamsSummary,
  taskRowHtml,
  taskStatusText,
} from './task-rows'

(function () {
  'use strict'

  function $(id: string) { return document.getElementById(id) as HTMLInputElement }

  /** 取下拉框元素 */
  function $sel(id: string): HTMLSelectElement {
    return document.getElementById(id) as unknown as HTMLSelectElement
  }

  /** 取文本节点元素 */
  function $text(id: string): HTMLElement {
    return document.getElementById(id) as unknown as HTMLElement
  }

  /**
   * 切到「说明」页时自动跑一次更新检查。
   *
   * 为什么：之前只有手点「检查更新」按钮才会检查，
   * 用户不点就永远不知道有新版 —— 那个按钮实际上等于没有。
   * 切到说明页本来就是用户想看「有没有新东西」的时刻，
   * 这时自动查一次最自然。
   *
   * 声明在这里是因为 runUpdateCheck 定义在后面（函数声明会提升，
   * 但为了可读性用可空引用）。
   */
  let autoCheckOnAbout: (() => void) | null = null

  /**
   * 切到「日志」页时自动加载一次日志。
   *
   * 为什么只在「还没加载过」时拉：用户可能正在读日志内容，
   * 每次切页都重拉会把滚动位置顶回底部、把刚看到的内容冲掉。
   * 想看最新内容点「刷新」即可。
   *
   * 与 autoCheckOnAbout 同样用「模块级可空引用」，
   * 因为 loadLogs 定义在后面。
   */
  let autoLoadLogs: (() => void) | null = null

  /** 切到「数据源」页时首次自动加载（切回来不重拉，避免冲掉用户勾选）。 */
  let autoLoadSources: (() => void) | null = null

  function switchPage(name: string): void {
    document.querySelectorAll('#nav button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.page === name)
    })
    document.querySelectorAll('.page').forEach((p) => {
      p.classList.toggle('active', p.id === 'page-' + name)
    })
    // 切页时把焦点从输入框移开，避免背景页仍可 Tab 到
    ;(document.activeElement as HTMLElement | null)?.blur()
    // 说明页：自动查一次更新
    if (name === 'about' && autoCheckOnAbout) {
      autoCheckOnAbout()
    }
    // 日志页：第一次切进来时自动加载一次（已加载过就不重复拉）
    if (name === 'logs' && autoLoadLogs) {
      autoLoadLogs()
    }
    // 数据源页：第一次切进来时拉一次配置 / 池 / 采集记录
    if (name === 'sources' && autoLoadSources) {
      autoLoadSources()
    }
    // 部署页：切进来后重算横向滚动。
    //
    // 为什么必须重算：页面**隐藏时**容器宽度是 0，测不出超出量，
    // 于是滚动没被启用 —— 用户切到这一页看到的仍然是一截被截断的文本。
    if (name === 'deploy') {
      refreshMarquees()
    }
  }

  /** 重新计算运行状态三行的横向滚动（页面可见时才有意义）。 */
  function refreshMarquees(): void {
    const pairs: Array<[string, string]> = [
      ['rtEnvWrap', 'rtEnv'],
      ['rtDeployWrap', 'rtDeploy'],
      ['rtKernelWrap', 'rtKernel'],
    ]
    for (const [wrapId, innerId] of pairs) {
      const wrap = document.getElementById(wrapId)
      const inner = document.getElementById(innerId)
      if (wrap && inner) setupMarquee(wrap, inner)
    }
  }

  function log(message: string, level: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
    const box = $('logBox')
    const line = document.createElement('div')
    line.className = 'log-line ' + level
    const t = new Date()
    const stamp = String(t.getHours()).padStart(2, '0') + ':' +
      String(t.getMinutes()).padStart(2, '0') + ':' +
      String(t.getSeconds()).padStart(2, '0')
    line.innerHTML = '<span class="t">' + stamp + '</span>' + escapeHtml(message)
    box.appendChild(line)
    box.scrollTop = box.scrollHeight

    // 折叠状态下收到重要消息时自动展开，避免错过
    if (level === 'err' || level === 'warn') {
      const panel = $('logPanel')
      if (panel.classList.contains('collapsed')) {
        panel.classList.remove('collapsed')
        $('logHead').title = '点击折叠日志'
      }
    }
  }

  /**
   * 按「本平台有哪些能力」隐藏不该出现的模块。
   *
   * 目前只有一处：安卓上没有「定时优选任务」
   * （系统的后台冻结让定时跑不准，这部分交给容器形态做）。
   *
   * ⚠️ 用服务端注入的标志（window.__cfpilotCaps），
   *    不是等接口回来再判断 —— 那样页签会先闪一下才消失。
   */
  function applyCapabilities(): void {
    const caps = window.__cfpilotCaps
    if (!caps || caps.scheduledTasks !== false) return

    // 优选页签里的「定时优选任务」
    const tab = document.querySelector('[data-scan-tab="task"]')
    if (tab) (tab as HTMLElement).hidden = true
    // 「保存为定时任务」入口
    const save = document.getElementById('btnSaveTask')
    if (save) (save as HTMLElement).hidden = true
    // 整个任务面板（含本地优选 IP 池）
    const panel = document.getElementById('scanPanelTask')
    if (panel) (panel as HTMLElement).hidden = true
  }

  function escapeHtml(s: string): string {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }
    return s.replace(/[&<>"']/g, (c) => map[c]!)
  }

  /**
   * 全局兜底：把「没人接住的错误」显示出来。
   *
   * ## 为什么必须有
   *
   * 按钮的处理函数大多是 `async` 的，抛错时产生的是
   * **未处理的 Promise 拒绝** —— 浏览器只往控制台写一行，
   * 界面上一点动静都没有。
   *
   * 用户看到的症状就是「点了没反应，日志里什么都没有」：
   * 既不知道成没成功，也查不到原因，只能来问是不是坏了。
   *
   * 这里把这类错误也接到界面的日志面板上，
   * 至少能看见「到底报了什么」。
   *
   * ⚠️ 这里只**记录**，不吞掉 —— 不调用 preventDefault，
   *    开发者控制台里仍然能看到原始错误。
   */
  function installGlobalErrorHandlers(): void {
    window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      const reason = ev.reason
      const msg = reason && reason.message ? reason.message : String(reason)
      log('操作失败：' + msg, 'err')
    })
    window.addEventListener('error', (ev: ErrorEvent) => {
      const msg = ev.message || (ev.error && ev.error.message) || '脚本错误'
      log('脚本错误：' + msg, 'err')
    })
  }


  /**
   * 部署状态的形状（对应 Electron 的 DeployStatus / Go 版的 /api/deploy/check）。
   *
   * 抽成具名类型是因为 `applyDeployStatus` 被两处调用
   * （onDeployStatus 事件 + 「检查状态」按钮），需要共享同一份定义。
   */
  interface DeployStatusLike {
    hasDeploy?: boolean
    state: 'none' | 'outdated' | 'latest' | 'blocked'
    reason?: 'no-token' | 'no-account' | 'no-kv'
    build?: string
    localBuild?: string
    /**
     * 线上已部署的内核版本（semver）。
     *
     * 与 `build`（build 指纹 `<hash>-<hash>`，只能判断「一样不一样」）
     * 不同，**这个能判断新旧** —— 部署代码可以独立于应用版本更新，
     * 所以必须有一个可比较的版本号。
     */
    kernelVersion?: string
    /** 应用内嵌的内核版本（semver） */
    localKernelVersion?: string
    /** 远程最新的内核版本（semver）；查不到时为空串 */
    remoteKernelVersion?: string
    /** 远程内核比线上新 → 可更新部署 */
    kernelUpdatable?: boolean
    /** 查远程失败的原因（不阻断其它状态） */
    kernelRemoteError?: string
    controlProject?: string
    dataProject?: string
    controlSubdomain?: string
    dataSubdomain?: string
    customDomain?: string
    /**
     * 线上数据面的部署形态：pages / workers。
     *
     * 旧清单没有这个字段 → 后端按 pages 返回。
     * 界面靠它把「Pages / Workers」单选框回填成线上实际形态 ——
     * 不回填的话，一个 Workers 实例被顺手更新一次就会被悄悄改成 Pages。
     */
    dataPlaneMode?: 'pages' | 'workers'
    deployedAt?: string
    at?: string
  }

  /**
   * 渲染「部署状态」卡片的函数引用（模块级）。
   *
   * `checkDeployed()` 的返回值**不会自动渲染**，需要调用方把结果喂进来。
   * `await` 了返回值却丢弃结果 —— 用户点完按钮界面上什么都不变。
   *
   * 修法：把渲染逻辑提取成具名函数，两个入口都调它。
   * 但函数体很长（上百行）且在 bindDeploy 内部，
   * 直接用 const/function 都会碰上作用域或暂时性死区问题。
   *
   * 因此：在模块级声明可空引用，在 bindDeploy 里给它赋值。
   * 赋值发生在 IIFE 初始化期间，早于任何用户点击，所以运行时一定非空。
   */
  let applyDeployStatus: ((s: DeployStatusLike) => void) | null = null

  /**
   * 最近一次优选的结果（可复制格式：`IP:Port#COLO`）。
   *
   * 回填面板时用。放在模块级是因为 `renderScanResult`（模块级函数）
   * 要写它，而「回填」按钮（bindScan 内）要读它。
   */
  let lastScanLines: string[] = []

  /** 当前账号 ID（检测后填充） */
  let currentAccountId = ''
  /** 当前账号的可读标识（名称 + ID），并入 KV 提示显示 */
  let detectedAccountLabel = ''
  /** KV 选择的引导语（自动选中 / 多实例待选 / 无实例） */
  let kvGuidance = ''
  /** KV 候选列表 */
  let kvOptions: Array<{
    id: string
    title: string
    ownership: 'instance' | 'foreign' | 'cfpilot' | 'empty'
    controlProject?: string
    dataProject?: string
    at?: string
    build?: string
  }> = []

  async function refreshCredState(): Promise<void> {
    const state = await window.cfpilot.credentialsState()
    const badge = document.getElementById('tokenBadge')!
    if (state.hasToken) {
      badge.textContent = '已保存'
      badge.className = 'badge ok'
    } else {
      badge.textContent = '未保存'
      badge.className = 'badge info'
    }
    // 令牌与密码不回显：只在输入框留 placeholder
    $('cfToken').value = ''
    $('panelPassword').value = ''
    if (state.accountId) currentAccountId = state.accountId

    // ⚠️ 这里**不再**顺手拉 KV 列表。
    //
    // 早前在「刷新凭据状态」里也拉一次，而启动流程紧接着还会跑
    // detectAccountAndGuide()（它自己要 loadKvOptions）。
    // 结果是同一个 KV 列表被打两遍：每拉一次都要按命名空间逐个读部署清单，
    // 6 个命名空间就是十几个 Cloudflare API 请求 ——
    // 在跨境链路上等于把「检测要多久」直接翻倍，还多一倍失败概率
    // （实测第二次撞上 tls: unrecognized name 就直接把整次检测判成失败）。
    //
    // 现在 KV 列表只由 detectAccountAndGuide / loadKvOptions 的单一入口拉取。

    // 自动选中当前账户保存的 KV
    //
    // 多账户场景下，每个账户通常对应一个 KV（一个 KV = 一个实例）。
    // 切来切去时如果不同步 KV 下拉框，用户很容易在 A 账户下
    // 看到 B 账户的 KV 列表并选错，导致部署到别的实例上。
    //
    // 这里只在「下拉框里确实有这个选项」时才选中，
    // 避免把不存在的 id 写进去（那会让 select.value 变成空串）。
    const wantKv = (state.kvNamespaceId ?? '').trim()
    if (wantKv) {
      const sel = $sel('kvSelect')
      const exists = Array.from(sel.options).some((o) => o.value === wantKv)
      if (exists && sel.value !== wantKv) {
        sel.value = wantKv
        updateKvHint()
      }
    }
  }

  /** 把 KV 选项渲染进下拉框 */
  function renderKvOptions(selectedId?: string): void {
    const select = $sel('kvSelect')
    select.innerHTML = ''
    if (kvOptions.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = currentAccountId ? '（该账号下还没有 KV）' : '— 请先检测账号 —'
      select.appendChild(opt)
      return
    }
    for (const item of kvOptions) {
      const opt = document.createElement('option')
      opt.value = item.id
      if (item.ownership === 'instance') {
        opt.textContent = `● ${item.title} — 实例 ${item.controlProject}/${item.dataProject}（${item.at ?? ''}）`
      } else if (item.ownership === 'foreign') {
        // 被其他项目占用的命名空间：直接禁用，不给选中的机会。
        // 服务端 assertKvOwnership 也会硬拒绝，这里是第一道防线。
        opt.textContent = `✕ ${item.title} — 已被其他项目占用（不可用）`
        opt.disabled = true
      } else if (item.ownership === 'cfpilot') {
        opt.textContent = `○ ${item.title} — 含 CFPilot 残留配置`
      } else {
        opt.textContent = `○ ${item.title} — 空命名空间`
      }
      select.appendChild(opt)
    }
    if (selectedId) select.value = selectedId
    updateKvHint()
  }

  /** 根据当前选中的 KV 更新提示与部署页显示 */
  function updateKvHint(): void {
    const select = $sel('kvSelect')
    const id = select.value
    const item = kvOptions.find((o) => o.id === id)
    const hint = $text('kvHint')
    // ⚠️ 这里**不放目标账号信息**：账号在「当前使用」下拉里已经可见，
    // 再往这行注释里塞一遍只会让它变长、把真正的排障线索挤没。
    if (!item) {
      hint.textContent = currentAccountId
        ? kvGuidance || '请选择一个命名空间（全新部署时会自动创建 KV）。'
        : '选择账户后会自动检测账号与实例；检测到已部署实例会自动选中对应的 KV。'
      return
    }
    if (item.ownership === 'instance') {
      hint.textContent =
        `控制面 ${item.controlProject} / 数据面 ${item.dataProject}，部署于 ${item.at}。` + (kvGuidance ? ' ' + kvGuidance : '')
    } else if (item.ownership === 'foreign') {
      hint.textContent =
        '此命名空间已被其他项目占用，不能用于 CFPilot。' +
        'CFPilot 的数据面已完全自研，两者不再共用同一 KV' +
        '（会共享配额、混淆配置、让排查变难）。请到「部署」页新建一个实例。'
    } else if (item.ownership === 'cfpilot') {
      hint.textContent =
        '此命名空间含 CFPilot 的 CONFIG 键但没有部署清单（残留配置）。' +
        '部署会覆盖它，除非你确实知道自己在做什么。'
    } else {
      hint.textContent = '空命名空间，可用于部署新实例。'
    }
    // 换了 KV 之后，之前那次检测结果就不适用了 —— 清掉，回到本地留档显示。
    deployChecked = null
    autoDeployLabel = '开始部署'
    autoDeployPrimary = true
    autoDeployHint = '请先点击「检查部署状态」按钮判断部署操作选择。'
    syncDeployButton()
    // KV 列表变化后，部署页的「部署实例」信息也要跟着更新
    // （控制面 / 数据面项目名就来自这份列表）。
    void loadLocalDeployInfo()
  }

  /** 拉取 KV 列表 */
  async function loadKvOptions(): Promise<void> {
    if (!currentAccountId) {
      log('请先点「检测账号」', 'warn')
      return
    }
    log('读取 KV 列表…')
    const result = await window.cfpilot.listKvOptions(currentAccountId)
    kvOptions = result.options
    const state = await window.cfpilot.credentialsState()
    renderKvOptions(state.kvNamespaceId || undefined)
    log(`共 ${kvOptions.length} 个命名空间`, 'ok')
  }


  /** 「当前使用」下拉框里代表「新建账户」的哨兵值（不会与真实 profile id 冲突） */
  const NEW_PROFILE_VALUE = '__new__'

  /** 当前所有账户配置（渲染层缓存，不含 Token 明文） */
  let profiles: CFPilotProfileView[] = []

  /**
   * 重新拉取账户列表并渲染下拉框。
  /**
   * 重新拉取账户列表并渲染下拉框。
   *
   * - **`__new__`「＋ 新建账户」**：始终放在最下面。
   *   选中它 = 进入「新建」模式，Token 输入框后面显示「添加并保存」。
   * - **已有账户**：选中 = 切换过去，按钮显示「修改并保存」。
   *
   * 这样「新建 / 切换 / 修改」三个动作都收敛到「当前使用」这一个控件上，
   * 不再需要额外的「新建账户」按钮 —— 早前那个按钮用 `prompt()` 取名字，
   * 在 Electron 里没有反应，而且即使能弹也容易被误解成「已经建好了」。
   */
  async function refreshProfiles(selectId?: string): Promise<void> {
    profiles = await window.cfpilot.listProfiles()
    const sel = $sel('profileSelect')
    const previous = sel.value
    sel.innerHTML = ''

    for (const p of profiles) {
      const opt = document.createElement('option')
      opt.value = p.id
      const marks: string[] = []
      if (!p.hasToken) marks.push('未填 Token')
      if (p.accountName) marks.push(p.accountName)
      else if (p.accountId) marks.push(p.accountId.slice(0, 8))
      const suffix = marks.length > 0 ? ` — ${marks.join(' · ')}` : ''
      opt.textContent = (p.active ? '● ' : '○ ') + p.name + suffix
      sel.appendChild(opt)
    }

    // 新建项永远在最后
    const newOpt = document.createElement('option')
    newOpt.value = NEW_PROFILE_VALUE
    newOpt.textContent = '＋ 新建账户'
    sel.appendChild(newOpt)

    // 对齐：优先显式指定（新建账户成功后要切到新账户），
    // 其次保持用户刚选的那一项，其次激活项。
    //
    // ⚠️ 早前无条件「previous === __new__ 就保持 __new__」，于是
    // 「新建账户 → 填 Token → 添加并保存」之后下拉仍停在「＋ 新建账户」，
    // 用户看不到刚建好的账户，还会以为没保存成功。
    const active = profiles.find((p) => p.active)
    if (selectId && profiles.some((p) => p.id === selectId)) sel.value = selectId
    else if (previous === NEW_PROFILE_VALUE) sel.value = NEW_PROFILE_VALUE
    else if (active) sel.value = active.id
    else sel.value = NEW_PROFILE_VALUE

    $text('profileBadge').textContent = `${profiles.length} 个`
    updateProfileMode()
  }

  /** 下拉框是否停在「新建」项 */
  function isNewMode(): boolean {
    return $sel('profileSelect').value === NEW_PROFILE_VALUE
  }

  /**
   * 根据「当前使用」的选择同步界面状态。
   *
   * - 新建模式：按钮「添加并保存」、提示怎么填、清空输入框
   * - 已有账户：按钮「修改并保存」、显示是否已配 Token
   */
  function updateProfileMode(): void {
    const btn = document.getElementById('btnSaveToken') as HTMLButtonElement | null
    const hint = $text('profileHint')
    const tokenBadge = $text('tokenBadge')
    if (!btn) return

    if (isNewMode()) {
      btn.textContent = '添加并保存'
      btn.classList.add('btn-primary')
      btn.classList.remove('btn-ghost')
      tokenBadge.textContent = '待填写'
      tokenBadge.className = 'badge info'
      if (hint) {
        hint.textContent =
          '正在新建账户：粘贴一个 Cloudflare API Token 后点「添加并保存」。' +
          '不同账号用不同的 Token，各自独立保存。'
      }
      return
    }

    const target = profiles.find((p) => p.id === $sel('profileSelect').value)
    btn.textContent = '修改并保存'
    btn.classList.remove('btn-primary')
    btn.classList.add('btn-ghost')
    if (target) {
      tokenBadge.textContent = target.hasToken ? '已保存' : '未保存'
      tokenBadge.className = target.hasToken ? 'badge ok' : 'badge warn'
    }
    if (hint) {
      hint.textContent =
        '当前使用该账户。修改 Token 请右侧粘贴后「修改并保存」；'
    }
  }

  /**
   * 切换账户后清空上一账户的所有上下文，避免误操作。
   *
   * ## ⚠️ 必须连「部署页」一起清（2026-10-28 修的真实串号）
   *
   * 之前只清了凭据页的框（Token / 面板密码），**部署页的 5 个输入框没清**：
   *
   *   controlProject / dataProject / panelPath / wsPath / deployPanelPassword
   *
   * 而后端 `handleDeployRun` 会把它们**无条件写进部署**
   * （`deploy_routes.go`：`opt.ControlProject = req.ControlProject` …），
   * 且这些值**优先于清单**（非空就不随机生成）。
   *
   * 触发路径：账户 A 下在部署页填过项目名 / 面板路径 / WS 路径 / 面板密码
   * → 切到账户 B → **不回头看部署页**直接点「开始部署」
   * → A 的面板密码变成 B 实例的面板密码，A 的 WS 路径写进 B 的 KV CONFIG。
   *
   * Cloudflare 的 KV 是账号作用域，**挡不住这种串号** ——
   * 因为写进去的是**当前账户自己的 KV**，内容却是上一个账户的凭据。
   */
  function resetAccountContext(): void {
    currentAccountId = ''
    detectedAccountLabel = ''
    kvGuidance = ''
    kvOptions = []
    renderKvOptions()
    updateKvHint()
    $('cfToken').value = ''
    $('panelPassword').value = ''
    clearCredAlert()

    // 部署页的 5 个框：跨账户残留会造成凭据泄漏，必须一起清
    clearDeployFormFields()
  }

  /**
   * 清空部署页的输入框。
   *
   * 单独抽出来是因为除了「切换账户」，「新建账户模式」也要清同一批框。
   *
   * ⚠️ 这里**必须包含「数据面域名」（dataHost）**：
   * 它决定控制面 DATA_HOST（订阅里节点的 sni/host）。
   * 漏清的后果（2026-11-02 真机事故）：
   * 账号 A 更新部署 → 表单里留下 A 的数据面域名 → 切到账号 B →
   * 点「检查部署状态」不会覆盖已填内容 → 直接点「更新部署」→
   * **A 的域名被写进 B 的控制面 DATA_HOST** → B 的节点全部 -1。
   *
   * 同理，「数据面部署形态」也是账号相关的：A 选了 Workers，
   * 切到 B 后 B 也被悄悄按 Workers 部署。
   */
  function clearDeployFormFields(): void {
    for (const id of [
      'controlProject',
      'dataProject',
      'panelPath',
      'wsPath',
      'deployPanelPassword',
      // 数据面域名：跨账号残留会写坏 DATA_HOST（见上面的说明）
      'dataHost',
    ]) {
      const el = document.getElementById(id) as HTMLInputElement | null
      if (el) el.value = ''
    }
    // 数据面部署形态：回到默认（Pages），并允许「检查部署状态」按新账号的清单回填。
    dataPlaneTouched = false
    const planeRadio = document.querySelector(
      'input[name="dataPlane"][value="pages"]'
    ) as HTMLInputElement | null
    if (planeRadio) {
      planeRadio.checked = true
      syncDataPlaneUI()
    }
  }

  /** 绑定账户管理相关事件 */
  /**
   * 运行状态卡片
   *
   * 展示**本地可确证**的信息：本地服务、部署实例、内核版本、环境提示。
   *
   * 为什么不做「账号级用量监控」：Pages 不向 Worker 暴露账号级计量；
   * GraphQL 的字段随平台版本漂移且不支持内省，写死字段名迟早失效。
   * 所以平台侧请求量与配额交给控制台，这里给一个直达入口。
   */
  function fmtUptime(seconds: number): string {
    if (!seconds || seconds < 0) return '—'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return d + ' 天 ' + h + ' 小时'
    if (h > 0) return h + ' 小时 ' + m + ' 分'
    return m + ' 分钟'
  }

  /**
   * 让长文本横向滚动，且**不会滚到一半就消失**。
   *
   * 位移量必须按「超出部分」算：内容宽度 − 容器宽度。
   * 早前用 translateX(-100%)（按元素自身宽度位移），
   * 结果整段文本被一次性滑出容器 —— 用户看到的就是「滚一半就没了」。
   *
   * @param wrap 外层（overflow:hidden 的容器）
   * @param inner 内层（承载文本的元素）
   */
  function setupMarquee(wrap: HTMLElement | null, inner: HTMLElement | null): void {
    if (!wrap || !inner) return
    const apply = (): void => {
      const delta = inner.scrollWidth - wrap.clientWidth
      if (delta > 2) {
        wrap.style.setProperty('--mq-delta', delta + 'px')
        wrap.classList.add('scroll')
      } else {
        wrap.style.removeProperty('--mq-delta')
        wrap.classList.remove('scroll')
      }
    }
    apply()
    // 窗口宽度变化后超出量会变，重算一次（用 dataset 标记避免重复绑定）
    if (wrap.dataset.mqBound !== '1') {
      wrap.dataset.mqBound = '1'
      window.addEventListener('resize', apply)
    }
  }

  /** 运行状态：部署实例那一行的展示内容（账号 · KV · 控制面/数据面）。 */
  function renderDeployInstance(text: string, highlight: boolean): void {
    const el = $text('rtDeploy')
    const wrap = document.getElementById('rtDeployWrap')
    el.textContent = text
    el.classList.toggle('rt-hl', highlight)
    if (wrap) {
      wrap.title = text
      setupMarquee(wrap, el)
    }
  }

  /**
   * 运行状态：内核版本那一行。
   *
   * html 参数用于把「可升级」这类片段单独着色（内容全部经过转义）。
   */
  function renderKernelInfo(text: string, highlight: boolean, title: string, html?: string): void {
    const el = $text('rtKernel')
    const wrap = document.getElementById('rtKernelWrap')
    if (html) {
      el.innerHTML = html
    } else {
      el.textContent = text
    }
    el.classList.toggle('rt-hl', highlight)
    if (wrap) {
      wrap.title = title || text
      setupMarquee(wrap, el)
    }
  }

  /**
   * 常态显示：**只用本机信息**，不调用 Token。
   *
   * 内核版本 = 本程序内置的 + 最近一次部署留档的；
   * 部署实例 = 账号 · KV 名称 · 控制面/数据面项目名。
   */
  async function loadLocalDeployInfo(): Promise<void> {
    try {
      const info = await window.cfpilot.getLocalDeployInfo()
      const snap = info?.snapshot
      const localVersion = info?.localKernelVersion || ''
      const localBuild = info?.localBuild || ''

      // 凭据页已加载的 KV 列表（带控制面 / 数据面项目名）
      const selectedKv = $sel('kvSelect')?.value || ''
      const option = kvOptions.find((o) => o.id === (snap?.kvNamespaceId || selectedKv))
      // 本机已知的实例索引（KV 列表读取时由后端缓存到这里）
      const known = (info as { instances?: Record<string, { kvTitle?: string; controlProject?: string; dataProject?: string; kernelVersion?: string; build?: string; at?: string }> })?.instances
      const local = known ? known[snap?.kvNamespaceId || selectedKv] : undefined

      // 部署实例：账号邮箱 · 控制面 / 数据面
      // 三个来源依次兜底：本地快照 → 凭据页已加载的 KV 列表 → 本机实例索引。
      // 老用户没有本地快照（那是本版本才写的），光看它只能显示账号邮箱。
      const account = snap?.accountName || info?.accountName || detectedAccountLabel || ''
      const control = snap?.controlProject || option?.controlProject || local?.controlProject || ''
      const data = snap?.dataProject || option?.dataProject || local?.dataProject || ''
      const instanceParts: string[] = []
      if (account) instanceParts.push(account)
      if (control || data) instanceParts.push((control || '?') + ' / ' + (data || '?'))
      renderDeployInstance(
        instanceParts.length > 0 ? instanceParts.join(' · ') : '尚未选择账号（凭据页检测账号后自动显示）',
        instanceParts.length > 0
      )

      // 内核版本：本程序内置 + 最近一次部署
      //
      // ⚠️ 已经点过「检查部署状态」时**不要**用本地信息覆盖检测结果 ——
      // 那会把「当前已部署 / 最新发布」冲掉，用户点了按钮却看不到变化。
      if (deployChecked) {
        return
      }
      const localText =
        '本程序内置 ' + (localVersion ? 'v' + localVersion : '未知') + (localBuild ? ' · ' + localBuild : '')
      const lastVersion = snap?.kernelVersion || local?.kernelVersion
      const lastBuild = snap?.build || local?.build
      const lastText = lastVersion
        ? '最近部署 v' + lastVersion + (lastBuild ? ' · ' + lastBuild : '')
        : ''
      renderKernelInfo(
        [localText, lastText].filter(Boolean).join(' ｜ '),
        true,
        '本程序内置 = 当前桌面版自带的内核产物；最近部署 = 本机留档的上一次部署记录'
      )
    } catch {
      renderDeployInstance('读取本地部署记录失败', false)
      renderKernelInfo('读取失败', false, '')
    }
  }

  /**
   * 把真实的数据目录填进界面里标了路径的位置。
   *
   * 设置、凭据、日志三个文件都在数据目录下，所以按文件名拼就行。
   * 拿不到目录时保持界面上的默认文案（宁可粗略也别写个错的路径）。
   */
  function applyDataDir(dir: string): void {
    const base = dir.replace(/[\\/]+$/, '')
    const targets: Array<[string, string]> = [
      ['pathSecrets', base + sep() + 'secrets.json'],
      ['pathLog', base + sep() + 'cfpilot.log'],
    ]
    for (const [id, text] of targets) {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
  }

  /** 拼路径分隔符（Windows 是 \，其它是 /）。 */
  function sep(): string {
    return /\\/.test(navigator.userAgent) ? '\\' : '/'
  }

  async function loadRuntimeStatus(): Promise<void> {
    // 本机版本（真实值，不用「运行中」这种没有信息量的说法）
    try {
      const st = await window.cfpilot.serviceStatus()
      $text('rtLocal').textContent =
        '运行中 · 端口 ' + st.port + ' · 已运行 ' + fmtUptime(st.uptimeSeconds) + (st.version ? ' · v' + st.version : '')
      // 左上角 logo 下方也标一下版本 —— 用户第一眼就能确认跑的是哪个版本。
      const badge = document.getElementById('appVersion')
      if (badge) {
        badge.textContent = st.version ? 'v' + st.version : ''
        badge.title = st.version ? '本程序版本 ' + st.version : ''
      }
      // 凭据与日志的真实路径。
      //
      // ⚠️ 不能写死：桌面版在用户目录，安卓版在应用私有目录 ——
      //    写死的路径在别的平台上就是错的，用户按它去找会找不到。
      if (st.dataDir) {
        applyDataDir(st.dataDir)
      }
    } catch {
      $text('rtLocal').textContent = '读取失败'
    }
    try {
      const env = await window.cfpilot.checkEnvironment()
      const findings = env.findings || []
      // 显示**实际问题**，而不是"N 项提示"；过长时用横向滚动展示
      const text = findings.length ? findings.join('；') : '未发现干扰因素'
      $text('rtEnv').textContent = text
      const wrap = document.getElementById('rtEnvWrap')
      if (wrap) {
        wrap.title = text
        setupMarquee(wrap, $text('rtEnv'))
      }
    } catch {
      $text('rtEnv').textContent = '读取失败'
    }
    await loadLocalDeployInfo()
  }

  function bindRuntime(): void {
    // 「刷新」按钮已移除：刷新职责由「检查部署状态」接管。
    const analytics = document.getElementById('btnRtAnalytics')
    if (analytics) {
      analytics.addEventListener('click', () => {
        void window.cfpilot
          .detectAccount()
          .then((acc) => {
            const url = acc && acc.accountId
              ? 'https://dash.cloudflare.com/?account=' + acc.accountId
              : 'https://dash.cloudflare.com/'
            return window.cfpilot.openExternal(url)
          })
          .catch(() => window.cfpilot.openExternal('https://dash.cloudflare.com/'))
      })
    }
    void loadRuntimeStatus()
  }

  function bindProfiles(): void {
    $sel('profileSelect').addEventListener('change', async () => {
      // 选「新建」：不落盘、不切换，只是进入新建模式
      if (isNewMode()) {
        log('已切换到「新建账户」模式，粘贴 Token 后点「添加并保存」')
        resetAccountContext()
        updateProfileMode()
        kvGuidance = '填好 Token 并「添加并保存」后会自动检测账号。'
        updateKvHint()
        return
      }

      const id = $sel('profileSelect').value
      const target = profiles.find((p) => p.id === id)
      if (!target) { updateProfileMode(); return }

      log(`切换账户：${target.name}`)
      const res = await window.cfpilot.switchProfile(id)
      if (!res.ok) {
        log('切换失败', 'err')
        await refreshProfiles()
        return
      }

      resetAccountContext()
      await refreshProfiles()
      await refreshCredState()
      updateProfileMode()

      // 切到已有账户时**自动检测账号**（用户要求 2026-10-26）
      if (target.hasToken) {
        // detectAccountAndGuide 内部会 loadKvOptions，
        // 之后 refreshCredState 已经把该账户的 KV 选中了
        await detectAccountAndGuide()
      } else {
        kvGuidance = '该账户还没填 Token，请粘贴后点「修改并保存」。'
        updateKvHint()
      }
    })

    document.getElementById('btnProfileDelete')!.addEventListener('click', async () => {
      const id = $sel('profileSelect').value
      if (isNewMode()) {
        log('当前停在「新建账户」，没有可删除的账户', 'warn')
        return
      }
      const target = profiles.find((p) => p.id === id)
      if (!target) { log('请先选择一个账户', 'warn'); return }
      if (
        !confirm(
          `确定删除本地账户配置「${target.name}」？\n\n` +
            '只删除这台电脑上保存的凭据，不会影响 Cloudflare 上已部署的项目，' +
            '也不影响订阅地址。'
        )
      ) {
        return
      }
      const res = await window.cfpilot.deleteProfile(target.id)
      if (!res.deleted) { log('删除失败：找不到该配置', 'err'); return }
      log(`已删除本地账户「${target.name}」`, 'ok')
      resetAccountContext()
      await refreshProfiles()
      await refreshCredState()
    })

    document.getElementById('btnSavePanelPw')!.addEventListener('click', async () => {
      if (isNewMode()) {
        log('请先添加账户（粘贴 Token 并保存）再设置面板密码', 'warn')
        return
      }
      const pw = $('panelPassword').value
      if (!pw.trim()) { log('请先填写新的面板密码', 'warn'); return }
      await window.cfpilot.saveCredentials({ panelPassword: pw })
      $('panelPassword').value = ''
      log('面板密码已更新（下次部署生效）', 'ok')
    })
  }

  /**
   * 在凭据页显示一条**醒目**提示。
   *
   * ## 为什么必须醒目
   *
   * 用户一个 Cloudflare 账号下可能存在**多个** CFPilot 实例（多个 KV）。
   * 一旦选错 KV，后续「部署 / 优选 / 回填 / 订阅」会全部作用到**别的实例**上，
   * 而且不会有任何报错 —— 只会在很久以后表现为「面板数据不对」「回填没生效」。
   * 所以「没检测到实例」和「检测到多个实例」这两种情况必须一眼看见。
   */
  function showCredAlert(kind: 'ok' | 'warn' | 'danger', html: string): void {
    const box = document.getElementById('credAlert')
    if (!box) return
    const icon = document.createElement('span')
    icon.className = 'ico'
    icon.textContent = kind === 'ok' ? '✅' : kind === 'warn' ? '⚠️' : '⛔'
    // ⚠️ 类名不能叫 body —— 全局 .body 是应用布局的 flex 列，会把提示文字拆成一行一个
    const body = document.createElement('span')
    body.className = 'msg'
    body.innerHTML = html
    box.className = 'cred-alert ' + kind
    box.replaceChildren(icon, body)
    box.hidden = false
  }

  /** 清掉醒目提示（切换账户 / 重新检测时） */
  function clearCredAlert(): void {
    const box = document.getElementById('credAlert')
    if (!box) return
    box.hidden = true
    box.replaceChildren()
  }

  /**
   * 检测账号，并按「该账号下 CFPilot 实例的个数」自动决定 KV 选择。
   *
   * 规则（用户 2026-10-29 要求）：
   *   - **0 个实例** → 醒目提示「未检查到CFPilot 实例，请到「部署」页全新部署」
   *   - **1 个实例** → 自动选中并保存（唯一实例不用问，少一步操作）
   *   - **≥2 个实例** → 醒目提示「请在下方选择 KV」（绝不替用户猜）
   */
  async function detectAccountAndGuide(): Promise<void> {
    if (!hasActiveToken()) return
    clearCredAlert()
    log('检测账号…')
    try {
      const result = await window.cfpilot.detectAccount()
      // 「目标账号」不再单独占一行：可读标识并入 KV 提示。
      detectedAccountLabel = result.accountName
        ? result.accountName + '（' + result.accountId + '）'
        : result.accountId || ''
      if (!result.accountId) {
        kvGuidance = '没能读到账号，请检查 Token 权限是否正确。'
        updateKvHint()
        showCredAlert(
          'danger',
          '没能读到账号：请确认 Token 带有 <code>Account / Account Settings / Read</code> 权限。'
        )
        return
      }
      currentAccountId = result.accountId

      // 把账号名写回当前 profile，下拉框就能显示可读名称
      const active = profiles.find((p) => p.active)
      if (active) {
        await window.cfpilot.updateProfile(active.id, {
          accountId: result.accountId,
          accountName: result.accountName,
        })
        await refreshProfiles()
      }

      // 读 KV 列表，并判断有没有已部署的 CFPilot 实例
      await loadKvOptions()
      await autoPickKvByInstances()
    } catch (err) {
      log('检测账号失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      kvGuidance = '检测失败，请检查网络与 Token。'
      updateKvHint()
      showCredAlert('danger', '检测失败：请检查网络与 Token。')
    }
  }

  /**
   * 按「实例个数」自动选中 KV 并给出醒目提示。
   *
   * 单独抽出来是因为两条路径都要走它：
   *   1. 点「检测账号」
   *   2. 「当前使用」切到另一个已保存 Token 的账户
   */
  async function autoPickKvByInstances(): Promise<void> {
    const instances = kvOptions.filter((o) => o.ownership === 'instance')

    if (instances.length === 0) {
      kvGuidance = '这个账号下还没有部署过 CFPilot，去「部署」页部署一次即可。'
      updateKvHint()
      showCredAlert('danger', '未检查到CFPilot 实例，请到「部署」页全新部署。')
      log('该账号下没有已部署实例，请到「部署」页全新部署', 'warn')
      return
    }

    if (instances.length === 1) {
      const only = instances[0]
      $sel('kvSelect').value = only.id
      try {
        // 选中即保存：唯一实例没有歧义，不该再让用户点一次「保存」
        await window.cfpilot.saveCredentials({ kvNamespaceId: only.id })
      } catch {
        /* 保存失败不阻断：下拉框当前值仍会用于本次部署 */
      }
      kvGuidance = '已自动选中该账号下唯一的 CFPilot 实例。'
      updateKvHint()
      showCredAlert(
        'ok',
        '已自动选中唯一的 CFPilot 实例 <code>' + escapeHtml(only.title) + '</code>，KV 已保存。'
      )
      log('检测到 1 个实例，已自动选中并保存 KV：' + only.title, 'ok')
      return
    }

    // ≥2 个：绝不替用户选 —— 选错会让所有功能作用到错的实例上
    kvGuidance = '检测到 ' + instances.length + ' 个 CFPilot 实例，请从下方选择本次使用的 KV。'
    updateKvHint()
    showCredAlert(
      'danger',
      '检测到 <b>' + instances.length + '</b> 个 CFPilot 实例，请在下方选择 KV：<br>' +
        instances.map((i) => '<code>' + escapeHtml(i.title) + '</code>').join('、') +
        '<br>选错 KV 会让后续部署 / 优选 / 回填全部作用到别的实例上。'
    )
    log('检测到 ' + instances.length + ' 个实例，请手动选择本次使用的 KV', 'warn')
  }

  /** 当前是否已有可用 Token（激活账户已配置） */
  function hasActiveToken(): boolean {
    const active = profiles.find((p) => p.active)
    return Boolean(active?.hasToken)
  }

  /**
   * 最近一次「检查部署状态」的结果。
   *
   * 有了它，本地快照就不再覆盖检测结果 ——
   * 否则用户点了按钮，内核版本行却还是本地留档，看起来就是「点了没反应」。
   */
  let deployChecked: DeployStatusLike | null = null

  /**
   * 「自动判断」模式下，最近一次「检查部署状态」推导出的按钮文案与提示。
   *
   * ⚠️ 只存**结果**，不直接改 DOM：用户随时会切换本次操作模式，
   * 最终显示什么一律由 syncDeployButton() 按当前模式重新计算。
   */
  let autoDeployLabel = '开始部署'
  let autoDeployPrimary = true
  let autoDeployHint = '请先点击「检查部署状态」按钮判断部署操作选择。'

  /** 是否有长任务在跑（部署 / 扫描）。忙碌期间按钮不能被模式切换重新放开。 */
  let uiBusy = false

  function bindCredentials(): void {
    /**
     * 保存 Token。
     *
     * ## 关键：新建 vs 修改必须走不同路径
     *
     * 于是用户想新建第二个账户时，Token 把**当前账户**覆盖了，
     * 永远建不出第二个。这也是「新建按钮没反应」背后的真实后果。
     */
    document.getElementById('btnSaveToken')!.addEventListener('click', async () => {
      // ⚠️ 这里必须自己接住异常。
      //
      // 这是个 async 处理函数，抛错时是「未处理的 Promise 拒绝」——
      // 浏览器只往控制台写一行，界面上一点动静都没有，
      // 用户看到的症状就是「点了添加并保存，完全没反应」。
      // （适配层其实会抛出可读的错误，比如「未授权：请从托盘菜单重新打开界面」，
      //   但没人接就等于没有。）
      try {
        const token = $('cfToken').value.trim()
        if (!token) {
          log('请先填写 API Token', 'warn')
          $('cfToken').focus()
          return
        }

        if (isNewMode()) {
          const created = await window.cfpilot.createProfile()
          const saved = await window.cfpilot.updateProfile(created.id, { cfToken: token })
          if (!saved.ok) {
            log('新建账户失败：' + (saved.error ?? ''), 'err')
            return
          }
          log(`✅ 已新建账户并保存 Token（${created.name}）`, 'ok')
          resetAccountContext()
          // 显式选中刚创建的账户：后端 Create 已将 ActiveID 指向它，
          // 这里不能再沿用「保持 __new__」的旧规则。
          await refreshProfiles(created.id)
          await refreshCredState()
          // 新建后自动检测，省得用户再点一次
          await detectAccountAndGuide()
          return
        }

        const saved = await window.cfpilot.saveCredentials({ cfToken: token })
        if (saved && saved.saved === false) {
          log('Token 保存失败', 'err')
          return
        }
        log('Token 已更新到当前账户', 'ok')
        resetAccountContext()
        await refreshProfiles()
        await refreshCredState()
        await detectAccountAndGuide()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log('保存 Token 失败：' + msg, 'err')
      }
    })

    // 检测账号：**只绑一次**
    //
    // ⚠️ 这里曾经绑了两个监听（一个判断 Token、一个负责建 profile 与探测），
    // 点一次会跑两遍：两次 detectAccount + 两次 loadKvOptions，
    // 多实例场景下两次「自动选中」互相打架。现在合成为一个幂等流程。
    document.getElementById('btnDetect')!.addEventListener('click', async () => {
      const hasToken = hasActiveToken() || Boolean($('cfToken').value.trim())
      if (!hasToken) {
        log('请先填写 API Token 并保存', 'warn')
        showCredAlert('warn', '请先在上方填写 Cloudflare API Token 并点「添加并保存」。')
        return
      }

      // 没有账户配置时先建一份，避免「检测了但没地方存」
      if (profiles.length === 0) {
        log('还没有账户配置，先新建一份…')
        await window.cfpilot.createProfile()
        await refreshProfiles()
      }

      await detectAccountAndGuide()
    })

    document.getElementById('btnKvRefresh')!.addEventListener('click', async () => {
      await loadKvOptions()
    })

    document.getElementById('btnKvManual')!.addEventListener('click', async () => {
      const id = $('kvManual').value.trim()
      if (!id) { log('请先填写 KV 命名空间 ID', 'warn'); return }
      await window.cfpilot.saveCredentials({ kvNamespaceId: id })
      log(`已保存 KV ID：${id}`, 'ok')
      await loadKvOptions()
    })

    // KV 下拉框改变时**自动保存**
    //
    // 用户既然在这个下拉框里选了，意图已经明确 —— 选完立刻落盘。
    // 独立的「保存」按钮已移除（用户 2026-10-29 要求：选中账户与 KV 后自动保存）。
    $('kvSelect').addEventListener('change', async () => {
      updateKvHint()
      const id = $sel('kvSelect').value
      if (!id) return
      try {
        await window.cfpilot.saveCredentials({ kvNamespaceId: id })
      } catch {
        /* 保存失败不打断主流程，下次部署仍会用下拉框当前值 */
      }
    })

    document.querySelectorAll('a[data-url]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        void window.cfpilot.openExternal((a as HTMLElement).dataset.url!)
      })
    })
  }

  function readMode(): 'auto' | 'fresh' | 'update' {
    const el = document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null
    return (el?.value ?? 'auto') as 'auto' | 'fresh' | 'update'
  }

  /** 用户是否手动改过「数据面部署模式」单选框 */
  let dataPlaneTouched = false

  function readDataPlane(): 'pages' | 'workers' {
    const el = document.querySelector('input[name="dataPlane"]:checked') as HTMLInputElement | null
    return el?.value === 'workers' ? 'workers' : 'pages'
  }

  /**
   * 按当前选中的形态切换「自定义域名」输入框的可见性。
   *
   * 模式说明文案已移进各选项的 `title` 悬浮气泡（见 index.html），
   * 这里不再往页面上写第二份 —— 两处文案必然漂移。
   */
  function syncDataPlaneUI(): void {
    const mode = readDataPlane()
    const field = document.getElementById('dataHostField')
    if (field) field.style.display = mode === 'workers' ? 'block' : 'none'
  }

  /**
   * 统一的忙碌态开关。
   *
   * ⚠️ 不要用 `setAttribute('disabled', '')` 来「取消禁用」：
   * HTML 里只要 disabled 属性**存在**就是禁用状态，
   * 设成空字符串仍然禁用，表现为按钮永久变灰、必须重启程序。
   * 必须用 removeAttribute 或直接操作 .disabled 属性。
   */
  function setBusy(busy: boolean): void {
    uiBusy = busy
    for (const id of [
      'btnDeploy',
      'btnCheck',
      'btnScan',
      'btnDetect',
      'btnKvRefresh',
      'btnKvManual',
      'btnAutoDetect',
      'btnSaveTask',
    ]) {
      const el = document.getElementById(id) as HTMLButtonElement | null
      if (el) el.disabled = busy
    }
    // 忙碌态结束不能无条件放开「开始部署」：自动判断且未检查状态时它必须保持置灰。
    if (!busy) syncDeployButton()
  }

  /**
   * 统一计算「开始部署」按钮的文案 / 可用性 / 提示。
   *
   * 输入只有两个：当前操作模式（readMode）与是否已检查部署状态（deployChecked）。
   * 「检查部署状态」的结果只影响 auto 模式的文案，不会把按钮状态固定下来 ——
   * 用户切到任意模式都会重新算一遍，按钮名与实际触发的动作始终一致。
   */
  function syncDeployButton(): void {
    const btn = document.getElementById('btnDeploy') as HTMLButtonElement | null
    const hint = document.getElementById('deployActionHint')
    if (!btn) return
    const mode = readMode()

    if (mode === 'auto') {
      btn.textContent = autoDeployLabel
      btn.classList.toggle('btn-primary', autoDeployPrimary)
      btn.classList.toggle('btn-ghost', !autoDeployPrimary)
      // 没点过「检查部署状态」就不允许部署：避免拿过期结论去跑自动判断。
      // 长任务进行中也不能放开（此时切模式会重算按钮，不能把禁用冲掉）。
      btn.disabled = uiBusy || !deployChecked
      if (hint) {
        hint.textContent = deployChecked
          ? autoDeployHint
          : '请先点击「检查部署状态」按钮判断部署操作选择。'
      }
      return
    }

    btn.classList.add('btn-primary')
    btn.classList.remove('btn-ghost')
    btn.disabled = uiBusy
    if (mode === 'update') {
      btn.textContent = '更新现有部署'
      if (hint) {
        hint.textContent = '复用「凭据」页选中的 KV 与原有参数，更新控制面与数据面（不新建实例）。'
      }
    } else {
      btn.textContent = '全新部署'
      if (hint) hint.textContent = '新建独立 KV 与实例，不影响现有部署。'
    }
  }

  function bindDeploy(): void {
    // 数据面形态：切换时更新说明文案与「自定义域名」输入框
    document.querySelectorAll('input[name="dataPlane"]').forEach((el) => {
      el.addEventListener('change', () => {
        dataPlaneTouched = true
        syncDataPlaneUI()
      })
    })
    syncDataPlaneUI()

    // 「本次操作」切换时，按钮文案 / 可用性 / 提示必须立刻重新计算：
    // 不能停留在「检查部署状态」算出的那一次结果，否则按钮名与实际动作不符。
    document.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.addEventListener('change', () => {
        syncDeployButton()
        const value = (el as HTMLInputElement).value
        if (value === 'auto') {
          log('已切换到「自动判断」，请点击「检查部署状态」按钮判断部署操作选择')
        } else if (value === 'update') {
          log('已切换到「更新现有部署」，将复用当前 KV 与原有参数')
        } else {
          log('已切换到「全新部署」，将新建独立 KV 与实例')
        }
      })
    })
    // 初始状态：自动判断且尚未检查 → 置灰并提示先检查状态。
    syncDeployButton()

    /**
     * 渲染「部署状态」卡片的函数引用。
     *
     * `checkDeployed()` 的返回值**不会自动渲染**，需要调用方把结果喂进来。
     * `await` 了返回值却丢弃结果 —— 用户点完按钮界面上什么都不变，
     * 日志里只有一句「检查线上部署状态…」。
     *
     * 修法：把渲染逻辑提取成具名函数，两个入口都调它。
     * 但该函数体很长（上百行），且定义在 bindDeploy 靠后位置，
     * 而 btnCheck 处理器在前面 —— 直接用 `const`/`function` 都会有
     * 作用域/提升问题（TDZ 或块级提升不生效）。
     *
     * 所以用「先声明可空引用、定义处赋值」的方式：
     *   - 声明后立即可被前面的闭包引用（只是当时还是 null）
     *   - 赋值发生在 bindDeploy 执行过程中，早于任何用户点击
     */
    document.getElementById('btnDeploy')!.addEventListener('click', async () => {
      // 用下拉框当前选中的 KV；没有选中则自动新建
      //
      // 全新部署本来就必须有一个 KV（内核的配置键全局平铺在里面）。
      // 属于多此一举 —— 部署这一步已经知道需要 KV 了，直接建就好。
      //
      // 而且那个按钮很容易误触，每点一次就在账号下多一个命名空间，
      // 白白消耗免费额度。所以按钮也一并移除了。
      const select = $sel('kvSelect')
      const mode = readMode()
      // 自动判断必须先有检测结果：按钮默认置灰，这里再兜一层，
      // 防止通过键盘 / 脚本绕过禁用状态直接触发部署。
      if (mode === 'auto' && !deployChecked) {
        log('请先点击「检查部署状态」按钮判断部署操作选择', 'warn')
        return
      }
      let kvId = select.value
      if (mode === 'fresh') {
        // 全新部署 = 再开一套实例：**忽略**「Cloudflare 凭据」页选中的 KV，
        // 由后端新建一个独占的命名空间。
        //
        // 内核的 KV 键是全局平铺的（CONFIG / PANEL_PATH / ADMIN_PW_HASH …），
        // 没有实例前缀。拿已有实例的 KV 跑全新部署，等于把新的 UUID / WS 路径 /
        // 面板密码写进原实例的 CONFIG → 原实例的客户端节点全部失效，且无任何报错。
        kvId = ''
        log('全新部署：将新建独立的 KV 命名空间（不使用「凭据」页选中的 KV）')
      } else if (!kvId) {
        log('还没有 KV 命名空间，正在自动创建…')
        if (!currentAccountId) {
          log('请先点「检测账号」再部署（自动建 KV 需要账号 ID）', 'warn')
          return
        }
        try {
          const created = await window.cfpilot.createKvNamespace(currentAccountId)
          if (!created || !created.id) {
            log('自动创建 KV 失败，请到「Cloudflare 凭据」页手动刷新 KV 列表', 'err')
            return
          }
          kvId = created.id
          log(`已自动创建 KV：${created.title}`, 'ok')
          // 刷新下拉框并选中它，让用户看到用的是哪个
          await loadKvOptions()
          $sel('kvSelect').value = created.id
          // 顺手保存到账户，下次部署直接复用
          await window.cfpilot.saveCredentials({ kvNamespaceId: created.id })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log('自动创建 KV 失败：' + msg, 'err')
          return
        }
      }
      setBusy(true)
      // 日志里的动作名与按钮文案、实际传给后端的 mode 保持一致。
      log(
        mode === 'fresh'
          ? '── 开始全新部署 ──'
          : mode === 'update'
            ? '── 开始更新现有部署 ──'
            : '── 开始部署（自动判断）──'
      )

      // 部署页的面板密码**直接随部署请求传下去**，不写进账户
      // 。
      //
      // 历史问题：早期这里调 saveCredentials({panelPassword}) 把部署密码
      // 写进了账户的「修改已部署面板密码」字段，导致：
      //   - 在凭据页改了密码，下次部署的密码也跟着变
      //   - 云端环境变量加密，用户完全不知道自己的部署密码被改了
      //
      // 现在：部署密码只存在于本次请求里，留空就是随机 / 沿用清单。
      const deployPw = $('deployPanelPassword').value.trim()
      if (deployPw) {
        log('已使用本次填写的新面板密码')
      }

      try {
        const result = await window.cfpilot.runDeploy(
          {
            mode,
            force: $('optForce').checked,
            forceKv: $('optForceKv').checked,
            newCredentials: $('optNewCred').checked,
            controlProject: $('controlProject').value.trim(),
            dataProject: $('dataProject').value.trim(),
            panelPath: $('panelPath').value.trim(),
            wsPath: $('wsPath').value.trim(),
            // 数据面形态：始终发送当前选中值。
            // 后端只有在「与清单不一致」时才当成形态切换（并自动清理旧数据面）。
            dataPlaneMode: readDataPlane(),
            // 节点域名：只写进控制面 DATA_HOST，工具不绑定（要去 Worker 的「域」标签页自己加）
            dataHost: $('dataHost').value.trim(),
            // 本次部署要设的面板密码（留空 = 随机 / 沿用清单）
            panelPassword: deployPw,
          },
          kvId
        )
        // 全新部署时后端会新建 KV：把下拉框切过去，否则界面还显示旧实例的 KV
        if (result.kvNamespaceId) {
          await loadKvOptions()
          $sel('kvSelect').value = result.kvNamespaceId
          log(`已新建 KV：${result.kvTitle ?? result.kvNamespaceId}`, 'ok')
        }

        /**
         * 异步部署：这个响应只表示「已受理」，不是结果。
         *
         * Go 版把部署放到后台 goroutine 跑，接口立即返回 `{started:true}`，
         * 最终成败走 SSE 的 deploy-status 事件。原先这里无条件读 `result.ok`
         * —— 受理响应里根本没有 ok 字段，于是每次点部署都先闪一句
         * 「❌ 部署失败：」，几秒后才被 SSE 纠正，看起来像「先失败又莫名成功」。
         */
        // 「当前部署状态」卡已并入「运行状态」卡，这里只在日志里给出进度。
        if (result.started) {
          log('⏳ 部署进行中…（进度见下方日志）')
        } else if (result.ok === false || result.error) {
          log('❌ 部署失败：' + (result.error ?? ''), 'err')
        } else {
          // 成功时**不再重复打印**面板地址与密码。
          //
          // 部署向导本身在结束时就会打印一次「控制面 / 数据面 / UUID / WS 路径 /
          // 面板密码」的汇总块，这里再打一遍等于同一份信息出现两次，
          // 反而让人怀疑是不是部署了两次。只补一句结束标记即可。
          log('✅ 部署完成', 'ok')
          // 部署成功后自动刷新状态：版本已同步，按钮应回到「已是最新」
          const select = $sel('kvSelect')
          await window.cfpilot.checkDeployed(select.value || undefined)
        }
      } catch (err) {
        log('部署异常：' + (err instanceof Error ? err.message : String(err)), 'err')
      } finally {
        setBusy(false)
      }
    })

    document.getElementById('btnCheck')!.addEventListener('click', async () => {
      log('检查线上部署状态…')
      const select = $sel('kvSelect')
      const btn = document.getElementById('btnCheck') as HTMLButtonElement | null
      if (btn) btn.disabled = true
      try {
        // ⚠️ 必须把返回值渲染出来
        //
        // 日志里只有一句「检查线上部署状态…」然后就没了。
        const status = (await window.cfpilot.checkDeployed(
          select.value || undefined
        )) as DeployStatusLike
        if (applyDeployStatus) {
          applyDeployStatus(status)
          log('部署状态已刷新', 'ok')
        } else {
          // 理论上不会发生（赋值在本函数执行早期完成）
          log('内部错误：状态渲染器未初始化', 'err')
        }
        // 「检查部署状态」同时接管刷新职责：本地服务、环境提示一起更新。
        //
        // ⚠️ 顺序很重要：先渲染检测结果，再刷本地信息；
        // 本地信息**不会**覆盖内核版本行（deployChecked 已记录本次结果）。
        void loadRuntimeStatus()
      } catch (err) {
        log('检查失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      } finally {
        if (btn) btn.disabled = false
      }
    })


    /**
     * 显示部署清单里保存的面板凭据（**弹窗**）。
     *
     * Cloudflare 平台上的环境变量是**加密的**（页面只显示 `****`），
     * 所以部署完成后如果没记下面板密码，用户就再也拿不回来，面板进不去。
     *
     * 这里的值从**本机部署清单**（KV 里的 CFP_DEPLOY_MANIFEST）读取，
     * 不依赖云端变量的可见性。
     *
     * 用弹窗而不是常驻面板：密码 / UUID 属于敏感信息，
     * 常驻在页面上容易被截图或旁观泄露，点开才加载、关闭即消失。
     */
    document.getElementById('btnShowCreds')?.addEventListener('click', async () => {
      const modal = document.getElementById('credModal')
      if (!modal) return

      const select = $sel('kvSelect')
      try {
        const r = await window.cfpilot.getDeployCredentials(select.value || undefined)
        if (!r || !r.ok) {
          log('读取面板凭据失败：' + ((r && r.error) || '未知错误'), 'err')
          return
        }
        const set = (id: string, v: string): void => {
          const el = document.getElementById(id)
          if (el) el.textContent = v || '—'
        }
        const prodUrl = (r.panelUrl ?? '').trim()
        const customUrl = (r.panelCustomUrl ?? '').trim()
        // 两种入口都展示：缺哪一种就在那一行写明，而不是只留一个「—」。
        set('credPanelUrl', prodUrl || '未记录生产链接')
        set('credPanelCustomUrl', customUrl || '未绑定自定义域名')
        set('credPanelPw', r.panelPassword ?? '')
        set('credUuid', r.uuid ?? '')
        set('credWsPath', r.wsPath ?? '')
        const urlHint = document.getElementById('credUrlHint')
        if (urlHint) {
          urlHint.textContent =
            !prodUrl && !customUrl
              ? '未读取到可用的面板地址，请先在「部署」页完成一次部署。'
              : !customUrl
                ? '控制面项目未绑定自定义域名；可在 Cloudflare 控制台给控制面项目绑定后再查看。'
                : !prodUrl
                  ? '未记录 Cloudflare 生产链接，请使用自定义域名访问面板。'
                  : '两个地址都能打开面板；自定义域名需在 Cloudflare 控制台绑定后才会显示。'
        }
        modal.hidden = false

        // 自动复制到剪贴板
        //
        // 用户点「查看面板凭据」几乎总是为了拿去登录面板，
        // 再点一次「复制全部」属于多余步骤。
        const text = [
          '面板地址（生产链接）：' + (prodUrl || '未记录'),
          '面板地址（自定义域名）：' + (customUrl || '未绑定'),
          '面板密码：' + (r.panelPassword ?? ''),
          'UUID：' + (r.uuid ?? ''),
          'WS 路径：' + (r.wsPath ?? ''),
        ].join('\n')
        try {
          await navigator.clipboard.writeText(text)
          log('已读取面板凭据并复制到剪贴板', 'ok')
        } catch {
          log('已读取面板凭据（剪贴板不可用，请手动复制）', 'ok')
        }
      } catch (err) {
        log('读取面板凭据失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      }
    })

    // 关闭弹窗：按钮、点遮罩、按 Esc 都可关
    const closeCredModal = (): void => {
      const modal = document.getElementById('credModal')
      if (modal) modal.hidden = true
    }
    document.getElementById('btnCredClose')?.addEventListener('click', closeCredModal)
    document.getElementById('credModal')?.addEventListener('click', (event) => {
      // 点遮罩空白处关闭（点在内容里不关）
      if (event.target === event.currentTarget) closeCredModal()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeCredModal()
    })

    // 复制全部凭据到剪贴板
    document.getElementById('btnCopyCreds')?.addEventListener('click', async () => {
      const g = (id: string): string => document.getElementById(id)?.textContent ?? ''
      const text = [
        '面板地址（生产链接）：' + g('credPanelUrl'),
        '面板地址（自定义域名）：' + g('credPanelCustomUrl'),
        '面板密码：' + g('credPanelPw'),
        'UUID：' + g('credUuid'),
        'WS 路径：' + g('credWsPath'),
      ].join('\n')
      try {
        await navigator.clipboard.writeText(text)
        log('已复制面板凭据到剪贴板', 'ok')
      } catch {
        // 剪贴板可能被拒绝（非 https / 权限），退化为选中文本
        log('复制失败，请手动选中文本复制', 'warn')
      }
    })
  }


  /** 优选页的国家目录项（后端 `/api/scan/countries` 返回） */
  interface ScanCountry {
    code: string
    name: string
    /** 大洲分组（ASIA / AMERICAS / EUROPE / OCEANIA / AFRICA / OTHER） */
    group: string
    /** 机房三字码 —— 仅用于辅助显示与搜索命中 */
    colos: string[]
  }

  /** 弹窗里的大洲分节（顺序即展示顺序） */
  const COUNTRY_GROUPS: Array<{ key: string; label: string }> = [
    { key: 'ASIA', label: '亚洲' },
    { key: 'AMERICAS', label: '美洲' },
    { key: 'EUROPE', label: '欧洲' },
    { key: 'OCEANIA', label: '大洋洲' },
    { key: 'AFRICA', label: '非洲' },
    { key: 'OTHER', label: '其他' },
  ]

  /** 国家目录（后端唯一数据源；界面不维护第二份国家表） */
  let scanCountries: ScanCountry[] = []
  /** 分组名 → 国家码（ASIA / US，由后端给出） */
  let scanCountryGroups: Record<string, string[]> = {}
  /** 自定义选择的国家码（快捷分组不写这里） */
  let customCountries: string[] = []
  /** 弹窗内待确认的选择 */
  let pendingCountries = new Set<string>()
  /** 弹窗打开前 select 的值，取消时还原 */
  let countrySelectBackup = ''

  /**
   * 读取当前的国家筛选。
   *
   * 返回空数组 = 不筛选（全量）；快捷分组返回**分组关键字**（ASIA / US），
   * 展开成国家码 / 机房码由后端负责 —— 界面不维护第二份表，
   * 也不会出现「按钮选中的机房码后端不认识」这种漂移。
   */
  /**
   * 读取地址族选择。
   *
   * 缺失 / 非法值一律回落 auto —— 后端会按本机 IPv6 环境预检决定
   * 是否让 v6 参与，用户不选也不会撞见「一半候选全超时」。
   */
  function readOptFamily(): 'auto' | 'v4' | 'v6' | 'both' {
    const el = document.getElementById('optFamily') as HTMLSelectElement | null
    const value = el?.value
    return value === 'v4' || value === 'v6' || value === 'both' ? value : 'auto'
  }

  function readOptCountries(): string[] {
    const value = ($sel('optCountryGroup').value || '').trim()
    if (!value) return []
    if (value === 'custom') return [...customCountries]
    return [value]
  }

  /** 把当前选择（含分组）展开成国家码，供弹窗勾选状态使用 */
  function currentSelectionCodes(): string[] {
    const value = ($sel('optCountryGroup').value || '').trim()
    if (!value) return []
    if (value === 'custom') return [...customCountries]
    return [...(scanCountryGroups[value] ?? [])]
  }

  /** 国家/机房是否匹配搜索词 */
  function countryMatches(c: ScanCountry, keyword: string): boolean {
    if (!keyword) return true
    const k = keyword.toLowerCase()
    return (
      c.name.toLowerCase().includes(k) ||
      c.code.toLowerCase().includes(k) ||
      c.colos.some((x) => x.toLowerCase().includes(k))
    )
  }

  function updateCountryCount(): void {
    const el = document.getElementById('countryCount')
    if (el) el.textContent = `已选 ${pendingCountries.size} 个国家`
  }

  /** 按当前搜索词重画国家列表（分节 + 复选框） */
  function renderCountryList(keyword = ''): void {
    const box = document.getElementById('countryList')
    if (!box) return
    box.innerHTML = ''

    if (scanCountries.length === 0) {
      const p = document.createElement('p')
      p.className = 'country-empty'
      p.textContent =
        '国家列表不可用。快捷分组仍然可用；自定义选择需要后端接口正常。'
      box.appendChild(p)
      updateCountryCount()
      return
    }

    let shown = 0
    for (const g of COUNTRY_GROUPS) {
      const items = scanCountries.filter(
        (c) => (c.group || 'OTHER') === g.key && countryMatches(c, keyword)
      )
      if (items.length === 0) continue

      const section = document.createElement('section')
      section.className = 'country-group'
      const title = document.createElement('h4')
      title.textContent = g.label
      section.appendChild(title)

      for (const c of items) {
        const label = document.createElement('label')
        label.className = 'country-item'

        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.value = c.code
        cb.checked = pendingCountries.has(c.code)
        cb.addEventListener('change', () => {
          if (cb.checked) pendingCountries.add(c.code)
          else pendingCountries.delete(c.code)
          updateCountryCount()
        })

        const name = document.createElement('span')
        name.textContent = c.name

        const code = document.createElement('span')
        code.className = 'code'
        code.textContent = c.code

        label.appendChild(cb)
        label.appendChild(name)
        label.appendChild(code)

        if (c.colos.length > 0) {
          const colos = document.createElement('span')
          colos.className = 'colos'
          colos.textContent = c.colos.join(' / ')
          label.appendChild(colos)
        }
        section.appendChild(label)
        shown++
      }
      box.appendChild(section)
    }

    if (shown === 0) {
      const p = document.createElement('p')
      p.className = 'country-empty'
      p.textContent = '没有匹配的国家（试试国家名、两位国家码或三位机房码）'
      box.appendChild(p)
    }
    updateCountryCount()
  }

  function openCountryModal(): void {
    const sel = $sel('optCountryGroup')
    // 从下拉里点「自定义」进来时，取消应回到「全部国家」而不是停在空的「自定义」
    countrySelectBackup = sel.value === 'custom' ? (customCountries.length > 0 ? 'custom' : '') : sel.value
    pendingCountries = new Set(currentSelectionCodes())

    const search = $('countrySearch')
    if (search) search.value = ''
    renderCountryList('')

    const mask = document.getElementById('countryModal')
    if (mask) {
      mask.hidden = false
      window.setTimeout(() => search?.focus(), 0)
    }
  }

  function closeCountryModal(): void {
    const mask = document.getElementById('countryModal')
    if (mask) mask.hidden = true
  }

  /** 取消：不改任何状态，下拉还原到打开前的值 */
  function cancelCountryModal(): void {
    const sel = $sel('optCountryGroup')
    sel.value = countrySelectBackup
    closeCountryModal()
  }

  /** 「自定义」选项按需创建：没有它时下拉里不应该出现这个空白项 */
  function ensureCustomOption(label: string): HTMLOptionElement {
    const sel = $sel('optCountryGroup')
    let opt = document.getElementById('optCountryCustomOption') as HTMLOptionElement | null
    if (!opt) {
      opt = document.createElement('option')
      opt.id = 'optCountryCustomOption'
      opt.value = 'custom'
      sel.appendChild(opt)
    }
    opt.textContent = label
    return opt
  }

  /** 移除「自定义」选项（选择被改成全量 / 恰好等于某个分组时） */
  function removeCustomOption(): void {
    document.getElementById('optCountryCustomOption')?.remove()
  }

  /** 选中的国家集合恰好等于某个分组时，返回该分组名 */
  function matchingGroup(codes: string[]): string {
    if (codes.length === 0) return ''
    const set = new Set(codes)
    for (const key of ['ASIA', 'US']) {
      const group = scanCountryGroups[key] ?? []
      if (group.length === set.size && group.every((c) => set.has(c))) return key
    }
    return ''
  }

  /** 应用：写入自定义选择；能归结到分组或全量时就用对应的快捷项 */
  function applyCountrySelection(): void {
    const sel = $sel('optCountryGroup')
    customCountries = [...pendingCountries]

    if (customCountries.length === 0) {
      // 空选择等价于「全部国家」，比留一个空的「自定义」直观
      removeCustomOption()
      sel.value = ''
      log('国家筛选：全部国家')
      closeCountryModal()
      return
    }

    const group = matchingGroup(customCountries)
    if (group) {
      // 手选的结果恰好是整组（比如弹窗里点了「亚洲组」）——
      // 直接落到快捷项上，用户下次打开也不会発现「自定义」里其实是个分组。
      removeCustomOption()
      sel.value = group
      log(`国家筛选：${sel.selectedOptions[0]?.textContent ?? group}`)
      closeCountryModal()
      return
    }

    ensureCustomOption(`自定义（${customCountries.length} 个国家）`)
    sel.value = 'custom'
    log(`国家筛选：已选 ${customCountries.length} 个国家（${customCountries.join(', ')}）`, 'ok')
    closeCountryModal()
  }

  /** 往弹窗的待选集合里加一组国家 */
  function addPendingCountries(codes: string[]): void {
    for (const code of codes) pendingCountries.add(code)
    renderCountryList($('countrySearch').value.trim())
  }

  /**
   * 国家选择器：主页面一个快捷分组下拉 + 一个「自定义配置」按钮。
   *
   * 之前是 6 行多选框，把整行拉得比旁边输入框高出一截；
   * 现在列表收进弹窗（支持搜索 / 按大洲分节 / 全选 / 分组快选）。
   *
   * 后端不可用时（旧外壳 / 接口异常）不阻断优选：快捷分组只传关键字，
   * 自定义列表为空，界面给一条 warn 日志。
   */
  async function initCountryControls(): Promise<void> {
    try {
      scanCountries = (await window.cfpilot.listScanCountries()) || []
    } catch {
      scanCountries = []
    }
    try {
      scanCountryGroups = (await window.cfpilot.listScanCountryGroups()) || {}
    } catch {
      scanCountryGroups = {}
    }

    // 后端缺字段时补齐，避免所有国家堆进一个未命名分节
    scanCountries = scanCountries.map((c) => ({
      code: c.code,
      name: c.name || c.code,
      group: c.group || 'OTHER',
      colos: Array.isArray(c.colos) ? c.colos : [],
    }))
    if (scanCountries.length === 0) {
      log('国家列表不可用：快捷分组仍可用，自定义配置为空', 'warn')
    }

    const sel = $sel('optCountryGroup')
    const mask = document.getElementById('countryModal')

    sel.addEventListener('change', () => {
      if (sel.value === 'custom') {
        openCountryModal()
        return
      }
      // 切换到全量 / 快捷分组后，上一次的自定义项不再入口，避免残留一个
      // 「自定义（8 个国家）」却又不生效的选项。需要时再点「自定义配置」。
      removeCustomOption()
      log(`国家筛选：${sel.selectedOptions[0]?.textContent ?? '全部国家'}`)
    })
    document.getElementById('btnCountryCustom')?.addEventListener('click', openCountryModal)
    document.getElementById('btnCountryModalClose')?.addEventListener('click', cancelCountryModal)
    document.getElementById('btnCountryCancel')?.addEventListener('click', cancelCountryModal)
    document.getElementById('btnCountryApply')?.addEventListener('click', applyCountrySelection)

    document.getElementById('btnCountrySelectAll')?.addEventListener('click', () => {
      pendingCountries = new Set(scanCountries.map((c) => c.code))
      renderCountryList($('countrySearch').value.trim())
    })
    document.getElementById('btnCountrySelectNone')?.addEventListener('click', () => {
      pendingCountries.clear()
      renderCountryList($('countrySearch').value.trim())
    })
    document.getElementById('btnCountrySelectAsia')?.addEventListener('click', () => {
      addPendingCountries(scanCountryGroups.ASIA ?? [])
    })
    document.getElementById('btnCountrySelectUS')?.addEventListener('click', () => {
      addPendingCountries(scanCountryGroups.US ?? ['US'])
    })

    $('countrySearch').addEventListener('input', () => {
      renderCountryList($('countrySearch').value.trim())
    })

    // 点击遮罩关闭（只认遮罩本身，避免点弹窗内容也关掉）
    mask?.addEventListener('click', (e) => {
      if (e.target === mask) cancelCountryModal()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mask && !mask.hidden) cancelCountryModal()
    })
  }

  /**
   * 把「检测网络环境」的两段结果渲染进弹窗。
   *
   * 两段分别是：
   *   1. 代理环境 —— 本机常见代理端口是否在监听（会干扰优选）
   *   2. IPv6 环境 —— 预检的地址 / 默认路由 / 活跃段金丝雀三项
   *
   * 弹窗是用户唯一能同时看懂「为什么结果会失真」与
   * 「为什么这次一个 v6 节点都没有」的地方。
   */
  function renderEnvModal(result: {
    clean?: boolean
    findings?: string[]
    ipv6?: IPv6EnvInfo | null
  }): void {
    const appendLine = (host: HTMLElement, text: string, marginTop: string): void => {
      const div = document.createElement('div')
      div.className = 'tip'
      div.style.marginTop = marginTop
      div.textContent = text
      host.appendChild(div)
    }

    const proxyList = document.getElementById('envProxyList')
    if (proxyList) {
      proxyList.innerHTML = ''
      proxyList.style.color = ''
      const findings = result.findings ?? []
      if (findings.length === 0) {
        proxyList.textContent = '（没有返回检测结果）'
      } else {
        for (const line of findings) appendLine(proxyList, '· ' + line, '4px')
        proxyList.style.color =
          result.clean === false ? 'var(--warn, #f59e0b)' : 'var(--ok, #22c55e)'
      }
    }

    const v6List = document.getElementById('envV6List')
    if (v6List) {
      v6List.innerHTML = ''
      v6List.style.color = ''
      const env = result.ipv6
      if (!env) {
        v6List.textContent = '未检测（没有可用的活跃 IPv6 前缀，或已按「仅 IPv4」跳过）'
      } else if (env.status === 'ok') {
        v6List.style.color = 'var(--ok, #22c55e)'
        appendLine(v6List, '✓ ' + (env.message || 'IPv6 环境可用'), '4px')
      } else {
        v6List.style.color = 'var(--warn, #f59e0b)'
        appendLine(v6List, '✗ ' + (env.message || '当前网络环境不具备 IPv6 测速条件'), '4px')
        for (const line of env.advice ?? []) appendLine(v6List, '· ' + line, '2px')
      }
    }

    const mask = document.getElementById('envModal')
    if (mask) mask.hidden = false
  }

  function renderScanResult(payload: {
    entries: Array<{
      ip: string
      port: number
      colo: string
      city?: string
      latency: number
      tlsMs: number
      speed: number
      tcpMs?: number
      peakSpeed?: number
    }>
    copyable: string
    sessionId?: string
    skippedSpeed?: boolean
    /** 解析后的地址族（auto 已解析成 v4 或 both） */
    family?: string
    /** IPv6 环境预检结论；未涉及 v6 时为 null */
    ipv6Env?: IPv6EnvInfo | null
    /** 本轮是否启用了自适应采样（实验性） */
    adaptive?: { enabled: boolean; profileId?: string; profileLabel?: string; exploreRate?: number }
  }): void {
    const out = $('scanOut')
    out.textContent = payload.copyable || '（没有结果）'
    // 预检没过时必须在日志里说一声：后端会静默退回纯 IPv4，
    // 不提示的话用户只会以为「怎么一个 v6 节点都没有」。
    const env = payload.ipv6Env
    if (env && env.status !== 'ok') {
      log('⚠ ' + (env.message || '当前网络环境不具备 IPv6 测速条件'), 'warn')
      for (const line of env.advice ?? []) log('   · ' + line, 'warn')
    }
    const table = document.getElementById('scanTable') as HTMLTableElement
    const tbody = table.querySelector('tbody')!
    tbody.innerHTML = ''
    payload.entries.forEach((e, i) => {
      const tr = document.createElement('tr')
      // 跳过测速时速度本就是 0，显示 — 而不是 0，避免误解成「测出来是 0」
      const speed = payload.skippedSpeed ? '—' : String(e.speed)
      // TLS 握手耗时是「导入后会不会 -1」的关键指标，放在最前面
      const tls = e.tlsMs > 0 ? String(e.tlsMs) : '—'
      // 机房列显示「SIN新加坡」——与可复制结果的备注一致
      const colo = e.colo ? e.colo + (e.city || '') : '—'
      // 「TCP(ms)」列显示真正的 TCP 建连耗时；101 握手延迟放进悬浮提示。
      // 旧记录没有 TCP 耗时，退回显示 101 延迟并说明。
      const hasTcp = typeof e.tcpMs === 'number' && e.tcpMs > 0
      const tcpText = hasTcp ? String(e.tcpMs) : String(e.latency)
      const cells = [String(i + 1), e.ip + ':' + e.port, colo, tls, tcpText, speed]
      for (const c of cells) {
        const td = document.createElement('td')
        td.textContent = c
        tr.appendChild(td)
      }
      const tcpCell = tr.querySelectorAll('td')[4]
      if (tcpCell) {
        tcpCell.title = hasTcp
          ? `TCP 建连 ${e.tcpMs} ms · 101 握手 ${e.latency} ms`
          : `未记录 TCP 建连耗时（旧数据），此处为 101 握手延迟 ${e.latency} ms`
      }
      const reportCell = document.createElement('td')
      const reportButton = document.createElement('button')
      reportButton.type = 'button'
      reportButton.className = 'btn btn-ghost'
      reportButton.textContent = '质量检测'
      reportButton.title = '把这条 IP 能跑的检测都跑一遍（分层复测 + IP 纯净度），结果写回优选历史'
      reportButton.setAttribute('aria-expanded', 'false')
      reportButton.disabled = !payload.sessionId
      reportCell.appendChild(reportButton)
      tr.appendChild(reportCell)
      tbody.appendChild(tr)

      // 报告展开行（默认收起）—— 与「优选历史」同一种模式：
      // 点按钮在表格下方展开独立一行显示完整报告，再点收起。
      // 早前直接画在「质量报告」这一列里，列宽只有按钮那么宽，
      // 报告内容被挤成一条竖线，根本读不了。
      const reportRow = document.createElement('tr')
      reportRow.hidden = true
      const reportDetail = document.createElement('td')
      reportDetail.colSpan = 7
      reportDetail.style.whiteSpace = 'normal'
      reportRow.appendChild(reportDetail)
      tbody.appendChild(reportRow)
      let reportLoaded = false
      reportButton.addEventListener('click', async () => {
        reportRow.hidden = !reportRow.hidden
        reportButton.setAttribute('aria-expanded', String(!reportRow.hidden))
        if (reportRow.hidden || reportLoaded || !payload.sessionId) return
        reportDetail.textContent = '正在检测（分层复测 + IP 纯净度，约 15~40 秒）…'
        reportButton.disabled = true
        try {
          // 质量检测：后端把能跑的检查都跑一遍并写回优选历史，
          // 返回的已是重建后的完整报告（不再是「大半未执行」）。
          const result = await window.cfpilot.runQualityCheck({
            sessionId: payload.sessionId,
            ip: e.ip,
            port: e.port,
          })
          if (!result.ok || !result.report) {
            reportDetail.textContent = result.error || '检测不可用'
            return
          }
          reportLoaded = true
          renderIPQualityReport(reportDetail, result.report)
        } catch (error) {
          reportDetail.textContent = error instanceof Error ? error.message : String(error)
        } finally {
          reportButton.disabled = false
        }
      })
    })
    table.hidden = payload.entries.length === 0

    // 表头也标明速度列是否有效
    const speedHead = table.querySelectorAll('th')[5]
    if (speedHead) speedHead.textContent = payload.skippedSpeed ? '下行(已跳过)' : '下行(MB/s)'

    //
    // 回填改为结果出来后手动触发，所以这里要把可复制格式保存下来，
    // 供按钮点击时使用。
    lastScanLines = (payload.copyable || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    const canPush = lastScanLines.length > 0
    for (const id of ['btnPushAppend', 'btnPushReplace']) {
      const btn = document.getElementById(id) as HTMLButtonElement | null
      if (btn) btn.disabled = !canPush
    }
    const pushHint = document.getElementById('pushHint')
    if (pushHint) {
      pushHint.textContent = canPush
        ? '上方是本次结果。要让订阅用上这些 IP，点「增量回填」（保留原有）或「覆盖回填」（清空后写入）。'
        : ''
    }

    // 本轮是否用了自适应采样（实验性）：写清楚，用户才知道这批结果是怎么采出来的。
    const note = document.getElementById('scanAdaptiveNote')
    if (note) {
      const adaptive = payload.adaptive
      if (adaptive && adaptive.enabled) {
        note.hidden = false
        note.textContent =
          '本轮启用了自适应采样（档案：' +
          (adaptive.profileLabel || adaptive.profileId || '未命名') +
          '，探索比例 ' +
          Math.round((adaptive.exploreRate || 0) * 100) +
          '%）。本次观测已写回该档案，下一轮会据此调整网段权重。'
      } else {
        note.hidden = true
        note.textContent = ''
      }
    }
  }

  /**
   * 进度条只属于「一次优选」，不属于页面上的其它按钮。
   *
   * ⚠️ 日志流是全局的：部署、取令牌、反代体检都往同一个 log 事件里写。
   * 早前 updateScanProgress 只判断日志文案里有没有「阶段 / 扫描」，于是点
   * 「增量回填 / 覆盖回填」时，第一步取令牌推回来的
   * 「✅ 已自动获取扫描令牌（有效期 10 分钟）」也会命中「扫描」——
   * 这条日志没有（n/m）计数，兜底 local=0.05、stage=处理中，算出 1%，
   * 把上一次优选刚收尾好的 100% 冲掉。用户看到的就是「回填时冒出 1% 进度条」。
   *
   * 因此只有「点开始优选 → 收到 scan-result」这段时间内，日志才可以驱动进度条；
   * 其余时间日志只进日志框，不碰进度条。
   */
  let scanProgressActive = false
  /** 本次优选已显示过的最大百分比：乱序或无计数的日志不该把进度条拉回去 */
  let scanProgressPct = 0

  /**
   * 总进度条：贴着结果框下边框，一条贯穿全程。
   *
   * 百分比按**阶段加权**映射（连通性 0–25%、协议验证 25–55%、测速 55–95%），
   * 否则用户看到的是「第一阶段就 100%」的假进度。
   */
  function updateScanProgress(message: string): void {
    if (!scanProgressActive) return
    const wrap = document.getElementById('scanProgressWrap')
    const bar = document.getElementById('scanProgressBar')
    const stageEl = document.getElementById('scanProgressStage')
    const textEl = document.getElementById('scanProgressText')
    if (!wrap || !bar) return
    const match = /（(\d+)\/(\d+)）/.exec(message)
    // 两轮测速多出「全量粗筛」这一档，插在协议验证与精测之间（45–55%）。
    // 文案含「粗筛」但不带「阶段三 / 测速」，所以必须放在最前面判断。
    const stage = message.includes('粗筛') ? '全量粗筛'
      : message.includes('阶段一') || message.includes('TCP') ? '连通性'
      : message.includes('阶段二') || message.includes('TLS') || message.includes('101') ? '协议验证'
      : message.includes('阶段三') || message.includes('测速') ? '性能测速'
      : '处理中'
    const local = match && Number(match[2]) > 0 ? Math.max(0, Math.min(1, Number(match[1]) / Number(match[2]))) : 0.05
    const base = stage === '连通性' ? 0 : stage === '协议验证' ? 25 : stage === '全量粗筛' ? 45 : stage === '性能测速' ? 55 : 0
    const span = stage === '连通性' ? 25 : stage === '协议验证' ? 20 : stage === '全量粗筛' ? 10 : stage === '性能测速' ? 40 : 5
    const pct = Math.max(1, Math.min(99, Math.round(base + local * span)))
    // 单调不减：日志到达顺序不严格按阶段，且不少日志没有（n/m）计数，
    // 早前一条「阶段三：…」就能把已经跑到 90% 的条子拉回 57%。
    scanProgressPct = Math.max(scanProgressPct, pct)
    wrap.hidden = false
    bar.style.width = scanProgressPct + '%'
    if (stageEl) stageEl.textContent = `${stage} · 总进度 ${scanProgressPct}%`
    // 按钮行只放阶段数字进度，进度条不再挤在这里。
    if (textEl) textEl.textContent = match ? `${stage} ${match[1]}/${match[2]}` : stage
  }

  function finishScanProgress(ok: boolean): void {
    // 收尾即关闭门控：之后取令牌 / 回填 / 部署等日志都不再改动进度条。
    scanProgressActive = false
    scanProgressPct = ok ? 100 : 0
    const wrap = document.getElementById('scanProgressWrap')
    const bar = document.getElementById('scanProgressBar')
    const stageEl = document.getElementById('scanProgressStage')
    const textEl = document.getElementById('scanProgressText')
    if (!wrap || !bar) return
    wrap.hidden = false
    bar.style.width = ok ? '100%' : '0%'
    if (stageEl) stageEl.textContent = ok ? '优选完成' : '优选未完成'
    if (textEl) textEl.textContent = ok ? '已完成' : '未完成'
  }

  /**
   * 实验性功能开关（默认全部关闭）。
   *
   * 只在用户显式保存后才生效；读取失败时保持界面原样，
   * 绝不让实验能力影响默认优选。
   */
  function bindExperimental(): void {
    const saveBtn = document.getElementById('btnExpSave') as HTMLButtonElement | null
    const hint = document.getElementById('expHint')

    const fill = (settings: ExperimentalSettings): void => {
      const adaptive = document.getElementById('optAdaptive') as HTMLInputElement | null
      const isp = document.getElementById('optExpIsp') as HTMLSelectElement | null
      const region = document.getElementById('optExpRegion') as HTMLInputElement | null
      const access = document.getElementById('optExpAccess') as HTMLSelectElement | null
      const explore = document.getElementById('optExpExplore') as HTMLInputElement | null
      if (adaptive) adaptive.checked = settings.adaptiveSampling
      if (isp) isp.value = settings.isp || 'other'
      if (region) region.value = settings.region || ''
      if (access) access.value = settings.access || 'fixed'
      if (explore) explore.value = String(Math.round((settings.exploreRatio || 0.2) * 100))
    }

    /** 渲染「当前档案状态」：档案名、样本量、能不能用。 */
    const renderProfileStatus = (profile?: ExperimentalProfileStatus, profiles?: ExperimentalProfileStatus[]): void => {
      const box = document.getElementById('expStatus')
      if (!box) return
      box.replaceChildren()
      if (!profile || !profile.id) {
        const line = document.createElement('div')
        line.className = 'muted'
        if (profiles && profiles.length > 0) {
          // 档案存在但开关没开 —— 要说清是「没启用」，不是「没有档案」
          line.textContent =
            '自适应采样当前未启用（本机已有 ' + profiles.length + ' 个档案）。打开开关并保存后，下一轮优选开始按档案调整网段权重。'
        } else {
          line.textContent = '尚未建立网络档案：打开「自适应网段权重」并保存后开始优选，这里会显示学习到的样本。'
        }
        box.appendChild(line)
        return
      }
      const title = document.createElement('div')
      title.className = 't-title'
      title.textContent = '当前档案：' + profile.label
      box.appendChild(title)

      const stages = profile.stages || {}
      const parts: string[] = []
      for (const [stage, stat] of Object.entries(stages)) {
        if (!stat || stat.attempts <= 0) continue
        parts.push(stage + ' ' + stat.successes + '/' + stat.attempts)
      }
      const meta = document.createElement('div')
      meta.className = 'muted'
      meta.textContent =
        '样本：' + (parts.length ? parts.join(' · ') : '暂无') +
        ' · 覆盖网段 ' + profile.prefixCount +
        (profile.lastUpdated ? ' · 最近更新 ' + fmtHistoryTime(profile.lastUpdated) : '')
      box.appendChild(meta)

      const notice = document.createElement('div')
      notice.className = profile.enoughSamples ? 't-ok' : 't-warn'
      notice.textContent = profile.notice
      box.appendChild(notice)
    }

    /** 渲染档案列表（管理：删除 / 修正地区）。 */
    const renderProfileList = (profiles: ExperimentalProfileStatus[]): void => {
      const wrap = document.getElementById('expProfiles')
      const list = document.getElementById('expProfileList')
      if (!wrap || !list) return
      wrap.hidden = profiles.length === 0
      list.replaceChildren()
      for (const profile of profiles) {
        const row = document.createElement('div')
        row.className = 'exp-profile'
        const name = document.createElement('span')
        name.className = 'p-name'
        name.textContent = profile.label
        const meta = document.createElement('span')
        meta.className = 'p-meta'
        const stages = profile.stages || {}
        let attempts = 0
        for (const stat of Object.values(stages)) attempts += stat?.attempts || 0
        meta.textContent = '样本 ' + Math.round(attempts) + ' · 网段 ' + profile.prefixCount
        row.appendChild(name)
        row.appendChild(meta)
        if (profile.current) {
          const cur = document.createElement('span')
          cur.className = 'p-cur'
          cur.textContent = '当前'
          row.appendChild(cur)
        }
        const fix = document.createElement('button')
        fix.type = 'button'
        fix.className = 'btn btn-ghost'
        fix.textContent = '修正地区'
        fix.addEventListener('click', () => {
          const next = window.prompt('修改地区（留空表示不区分地区）', profile.region || '')
          if (next === null) return
          void window.cfpilot
            .renameExperimentalProfile({
              id: profile.id,
              isp: profile.isp,
              region: next.trim(),
              access: profile.access,
            })
            .then(() => {
              log('档案已更新', 'ok')
              void refreshProfiles()
            })
            .catch((err) => log('修改档案失败：' + (err instanceof Error ? err.message : String(err)), 'err'))
        })
        row.appendChild(fix)
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'btn btn-ghost'
        del.textContent = '删除'
        del.addEventListener('click', () => {
          if (!window.confirm('删除档案「' + profile.label + '」及其全部观测样本？')) return
          void window.cfpilot
            .deleteExperimentalProfile(profile.id)
            .then(() => {
              log('档案已删除', 'ok')
              void refreshProfiles()
            })
            .catch((err) => log('删除档案失败：' + (err instanceof Error ? err.message : String(err)), 'err'))
        })
        row.appendChild(del)
        list.appendChild(row)
      }
    }

    /** 重新读取档案状态与列表。 */
    const refreshProfiles = async (): Promise<void> => {
      try {
        const res = await window.cfpilot.getExperimental()
        if (res && res.ok) {
          renderProfileStatus(res.profile, res.profiles)
          renderProfileList(res.profiles || [])
        }
      } catch {
        /* 读不到就不显示状态，不影响其它功能 */
      }
    }

    void window.cfpilot
      .getExperimental()
      .then((res) => {
        if (res && res.ok && res.experimental) fill(res.experimental)
        renderProfileStatus(res?.profile, res?.profiles)
        renderProfileList(res?.profiles || [])
      })
      .catch(() => {
        /* 读不到开关时保持界面默认（关闭）即可 */
      })

    saveBtn?.addEventListener('click', async () => {
      const adaptive = document.getElementById('optAdaptive') as HTMLInputElement | null
      const isp = document.getElementById('optExpIsp') as HTMLSelectElement | null
      const region = document.getElementById('optExpRegion') as HTMLInputElement | null
      const access = document.getElementById('optExpAccess') as HTMLSelectElement | null
      const explore = document.getElementById('optExpExplore') as HTMLInputElement | null
      const ratio = Math.max(5, Math.min(100, Number(explore?.value) || 20)) / 100
      const payload: ExperimentalSettings = {
        adaptiveSampling: Boolean(adaptive?.checked),
        exploreRatio: ratio,
        isp: isp?.value || 'other',
        region: (region?.value || '').trim(),
        access: access?.value || 'fixed',
      }
      if (hint) hint.textContent = '保存中…'
      const res = await window.cfpilot.saveExperimental(payload)
      if (hint) {
        hint.textContent = res && res.ok ? '已保存（下次优选生效）' : res?.error || '保存失败'
      }
      if (res && res.ok && res.experimental) fill(res.experimental)
      void refreshProfiles()
    })
  }

  /**
   * 自适应效果 A/B 对照面板。
   *
   * 跨省样本拿不到，但同网络环境下「开 / 关」各跑一轮就能对照：
   * 阶段通过率与最终可用节点数是唯一能自证收益的指标。
   */
  function bindAdaptiveEffect(): void {
    const box = document.getElementById('adaptiveEffect')
    const hint = document.getElementById('effectHint')
    const refresh = document.getElementById('btnEffectRefresh')

    const pct = (value: number): string => (value * 100).toFixed(1) + '%'

    const load = async (): Promise<void> => {
      if (!box) return
      try {
        const res = await window.cfpilot.getAdaptiveEffect()
        if (!res || !res.ok) {
          box.replaceChildren()
          const line = document.createElement('p')
          line.className = 'history-empty'
          line.textContent = res?.error || '暂时无法读取对照数据'
          box.appendChild(line)
          return
        }
        const enabled = res.enabled
        const disabled = res.disabled
        box.replaceChildren()
        if (!enabled || !disabled || (enabled.runs === 0 && disabled.runs === 0)) {
          const line = document.createElement('p')
          line.className = 'history-empty'
          line.textContent = '还没有可对照的记录：开启与关闭自适应各跑一轮优选后，这里会给出分阶段通过率对比。'
          box.appendChild(line)
        } else {
          const table = document.createElement('table')
          table.className = 'effect-table'
          const rows: string[] = []
          rows.push(
            '<tr><th>指标</th><th>开启自适应</th><th>关闭自适应</th></tr>',
            '<tr><td>轮数</td><td>' + enabled.runs + '</td><td>' + disabled.runs + '</td></tr>',
            '<tr><td>平均候选</td><td>' + enabled.avgCandidates.toFixed(0) + '</td><td>' + disabled.avgCandidates.toFixed(0) + '</td></tr>',
            '<tr><td>阶段一通过率</td><td>' + pct(enabled.tcpRate) + '</td><td>' + pct(disabled.tcpRate) + '</td></tr>',
            '<tr><td>阶段二通过率</td><td>' + pct(enabled.wsRate) + '</td><td>' + pct(disabled.wsRate) + '</td></tr>',
            '<tr><td>平均可用节点</td><td>' + enabled.avgNodes.toFixed(1) + '</td><td>' + disabled.avgNodes.toFixed(1) + '</td></tr>',
            '<tr><td>平均耗时</td><td>' + Math.round(enabled.avgElapsedMs / 1000) + ' 秒</td><td>' + Math.round(disabled.avgElapsedMs / 1000) + ' 秒</td></tr>'
          )
          table.innerHTML = rows.join('')
          box.appendChild(table)
          if (res.profile) {
            const line = document.createElement('p')
            line.className = 'tip'
            line.style.marginTop = '8px'
            line.textContent = '档案：' + res.profile
            box.appendChild(line)
          }
        }
        if (hint) hint.textContent = res.notice || ''
      } catch (err) {
        if (box) {
          box.replaceChildren()
          const line = document.createElement('p')
          line.className = 'history-empty'
          line.textContent = '读取失败：' + (err instanceof Error ? err.message : String(err))
          box.appendChild(line)
        }
      }
    }

    refresh?.addEventListener('click', () => void load())
    void load()
  }

  /**
   * 「用量 / 额度」弹窗。
   *
   * ## 数据从哪来
   *
   * 后端在**检测账号 / 切换账户**时已经在后台采集过一次，
   * 所以打开弹窗只读缓存（不花 API 调用），点「刷新」才真正重新采集。
   *
   * ## 图表怎么画
   *
   * 全部用 SVG 手绘（界面零依赖，不引图表库）：
   *   - 日额度总览 → 横向条形（长度=占用比例，颜色随比例变化）
   *   - 7 天趋势   → 折线 + 上限参考线
   */
  function bindUsage(): void {
    const modal = document.getElementById('usageModal')
    const notice = document.getElementById('usageNotice')
    const loading = document.getElementById('usageLoading')
    const grid = document.getElementById('usageGrid')
    const openBtn = document.getElementById('btnUsage')
    const closeBtn = document.getElementById('btnUsageClose')
    const refreshBtn = document.getElementById('btnUsageRefresh')

    const close = (): void => {
      if (modal) modal.hidden = true
      hideTip()
    }

    // ---- 悬浮气泡（折线图数据点 + 文字说明共用） ----
    const tip = document.createElement('div')
    tip.className = 'usage-tip'
    tip.hidden = true
    document.body.appendChild(tip)

    const showTip = (text: string, event: MouseEvent): void => {
      tip.textContent = text
      tip.hidden = false
      const pad = 12
      const rect = tip.getBoundingClientRect()
      let x = event.clientX + pad
      let y = event.clientY + pad
      if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad
      if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad
      tip.style.left = Math.max(8, x) + 'px'
      tip.style.top = Math.max(8, y) + 'px'
    }
    const hideTip = (): void => {
      tip.hidden = true
    }

    /**
     * 画折线图。
     *
     * ## 为什么 Y 轴不按上限缩放
     *
     * 按上限缩放会把曲线压成一条直线（用量几千、上限十万 → 全贴在底部，
     * 完全看不出趋势）。所以这里**按数据自身最大值缩放**，
     * 上限只在「用量已经接近上限」（≥30%）时画成参考线，
     * 否则改成图下一行文字说明 —— 既能看趋势，也不丢上限信息。
     */
    const drawLine = (
      svg: SVGSVGElement | null,
      values: number[],
      labels: string[],
      cap: number,
      color: string,
      capNoteId: string,
      unit: string
    ): void => {
      if (!svg) return
      const w = 320
      const h = Number(svg.getAttribute('viewBox')?.split(' ')[3] ?? 140)
      const padL = 34
      const padR = 6
      const padT = 8
      const padB = 18
      const innerW = w - padL - padR
      const innerH = h - padT - padB
      const dataMax = Math.max(...values, 1)
      const showCap = cap > 0 && dataMax >= cap * 0.3
      const max = showCap ? Math.max(cap, dataMax) : dataMax * 1.15
      const x = (index: number): number =>
        padL + (values.length <= 1 ? innerW / 2 : (innerW * index) / (values.length - 1))
      const y = (value: number): number => padT + innerH - (innerH * value) / max
      const parts: string[] = []
      for (let step = 0; step <= 2; step++) {
        const value = (max * step) / 2
        const gy = y(value)
        parts.push(`<line x1="${padL}" y1="${gy}" x2="${w - padR}" y2="${gy}" stroke="var(--border)" stroke-width="1"/>`)
        parts.push(
          `<text x="${padL - 4}" y="${gy + 3}" font-size="8" fill="var(--text-muted)" text-anchor="end">${formatUsageNumber(value)}</text>`
        )
      }
      if (showCap) {
        parts.push(
          `<line x1="${padL}" y1="${y(cap)}" x2="${w - padR}" y2="${y(cap)}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 3"/>`
        )
      }
      const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      parts.push(`<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${points.join(' ')}"/>`)
      values.forEach((value, index) => {
        parts.push(`<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2.6" fill="${color}"/>`)
      })
      if (labels.length > 0) {
        parts.push(
          `<text x="${padL}" y="${h - 5}" font-size="8" fill="var(--text-muted)">${labels[0] ?? ''}</text>`
        )
        const last = labels[labels.length - 1] ?? ''
        parts.push(
          `<text x="${w - padR}" y="${h - 5}" font-size="8" fill="var(--text-muted)" text-anchor="end">${last}</text>`
        )
      }
      svg.innerHTML = parts.join('')
      // 上限说明：没画参考线时（用量远低于上限）用文字补一句，别让上限凭空消失。
      const note = document.getElementById(capNoteId)
      if (note) {
        note.textContent =
          cap > 0 && !showCap ? `日上限 ${formatUsageNumber(cap)}，远高于当前用量` : ''
      }

      // ---- 悬浮气泡：显示日期与用量 ----
      const hit = (event: MouseEvent): void => {
        const box = svg.getBoundingClientRect()
        const ratio = (event.clientX - box.left) / box.width
        const index = Math.round(ratio * (values.length - 1))
        if (index < 0 || index >= values.length) {
          hideTip()
          return
        }
        const day = labels[index] ?? ''
        const lines = [`${day}　${formatUsageNumber(values[index]!)} ${unit}`]
        if (cap > 0) {
          const percent = cap > 0 ? (values[index]! / cap) * 100 : 0
          lines.push(`占日上限 ${percent.toFixed(1)}%`)
        }
        showTip(lines.join('\n'), event)
      }
      svg.onmousemove = hit
      svg.onmouseleave = hideTip
    }

    const render = (snapshot: UsageSnapshot): void => {
      const limits = snapshot.limits
      const today = snapshot.today
      const pct = (used: number, cap: number): number => (cap > 0 ? (used / cap) * 100 : 0)

      // ---- 1) 日额度总览（横向条形） ----
      const bars = document.getElementById('usageBars')
      if (bars) {
        bars.replaceChildren()
        const rows: Array<{ label: string; used: number; cap: number; unlimited: boolean }> = [
          { label: 'Workers 请求', used: today.workersRequests, cap: limits.workersRequests, unlimited: limits.unlimitedWorkers },
          { label: 'KV 读', used: today.kvReads, cap: limits.kvReads, unlimited: limits.unlimitedKvOps },
          { label: 'KV 写', used: today.kvWrites, cap: limits.kvWrites, unlimited: limits.unlimitedKvOps },
          {
            label: 'KV 存储',
            used: snapshot.storage.bytes,
            cap: limits.kvStorageBytes,
            unlimited: limits.unlimitedKvStorage,
          },
        ]
        for (const row of rows) {
          const ratio = pct(row.used, row.cap)
          const level = ratio >= 80 ? 'danger' : ratio >= 50 ? 'warn' : ''
          const line = document.createElement('div')
          line.className = 'usage-bar-row'
          const name = document.createElement('span')
          name.textContent = row.label
          const track = document.createElement('span')
          track.className = 'usage-bar-track'
          const fill = document.createElement('i')
          fill.className = 'usage-bar-fill ' + level
          fill.style.width = Math.max(1, Math.min(100, ratio)) + '%'
          track.appendChild(fill)
          const num = document.createElement('span')
          num.className = 'usage-num'
          num.textContent = row.unlimited
            ? formatUsageNumber(row.used)
            : `${formatUsageNumber(row.used)} / ${formatUsageNumber(row.cap)}`
          const percent = document.createElement('span')
          percent.className = 'usage-pct ' + level
          percent.textContent = row.unlimited ? '—' : ratio.toFixed(1) + '%'
          line.appendChild(name)
          line.appendChild(track)
          line.appendChild(num)
          line.appendChild(percent)
          bars.appendChild(line)
        }
      }

      // ---- 2) Workers 请求 7 天 ----
      const days = snapshot.days ?? []
      const labels = days.map((d) => d.slice(5))
      drawLine(
        document.getElementById('usageChartWorkers') as SVGSVGElement | null,
        (snapshot.series ?? []).map((p) => p.workersRequests),
        labels,
        limits.unlimitedWorkers ? 0 : limits.workersRequests,
        'var(--accent)',
        'usageCapWorkers',
        '次请求'
      )
      // ---- 3) KV 读 / 写 7 天 ----
      drawLine(
        document.getElementById('usageChartKvRead') as SVGSVGElement | null,
        (snapshot.series ?? []).map((p) => p.kvReads),
        labels,
        limits.unlimitedKvOps ? 0 : limits.kvReads,
        'var(--accent)',
        'usageCapKvRead',
        '次读'
      )
      drawLine(
        document.getElementById('usageChartKvWrite') as SVGSVGElement | null,
        (snapshot.series ?? []).map((p) => p.kvWrites),
        labels,
        limits.unlimitedKvOps ? 0 : limits.kvWrites,
        'var(--ok)',
        'usageCapKvWrite',
        '次写'
      )

      // ---- 4) 其它额度（文字） ----
      const facts = document.getElementById('usageFacts')
      if (facts) {
        facts.replaceChildren()
        const rate = snapshot.ratelimit
        const status = snapshot.statusCounts ?? {}
        const over = status.exceededResources ?? 0
        const shed = status.loadShed ?? 0
        const rows: Array<[string, string, string]> = [
          ['套餐', limits.planName || (limits.plan === 'paid' ? 'Paid' : 'Free'), ''],
          [
            'KV 存储',
            `${formatUsageBytes(snapshot.storage.bytes)} / ${limits.unlimitedKvStorage ? '无限制' : formatUsageBytes(limits.kvStorageBytes)}（${snapshot.storage.keyCount} 个键）`,
            '',
          ],
          [
            'API 调用速率',
            rate.remoteLimit > 0
              ? `官方剩余 ${rate.remoteRemaining}/${rate.remoteLimit}（${rate.remoteWindowSec} 秒窗口）`
              : '未取到官方速率信息',
            '',
          ],
          [
            '本地调用风控',
            rate.localBlocked
              ? `已达上限，已停止调用（每 ${Math.round(rate.localWindowSec / 60)} 分钟最多 ${rate.localLimit} 次）`
              : `剩余 ${rate.localRemaining}/${rate.localLimit}（每 ${Math.round(rate.localWindowSec / 60)} 分钟）`,
            rate.localBlocked ? 'err' : '',
          ],
          [
            '本地 KV 写风控',
            snapshot.dailyWriteLimit
              ? `今日已用 ${snapshot.dailyWriteUsed ?? 0}/${snapshot.dailyWriteLimit} 次（官方上限的十分之一）`
              : '未启用',
            snapshot.dailyWriteLimit && (snapshot.dailyWriteUsed ?? 0) >= snapshot.dailyWriteLimit ? 'err' : '',
          ],
          [
            '资源超限次数',
            `${over} 次${over > 0 ? '（Worker 触到 CPU/内存上限）' : ''}`,
            over > 0 ? 'warn' : '',
          ],
          ['平台卸载次数', `${shed} 次${shed > 0 ? '（负载偏高被卸载）' : ''}`, shed > 0 ? 'warn' : ''],
        ]
        const scripts = snapshot.scripts ?? []
        if (scripts.length > 0) {
          rows.push([
            '消耗排行',
            scripts
              .slice(0, 3)
              .map((s) => `${s.name}${s.cfpilot ? '（本工具）' : ''} ${formatUsageNumber(s.requests)}`)
              .join('，'),
            '',
          ])
        }
        // 实例清单：说清楚哪些是本工具的、哪些形态不计入统计。
        const instances = snapshot.instances ?? []
        const mine = instances.filter((i) => i.cfpilot)
        if (mine.length > 0) {
          rows.push([
            '本工具实例',
            mine.map((i) => `${i.name}（${i.kind === 'pages' ? 'Pages' : 'Worker'}）`).join('，'),
            '',
          ])
        }
        if (snapshot.cfpilotWorkerRequests) {
          rows.push([
            '本工具请求',
            `${formatUsageNumber(snapshot.cfpilotWorkerRequests)} 次（Worker 形态）`,
            '',
          ])
        }
        for (const [key, value, level] of rows) {
          const k = document.createElement('span')
          k.className = 'k'
          k.textContent = key
          const v = document.createElement('span')
          v.className = 'v ' + level
          v.textContent = value
          // 「资源超限」悬浮显示每个 Worker 的次数；「平台卸载」解释概念
          if (key === '资源超限次数') {
            v.classList.add('tipable')
            v.onmousemove = (event: MouseEvent) => {
              const byScript = snapshot.statusByScript ?? {}
              const lines: string[] = []
              for (const [script, statuses] of Object.entries(byScript)) {
                const count = statuses.exceededResources ?? 0
                if (count > 0) lines.push(`${script}：${count} 次`)
              }
              showTip(
                (lines.length
                  ? '各 Worker 的资源超限次数：\n' + lines.join('\n')
                  : '没有 Worker 触到资源上限。') +
                  '\n\n注意：这是**账号下所有 Worker** 的合计，\n不一定是本工具的实例（Pages 形态不计入此表）。',
                event
              )
            }
            v.onmouseleave = hideTip
          }
          if (key === '平台卸载次数') {
            v.classList.add('tipable')
            v.onmousemove = (event: MouseEvent) =>
              showTip(
                '平台卸载（loadShed）：Cloudflare 主动把请求挡在 Worker 外面。\n' +
                  '常见于账号下某个 Worker 瞬时负载过高、或请求量突增。\n' +
                  '被卸载的请求不会进入 Worker（不计入 Worker 的 CPU），\n' +
                  '但客户端会拿到错误响应 —— 表现为「偶发连不上」。',
                event
              )
            v.onmouseleave = hideTip
          }
          facts.appendChild(k)
          facts.appendChild(v)
        }
      }

      // ---- 5) 注意事项 ----
      const tips = document.getElementById('usageTips')
      if (tips) {
        tips.replaceChildren()
        const items: string[] = [
          'KV 写配额最紧张（Free 每天 1000 次写）：部署与回填尽量别在同一天反复操作。',
          'Workers 请求按 UTC 0 点重置，看趋势请以「自然日」为准。',
          '「资源超限」出现说明 Worker 触到了 CPU / 内存上限（Free 单请求 10ms CPU）—— 面板接口要留 CPU 预算。',
          `用量查询是只读的，不消耗产品额度；只会占用 API 调用速率（本地每 ${Math.round((snapshot.ratelimit.localWindowSec || 300) / 60)} 分钟最多 ${snapshot.ratelimit.localLimit || 120} 次，达到即停止刷新）。`,
        ]
        const candidates: Array<[string, number]> = [
          ['Workers 请求', pct(today.workersRequests, limits.workersRequests)],
          ['KV 读', pct(today.kvReads, limits.kvReads)],
          ['KV 写', pct(today.kvWrites, limits.kvWrites)],
        ]
        const worst = candidates.sort((a, b) => b[1] - a[1])[0]
        if (worst && worst[1] >= 50) {
          items.unshift(`当前占用最高的是「${worst[0]}」，已达日上限的 ${worst[1].toFixed(1)}%。`)
        }
        if (snapshot.throttled) {
          items.unshift('本地调用风控已触发，已停止向 Cloudflare 发起请求。')
        }
        for (const text of items) {
          const li = document.createElement('li')
          li.textContent = text
          tips.appendChild(li)
        }
      }

      if (notice) {
        const parts: string[] = []
        if (snapshot.scopeNote) parts.push(snapshot.scopeNote)
        if (snapshot.notice) parts.push(snapshot.notice)
        if (snapshot.generatedAt) {
          parts.push('采集于 ' + snapshot.generatedAt.replace('T', ' ').replace('Z', ' UTC'))
        }
        notice.textContent = parts.join(' · ') || '用量数据已就绪'
      }
    }

    const load = async (refresh: boolean): Promise<void> => {
      if (notice) notice.textContent = refresh ? '正在重新采集…' : '读取中…'
      // 采集期间显示加载态：后台可能正在向 Cloudflare 请求，
      // 别让用户对着旧数据以为"点了没反应"。
      if (loading) loading.hidden = false
      if (grid) grid.hidden = true
      try {
        const res = await window.cfpilot.getUsage(refresh)
        if (!res || !res.ok || !res.usage) {
          if (notice) notice.textContent = res?.error || '暂时无法读取用量数据'
          if (loading) loading.hidden = true
          if (grid) grid.hidden = false
          return
        }
        render(res.usage)
        if (loading) loading.hidden = true
        if (grid) grid.hidden = false
      } catch (err) {
        if (notice) {
          notice.textContent = '读取失败：' + (err instanceof Error ? err.message : String(err))
        }
        if (loading) loading.hidden = true
        if (grid) grid.hidden = false
      }
    }

    openBtn?.addEventListener('click', () => {
      if (modal) modal.hidden = false
      void load(false)
    })
    closeBtn?.addEventListener('click', close)
    refreshBtn?.addEventListener('click', () => void load(true))
    modal?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal && !modal.hidden) close()
    })
  }

  /** 把大数字压成易读的短格式（1.2 万 / 3.4 亿）。 */
  function formatUsageNumber(value: number): string {
    const n = Number(value) || 0
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + ' 万'
    return String(Math.round(n))
  }

  /** 把字节数压成易读的短格式。 */
  function formatUsageBytes(value: number): string {
    const n = Number(value) || 0
    if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB'
    if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + ' MB'
    if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
    return n + ' B'
  }

  /* ------------------------------------------------------------------ */
  /* 定时优选任务                                                        */
  /* ------------------------------------------------------------------ */

  /** 定时任务清单（后端返回的原始结构） */
  let scheduledTasks: ScheduledTask[] = []
  /** 勾选的任务 ID */
  let scheduledChecked = new Set<string>()
  /** 本地优选 IP 池 */
  let scheduledPool: ScheduledPoolEntry[] = []
  /** 勾选的池内 IP（按 IP 去重键） */
  let poolChecked = new Set<string>()
  /** 编辑弹窗的上下文：'create' = 新建，'edit' = 编辑某一条任务 */
  let taskModalMode: 'create' | 'edit' = 'create'
  /** 'edit' 模式下正在编辑的任务 id（编辑只针对单条） */
  let taskEditId: string | null = null
  /** 新建任务时从优选表单抓下来的优选参数快照 */
  let taskDraftScan: ScheduledScanParams | null = null
  /** 编辑弹窗打开时的原始值（用来判断哪些字段被改过） */
  let taskModalOrigin: Record<string, string> = {}

  /** 读当前优选表单的优选参数（与 runScan 的 payload 同源，避免两处读法漂移）。 */
  function currentScanParams(): ScheduledScanParams {
    const probeInput = $('optProbePath').value.trim()
    return {
      family: readOptFamily(),
      countries: readOptCountries(),
      sample: Number($('optSample').value) || 6556,
      top: Number($('optTop').value) || 8,
      speedMode: (($('optSpeedMode') as unknown as HTMLSelectElement | null)?.value ?? 'two'),
      speedDurationMs: (Number($('optSpeedDur').value) || 6) * 1000,
      speedConnections: 8,
      probeTransport:
        (($('optProbeTransport') as unknown as HTMLSelectElement | null)?.value as
          | 'ws'
          | 'xhttp'
          | 'both'
          | undefined) || 'ws',
    }
  }

  /** 渲染任务清单。 */
  function renderScheduledTasks(): void {
    const tbody = $('taskTable').querySelector('tbody')
    if (!tbody) return
    if (!scheduledTasks.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="muted">（暂无任务）</td></tr>'
      $('taskHint').textContent = '（暂无任务 —— 可在「入口优选」页点「保存为定时任务」新建）'
      updateTaskButtons()
      return
    }
    // 内置任务没有勾选框 ⇒ 永远不该出现在删除集合里。
    // 这里兜底清一次：万一旧状态里残留了，删的时候也不会出现
    // 「点了删除却没删成」的割裂。
    for (const t of scheduledTasks) {
      if (t.builtin) scheduledChecked.delete(t.id)
    }
    tbody.innerHTML = scheduledTasks
      .map((t) => taskRowHtml(t, scheduledChecked.has(t.id)))
      .join('')
    $('taskHint').textContent = `共 ${scheduledTasks.length} 条任务（已勾选 ${scheduledChecked.size} 条）`
    updateTaskButtons()
  }

  /** 更新任务清单的批量操作按钮的可用状态。 */
  function updateTaskButtons(): void {
    const n = scheduledChecked.size
    const del = $('btnTaskDelete') as HTMLButtonElement | null
    if (del) del.disabled = n === 0
    const all = $('taskCheckAll') as HTMLInputElement | null
    if (all) {
      // 「全选」只覆盖**非内置**任务 —— 内置任务没有勾选框。
      const selectable = scheduledTasks.filter((t) => !t.builtin)
      const total = selectable.length
      const picked = selectable.filter((t) => scheduledChecked.has(t.id)).length
      all.checked = total > 0 && picked === total
      all.indeterminate = picked > 0 && picked < total
      // 一个可删的任务都没有时，「全选」也没有意义 —— 置灰。
      all.disabled = total === 0
    }
  }

  /** 渲染本地优选 IP 池。 */
  function renderScheduledPool(): void {
    const tbody = $('poolTable').querySelector('tbody')
    if (!tbody) return
    if (!scheduledPool.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">（本地池为空）</td></tr>'
      $('poolHint').textContent = '（本地池为空 —— 定时任务跑完后结果会自动进这里）'
      updatePoolButtons()
      return
    }
    tbody.innerHTML = scheduledPool
      .map((e) => {
        const checked = poolChecked.has(e.ip.toLowerCase()) ? ' checked' : ''
        return (
          '<tr>' +
          `<td><input type="checkbox" data-pool-ip="${escapeHtml(e.ip)}"${checked} /></td>` +
          `<td class="mono">${escapeHtml(e.ip)}</td>` +
          `<td>${e.port || 443}</td>` +
          `<td class="muted">${escapeHtml(e.taskName || '')}</td>` +
          `<td>${e.speed ? e.speed.toFixed(2) : '—'}</td>` +
          `<td>${e.latency || '—'}</td>` +
          `<td>${escapeHtml(e.colo || '—')}</td>` +
          `<td class="muted">${escapeHtml(formatTaskTime(e.at))}</td>` +
          '</tr>'
        )
      })
      .join('')
    $('poolHint').textContent = `共 ${scheduledPool.length} 条（已勾选 ${poolChecked.size} 条）`
    updatePoolButtons()
  }

  /** 更新 IP 池操作按钮的可用状态。 */
  function updatePoolButtons(): void {
    const n = poolChecked.size
    for (const id of ['btnPoolCopy', 'btnPoolPushReplace', 'btnPoolPushAppend', 'btnPoolRemove']) {
      const btn = $(id) as HTMLButtonElement | null
      if (btn) btn.disabled = n === 0
    }
    const all = $('poolCheckAll') as HTMLInputElement | null
    if (all) {
      const total = scheduledPool.length
      all.checked = total > 0 && n === total
      all.indeterminate = n > 0 && n < total
    }
  }

  /** 显示任务清单上方的提示条。 */
  function showTaskWarn(text: string, isErr: boolean): void {
    const el = $('taskWarn')
    if (!el) return
    el.hidden = !text
    el.textContent = text
    el.className = isErr ? 'warnbox err' : 'warnbox'
  }

  /** 读取任务清单与 IP 池。 */
  async function loadScheduledTasks(): Promise<void> {
    try {
      const res = await window.cfpilot.listScheduledTasks()
      scheduledTasks = res.tasks || []
      // 清掉已不存在的勾选项
      const ids = new Set(scheduledTasks.map((t) => t.id))
      for (const id of Array.from(scheduledChecked)) {
        if (!ids.has(id)) scheduledChecked.delete(id)
      }
      const acct = res.account
      $('taskAccountName').textContent = acct
        ? `${acct.name || acct.accountName || '当前账号'}${acct.accountName && acct.name !== acct.accountName ? '（' + acct.accountName + '）' : ''}`
        : '（没有账号）'
      $('taskAccountHint').textContent = res.hint || ''
      // 启用数上限（后端定的，界面只显示）
      const limitEl = $('taskEnabledLimit')
      const countEl = $('taskEnabledCount')
      if (limitEl) limitEl.textContent = String(res.enabledLimit ?? 3)
      if (countEl) countEl.textContent = String(res.enabledCount ?? 0)
      showTaskWarn('', false)
      renderScheduledTasks()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showTaskWarn('读取任务清单失败：' + msg, true)
    }
    try {
      const res = await window.cfpilot.listScheduledPool()
      scheduledPool = res.entries || []
      const ips = new Set(scheduledPool.map((e) => e.ip.toLowerCase()))
      for (const ip of Array.from(poolChecked)) {
        if (!ips.has(ip)) poolChecked.delete(ip)
      }
      renderScheduledPool()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      $('poolHint').textContent = '读取本地优选 IP 池失败：' + msg
    }
  }

  /**
   * 打开任务编辑弹窗。
   *
   * @param mode 'create' 新建；'edit' 编辑**某一条**任务。
   * @param taskId 'edit' 时要编辑的任务 id。
   *
   * ⚠️ 编辑**只针对单条**任务：多选后统一编辑本身就是错的 ——
   * 各任务的设置可能不同，一个字段填什么值要套到哪些任务上说不清，
   * 很容易把不该改的一并改掉。所以编辑入口是每行末尾的「编辑」按钮。
   */
  function openTaskModal(mode: 'create' | 'edit', taskId?: string): void {
    taskModalMode = mode
    const modal = $('taskModal')
    const title = $('taskModalTitle')
    const hint = $('taskModalHint')
    if (!modal) return
    if (mode === 'create') {
      if (title) title.textContent = '新建定时优选任务'
      ;($('taskName') as HTMLInputElement).value = ''
      ;(document.getElementById('taskDesc') as HTMLTextAreaElement).value = ''
      ;($('taskInterval') as HTMLInputElement).value = '2'
      ;($('taskRunAt') as HTMLInputElement).value = '01:00'
      ;($('taskMinSpeed') as HTMLInputElement).value = '0'
      const nameEl0 = $('taskName') as HTMLInputElement | null
      if (nameEl0) {
        nameEl0.disabled = false
        nameEl0.title = ''
      }
      taskDraftScan = currentScanParams()
      $('taskScanSummary').textContent = scanParamsSummary(taskDraftScan)
      if (hint) {
        hint.textContent =
          '优选参数取自当前「入口优选」页的设置，保存后不可修改。'
      }
    } else {
      const picked = scheduledTasks.filter((t) => t.id === taskId)
      if (!picked.length) return
      taskEditId = taskId ?? null
      if (title) title.textContent = '编辑定时优选任务'
      const first = picked[0]
      ;($('taskName') as HTMLInputElement).value = first.name
      ;(document.getElementById('taskDesc') as HTMLTextAreaElement).value =
        first.description || ''
      ;($('taskInterval') as HTMLInputElement).value = String(first.intervalDays)
      ;($('taskRunAt') as HTMLInputElement).value = first.runAt
      ;($('taskMinSpeed') as HTMLInputElement).value = String(first.minSpeedMBps)
      $('taskScanSummary').textContent = scanParamsSummary(first.scan)
      // 内置任务的名字**不可改** ——
      // 「亚洲组_IPv4」这个名字本身就是它在扫什么的唯一线索。
      const nameEl = $('taskName') as HTMLInputElement | null
      const builtin = first.builtin
      if (nameEl) {
        nameEl.disabled = builtin
        nameEl.title = builtin
          ? '内置任务不能改名 —— 名称里的地址族与地区就是它的用途说明'
          : ''
      }
      if (hint) {
        hint.textContent = builtin
          ? '内置任务不能改名，其余参数可以改。'
          : '优选参数不可编辑。'
      }
    }
    taskModalOrigin = {
      name: ($('taskName') as HTMLInputElement).value,
      description: (document.getElementById('taskDesc') as HTMLTextAreaElement).value,
      intervalDays: ($('taskInterval') as HTMLInputElement).value,
      runAt: ($('taskRunAt') as HTMLInputElement).value,
      minSpeedMBps: ($('taskMinSpeed') as HTMLInputElement).value,
    }
    modal.hidden = false
  }

  /** 关闭任务编辑弹窗。 */
  function closeTaskModal(): void {
    const modal = $('taskModal')
    if (modal) modal.hidden = true
  }

  /** 提交任务编辑弹窗。 */
  async function submitTaskModal(): Promise<void> {
    const name = ($('taskName') as HTMLInputElement).value.trim()
    const description = (
      document.getElementById('taskDesc') as HTMLTextAreaElement
    ).value.trim()
    const intervalDays = Number(($('taskInterval') as HTMLInputElement).value) || 0
    const runAt = ($('taskRunAt') as HTMLInputElement).value.trim()
    const minSpeedMBps = Number(($('taskMinSpeed') as HTMLInputElement).value) || 0

    if (!name) {
      showTaskWarn('任务名称不能为空', true)
      return
    }
    if (intervalDays < 2) {
      showTaskWarn('运行周期不能小于 2 天', true)
      return
    }
    if (!/^\d{2}:\d{2}$/.test(runAt)) {
      showTaskWarn('运行时间格式应为 00:00 - 23:59', true)
      return
    }
    if (minSpeedMBps < 0) {
      showTaskWarn('速度过滤不能为负数', true)
      return
    }
    // 速度下限与「跳过测速」互斥 —— 没有速度值可用于筛选。
    const editing = scheduledTasks.find((t) => t.id === taskEditId)
    const speedMode = taskDraftScan?.speedMode ?? editing?.scan.speedMode
    if (minSpeedMBps > 0 && speedMode === 'off') {
      showTaskWarn('设了速度过滤就不能用「跳过测速」—— 没有速度值可用于筛选', true)
      return
    }

    const btn = $('btnTaskConfirm') as HTMLButtonElement | null
    if (btn) btn.disabled = true
    try {
      if (taskModalMode === 'create') {
        const res = await window.cfpilot.createScheduledTask({
          name,
          description,
          intervalDays,
          runAt,
          minSpeedMBps,
          scan: taskDraftScan!,
        })
        if (!res.ok) {
          showTaskWarn(res.error || '创建失败', true)
          return
        }
        closeTaskModal()
        showTaskWarn('', false)
        log('已创建定时优选任务：' + name, 'ok')
      } else {
        // 只提交改动过的字段 —— 空白字段保持原值。
        //
        // 编辑**只针对单条**任务（入口是每行末尾的「编辑」按钮），
        // 所以提交范围就是那一条，不涉及批量套用。
        const now: Record<string, string> = {
          name,
          description,
          intervalDays: String(intervalDays),
          runAt,
          minSpeedMBps: String(minSpeedMBps),
        }
        const targetId = taskEditId ?? Array.from(scheduledChecked)[0] ?? ''
        if (!targetId) {
          showTaskWarn('没有可保存的任务', true)
          return
        }
        const patch: Parameters<typeof window.cfpilot.updateScheduledTasks>[0] = {
          ids: [targetId],
        }
        // 内置任务的名称框是禁用的 —— 不提交 name（后端也会拒）。
        const nameDisabled = ($('taskName') as HTMLInputElement | null)?.disabled === true
        if (!nameDisabled && now.name !== taskModalOrigin.name) patch.name = now.name
        if (now.description !== taskModalOrigin.description) patch.description = now.description
        if (now.intervalDays !== taskModalOrigin.intervalDays) {
          patch.intervalDays = Number(now.intervalDays)
        }
        if (now.runAt !== taskModalOrigin.runAt) patch.runAt = now.runAt
        if (now.minSpeedMBps !== taskModalOrigin.minSpeedMBps) {
          patch.minSpeedMBps = Number(now.minSpeedMBps)
        }
        if (Object.keys(patch).length === 1) {
          showTaskWarn('没有改动任何字段', true)
          return
        }
        const res = await window.cfpilot.updateScheduledTasks(patch)
        if (!res.ok) {
          showTaskWarn(res.error || '保存失败', true)
          return
        }
        closeTaskModal()
        showTaskWarn('', false)
        log('已保存定时优选任务设置', 'ok')
      }
      await loadScheduledTasks()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showTaskWarn('保存失败：' + msg, true)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  /**
   * 表格容器高度拖曳。
   *
   * ## 为什么要有
   *
   * 表格行数不定：任务多了、来源多了，固定高度要么看不全、
   * 要么给几行也留一大片空白。让用户自己拖最省事。
   *
   * ## 边界
   *
   * - 拖的是**高度**（纵向），手柄在**左下角**（右下角被滚动条占着）；
   * - 高度钳制在 [最小, 最大] 之间 —— 太小看不见表头，太大会把整页撑爆；
   * - 用**指针事件**而不是 mouse 事件：触屏也能拖；
   * - 拖动时给 body 加 `resizing` 类，禁止选中文本、强制十字光标。
   */
  function bindTableResizers(): void {
    const MIN_H = 180
    const MAX_H = 900
    document.querySelectorAll<HTMLElement>('.table-resizer').forEach((handle) => {
      const targetId = handle.getAttribute('data-resize') || ''
      const box = document.getElementById(targetId) as HTMLElement | null
      if (!box) return

      let startY = 0
      let startH = 0

      const onMove = (ev: PointerEvent): void => {
        // 往上拖 = 变高
        const next = startH + (startY - ev.clientY)
        const h = Math.min(MAX_H, Math.max(MIN_H, next))
        // 拖过之后高度由 JS 说了算 ⇒ 解除 CSS 的 max-height 限制，
        // 否则内容比上限高时会多出一截空白。
        box.style.maxHeight = 'none'
        box.style.height = h + 'px'
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('resizing')
      }
      handle.addEventListener('pointerdown', (ev) => {
        ev.preventDefault()
        startY = ev.clientY
        // 容器可能是「内容高度 < 上限」，此时取实际渲染高度作为起点
        startH = box.getBoundingClientRect().height
        // 记下初始上限，双击恢复时用
        if (!box.dataset.baseMax) {
          box.dataset.baseMax = box.style.maxHeight || getComputedStyle(box).maxHeight
        }
        document.body.classList.add('resizing')
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      handle.addEventListener('dblclick', () => {
        // 双击手柄 = 恢复默认高度
        box.style.height = ''
        box.style.maxHeight = box.dataset.baseMax || ''
      })
    })
  }

  /** 绑定定时任务相关的交互。 */
  function bindScheduledTasks(): void {
    // 「保存为定时任务」（入口优选页）
    //
    // ⚠️ **不校验**表单里的域名 / WS 路径 ——
    // 定时任务在运行期从该账号的部署清单现取这两个值，
    // 用户在这里填什么都不影响任务（填错反而误导）。
    $('btnSaveTask')!.addEventListener('click', () => {
      openTaskModal('create')
    })

    $('btnTaskRefresh')!.addEventListener('click', () => {
      void loadScheduledTasks()
    })
    $('btnTaskCancel')!.addEventListener('click', () => closeTaskModal())
    $('btnTaskConfirm')!.addEventListener('click', () => {
      void submitTaskModal()
    })
    // 点遮罩关闭
    const modal = $('taskModal')
    if (modal) {
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) closeTaskModal()
      })
    }

    $('btnTaskDelete')!.addEventListener('click', async () => {
      const ids = Array.from(scheduledChecked)
      if (!ids.length) return
      if (!confirm('删除选中的 ' + ids.length + ' 个任务？')) return
      try {
        const res = await window.cfpilot.deleteScheduledTasks(ids)
        if (!res.ok) {
          showTaskWarn(res.error || '删除失败', true)
          return
        }
        if (res.skipped && res.skipped.length) {
          showTaskWarn('已删除 ' + (res.deleted ?? 0) + ' 个；' + res.skipped.length + ' 个内置任务不可删除', true)
        } else {
          showTaskWarn('', false)
        }
        scheduledChecked.clear()
        await loadScheduledTasks()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        showTaskWarn('删除失败：' + msg, true)
      }
    })

    // 任务表勾选
    $('taskTable').addEventListener('change', (ev) => {
      const box = (ev.target as HTMLElement | null)?.closest('input[data-task-id]') as HTMLInputElement | null
      if (box) {
        const id = box.getAttribute('data-task-id') || ''
        if (box.checked) scheduledChecked.add(id)
        else scheduledChecked.delete(id)
        updateTaskButtons()
        return
      }
      const all = (ev.target as HTMLElement | null)?.closest('#taskCheckAll') as HTMLInputElement | null
      if (all) {
        scheduledChecked.clear()
        if (all.checked) {
          // 只选**非内置**任务 —— 内置任务没有勾选框（删不掉），全选也不该带上它。
          for (const t of scheduledTasks) {
            if (!t.builtin) scheduledChecked.add(t.id)
          }
        }
        renderScheduledTasks()
      }
    })

    // 单条任务的「编辑」按钮（末列）
    $('taskTable').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest(
        'button[data-task-edit]'
      ) as HTMLButtonElement | null
      if (!btn) return
      const id = btn.getAttribute('data-task-edit') || ''
      if (!id) return
      openTaskModal('edit', id)
    })

    // 单条任务的启用 / 停用
    $('taskTable').addEventListener('click', async (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest(
        'button[data-task-toggle]'
      ) as HTMLButtonElement | null
      if (!btn) return
      const id = btn.getAttribute('data-task-toggle') || ''
      const task = scheduledTasks.find((t) => t.id === id)
      if (!task) return
      btn.disabled = true
      try {
        const res = await window.cfpilot.updateScheduledTasks({
          ids: [id],
          enabled: !task.enabled,
        })
        if (!res.ok) {
          showTaskWarn(res.error || '操作失败', true)
          return
        }
        showTaskWarn('', false)
        log(`已${task.enabled ? '停用' : '启用'}定时任务「${task.name}」`, 'ok')
        await loadScheduledTasks()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        showTaskWarn('操作失败：' + msg, true)
        await loadScheduledTasks()
      }
    })

    // IP 池勾选
    $('poolTable').addEventListener('change', (ev) => {
      const box = (ev.target as HTMLElement | null)?.closest('input[data-pool-ip]') as HTMLInputElement | null
      if (box) {
        const ip = (box.getAttribute('data-pool-ip') || '').toLowerCase()
        if (box.checked) poolChecked.add(ip)
        else poolChecked.delete(ip)
        updatePoolButtons()
        return
      }
      const all = (ev.target as HTMLElement | null)?.closest('#poolCheckAll') as HTMLInputElement | null
      if (all) {
        poolChecked.clear()
        if (all.checked) {
          for (const e of scheduledPool) poolChecked.add(e.ip.toLowerCase())
        }
        renderScheduledPool()
      }
    })

    // 复制选中 IP
    $('btnPoolCopy')!.addEventListener('click', () => {
      const picked = scheduledPool.filter((e) => poolChecked.has(e.ip.toLowerCase()))
      if (!picked.length) {
        log('没有勾选 IP', 'warn')
        return
      }
      const text = picked
        .map((e) => {
          const host = e.ip.includes(':') ? '[' + e.ip + ']' : e.ip
          return `${host}:${e.port || 443}#${e.remark || ''}`
        })
        .join('\n')
      copy(text)
      log('已复制 ' + picked.length + ' 条 IP', 'ok')
    })

    // 覆盖回填 / 增量回填
    const pushPool = async (mode: 'replace' | 'append'): Promise<void> => {
      const picked = scheduledPool.filter((e) => poolChecked.has(e.ip.toLowerCase()))
      if (!picked.length) {
        log('没有勾选 IP', 'warn')
        return
      }
      const verb = mode === 'append' ? '增量回填' : '覆盖回填'
      if (mode === 'replace' && !confirm('覆盖回填会清空面板优选池里已有的 IP（含你在面板手填的「手动指定 IP」）。继续？')) {
        return
      }
      try {
        const res = await window.cfpilot.pushScheduledPool(picked, mode)
        if (!res.ok) {
          log(verb + '失败：' + (res.error || '未知错误'), 'err')
          return
        }
        log(verb + '完成：' + (res.count ?? picked.length) + ' 条', 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(verb + '失败：' + msg, 'err')
      }
    }
    $('btnPoolPushReplace')!.addEventListener('click', () => {
      void pushPool('replace')
    })
    $('btnPoolPushAppend')!.addEventListener('click', () => {
      void pushPool('append')
    })

    // 移除选中
    $('btnPoolRemove')!.addEventListener('click', async () => {
      const ips = Array.from(poolChecked)
      if (!ips.length) return
      try {
        const res = await window.cfpilot.deleteScheduledPool(ips)
        if (!res.ok) {
          log('移除失败：' + (res.error || '未知错误'), 'err')
          return
        }
        log('已移除 ' + (res.deleted ?? 0) + ' 条', 'ok')
        poolChecked.clear()
        await loadScheduledTasks()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('移除失败：' + msg, 'err')
      }
    })

    // 定时任务状态推送（SSE）
    window.cfpilot.onTaskStatus((payload) => {
      if (!payload) return
      if (payload.status === 'ok' || payload.status === 'relaxed') {
        log(`定时任务「${payload.name}」完成：${payload.count ?? 0} 条入池`, 'ok')
      } else if (payload.status === 'failed') {
        log(`定时任务「${payload.name}」失败：${payload.message || ''}`, 'err')
      }
      void loadScheduledTasks()
    })
  }

  function bindScan(): void {
    document.getElementById('btnScan')!.addEventListener('click', async () => {
      const host = $('optHost').value.trim()
      const path = $('optPath').value.trim()
      if (!host) { log('请填写 Worker 域名（数据面地址）', 'warn'); return }
      if (!path) { log('请填写 WS 路径', 'warn'); return }

      // 测速地址输入框两种用法：
      //   以 / 开头  → 阶段二/三的探针路径（目标项目自己的端点）
      //   否则      → 公开测速地址（强制 url 模式）
      const probeInput = $('optProbePath').value.trim()
      const probePath = probeInput.startsWith('/') ? probeInput : ''
      const speedUrl = probeInput && !probeInput.startsWith('/') ? probeInput : ''

      setBusy(true)
      // 开启门控：Go 版是异步扫描，之后几分钟的 SSE 日志都算这一次优选。
      scanProgressActive = true
      scanProgressPct = 0
      updateScanProgress('开始优选')
       $('scanOut').textContent = '正在优选，请稍候…'
      try {
        const result = await window.cfpilot.runScan({
          host,
          // 端口固定 443：Pages 的 HTTPS 入口，2053 等端口在部分网络会被阻断
          wsPath: path,
          probePath,
          probeTransport: (($('optProbeTransport') as unknown as HTMLSelectElement | null)?.value as 'ws' | 'xhttp' | 'both' | undefined) || 'ws',
          xhttpPath: ($('optXhttpPath') as unknown as HTMLInputElement | null)?.value.trim() || '/xhttp',
          // 自定义候选：选「自定义列表」时跳过网段采样，直接用导入的 IP
          candidates: sourceMode === 'custom' ? candidateText() : '',
          // 测速档位：two=短测粗筛+精确测速，one=仅精确测速，off=关
          skipSpeed: (($('optSpeedMode') as unknown as HTMLSelectElement | null)?.value ?? 'two') === 'off',
          sample: Number($('optSample').value) || 6556,
          top: Number($('optTop').value) || 15,
          twoStageSpeed: (($('optSpeedMode') as unknown as HTMLSelectElement | null)?.value ?? 'two') === 'two',
          countries: readOptCountries(),
          speedMode: speedUrl ? 'url' : 'auto',
          speedUrl,
          // 测速连接数固定 8 条：单条 TCP 受拥塞窗口限制会系统性低估带宽
          // （实测 1 条 0.12、3 条 0.47、8 条 1.15 MB/s），界面不再提供输入框
          speedConnections: 8,
          speedDurationMs: (Number($('optSpeedDur').value) || 6) * 1000,
          // 地址族：默认 auto（后端先做 IPv6 环境预检，通了才让 v6 参与）
          family: readOptFamily(),
          // ⚠️ 必须把「不回填」勾选状态传给后端
          //
          // 界面也没有读取勾选状态的地方 —— 于是用户取消勾选后
          // 点开始优选，界面重渲染时又把默认值（checked）勾了回去，
          // 看起来像「勾选被自动恢复」，实际是整个开关没接线。
          // 优选阶段**不回填**
          //
          // 回填改为结果出来后手动点「增量回填 / 覆盖回填」按钮再执行。
          // 好处：
          //   1. 令牌在回填那一刻才申请，不会因为优选耗时而过期
          //   2. 用户不必理解令牌机制，看到结果再决定要不要回填
          noCallback: true,
        })
        // 同上：Go 版异步执行，`started` 阶段的响应里没有 ok 字段
        if (result.started) {
          updateScanProgress('扫描任务已启动')
           $('scanOut').textContent = '正在优选…（下方进度条会实时更新）'
        } else if (result.ok === false || result.error) {
          finishScanProgress(false)
           $('scanOut').textContent = '优选失败：' + (result.error ?? '')
        }
      } catch (err) {
        log('优选异常：' + (err instanceof Error ? err.message : String(err)), 'err')
        finishScanProgress(false)
         $('scanOut').textContent = '优选异常'
      } finally {
        setBusy(false)
      }
    })


    document.getElementById('btnCopyResult')!.addEventListener('click', () => {
      const text = $('scanOut').textContent ?? ''
      if (!text || text.includes('还没有结果')) {
        log('还没有可复制的结果', 'warn')
        return
      }
      copy(text)
    })

    /**
     * 回填面板：把这批 IP 写进面板的「手动优选 IP」。
     *
     * 拆成**增量 / 覆盖**两个按钮，共用同一段「取令牌 → 提交」流程：
     *   - 增量 append  ：保留池里已有的 IP，只补真正新的
     *   - 覆盖 replace ：清空池后写入（历史行为）
     *
     * 令牌改为**点按钮时才现取**：优选要跑几分钟，提前取的 10 分钟令牌
     * 很容易过期；现取既不会超时，用户也不用理解「令牌」这回事。
     */
    const runPush = async (mode: 'append' | 'replace'): Promise<void> => {
      const btn = document.getElementById(
        mode === 'append' ? 'btnPushAppend' : 'btnPushReplace'
      ) as HTMLButtonElement | null
      const other = document.getElementById(
        mode === 'append' ? 'btnPushReplace' : 'btnPushAppend'
      ) as HTMLButtonElement | null
      const hint = document.getElementById('pushHint')
      const verb = mode === 'append' ? '增量回填' : '覆盖回填'

      if (lastScanLines.length === 0) {
        log('还没有优选结果，先跑一次优选', 'warn')
        return
      }
      if (btn) btn.disabled = true
      if (other) other.disabled = true
      if (hint) hint.textContent = '正在申请临时令牌…'

      try {
        const tokenRes = await window.cfpilot.fetchScannerToken()
        if (!tokenRes || !tokenRes.ok) {
          const msg = (tokenRes && tokenRes.error) || '未知错误'
          if (hint) hint.textContent = '获取令牌失败：' + msg
          log(verb + '失败：' + msg, 'err')
          return
        }

        if (hint) hint.textContent = '正在' + verb + '…'
        const result = await window.cfpilot.pushScanResults(lastScanLines, mode)
        if (!result || !result.ok) {
          const msg = (result && result.error) || '未知错误'
          if (hint) hint.textContent = verb + '失败：' + msg
          log(verb + '失败：' + msg, 'err')
          return
        }

        const total = result.count ?? lastScanLines.length
        const added = typeof result.added === 'number' ? result.added : total
        const detail =
          mode === 'append'
            ? '新增 ' + added + ' 条（面板原有条目已保留）'
            : '共 ' + total + ' 条'
        if (hint) {
          hint.textContent =
            '✅ 已' + verb + '：' + detail + '。打开面板「节点来源 → 手动优选 IP」点「查看」即可看到。'
        }
        log('✅ 已' + verb + '：' + detail, 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (hint) hint.textContent = verb + '失败：' + msg
        log(verb + '失败：' + msg, 'err')
      } finally {
        if (btn) btn.disabled = false
        if (other) other.disabled = false
      }
    }

    document
      .getElementById('btnPushAppend')!
      .addEventListener('click', () => void runPush('append'))
    document
      .getElementById('btnPushReplace')!
      .addEventListener('click', () => void runPush('replace'))

    /**
     * 自动识别：一次填好域名 + WS 路径。
     *
     * 但它们读的是同一份部署清单，用户总是要连点两次 —— 属于多余步骤。
     *
     * 现在一次点击同时调两个接口，任一失败不影响另一个。
     */
    document.getElementById('btnAutoDetect')!.addEventListener('click', async () => {
      const btn = document.getElementById('btnAutoDetect') as HTMLButtonElement | null
      if (btn) btn.disabled = true
      log('自动识别域名与 WS 路径…')

      try {
        try {
          const host = await window.cfpilot.detectScanHost()
          if (host.ok && host.host) {
            $('optHost').value = host.host
            const source = host.source ?? ''
            if (source === 'custom' || source.includes('自定义域名')) {
              log(`已填入自定义域名：${host.host}`, 'ok')
            } else {
              log(`已填入 ${host.host}（来源：${source || '未知'}）`, 'warn')
              log('该实例没有绑定自定义域名。建议绑定后再优选——', 'warn')
              log('workers.dev / pages.dev 生产链接在部分网络环境会被阻断，测出来的结果不可信。', 'warn')
            }
          } else {
            log('识别域名失败：' + (host.error ?? '未知错误'), 'err')
          }
        } catch (err) {
          log('识别域名异常：' + (err instanceof Error ? err.message : String(err)), 'err')
        }

        try {
          const path = await window.cfpilot.detectScanPath()
          if (path.ok && path.path) {
            $('optPath').value = path.path
            log(`已填入 WS 路径：${path.path}`, 'ok')
          } else {
            log('识别 WS 路径失败：' + (path.error ?? '未知错误'), 'err')
          }
          if (path.ok && (path as { xhttpPath?: string }).xhttpPath) {
            const xEl = $('optXhttpPath') as unknown as HTMLInputElement | null
            if (xEl) xEl.value = (path as { xhttpPath: string }).xhttpPath
            log(`已填入 XHTTP 路径：${(path as { xhttpPath: string }).xhttpPath}`, 'ok')
          }
        } catch (err) {
          log('识别 WS 路径异常：' + (err instanceof Error ? err.message : String(err)), 'err')
        }
      } finally {
        if (btn) btn.disabled = false
      }
    })

    /**
     * 「检测网络环境」：弹窗展示两段结果 —— 代理环境 + IPv6 环境。
     *
     * ⚠️ 必须**总是**往弹窗里写点什么：一个字都不写的话，
     * 用户点了按钮看到弹窗空白，看起来就是按钮坏了。
     */
    const openEnvCheck = async (): Promise<void> => {
      const btn = document.getElementById('btnEnvCheck') as HTMLButtonElement | null
      const proxyList = document.getElementById('envProxyList')
      const v6List = document.getElementById('envV6List')
      const mask = document.getElementById('envModal')
      if (proxyList) {
        proxyList.innerHTML = ''
        proxyList.style.color = ''
        proxyList.textContent = '检测中…'
      }
      if (v6List) {
        v6List.innerHTML = ''
        v6List.style.color = ''
        v6List.textContent = '检测中…'
      }
      if (mask) mask.hidden = false
      if (btn) btn.disabled = true
      log('检测网络环境…')

      try {
        // 带上当前填的域名：IPv6 预检要靠它的 AAAA 找活跃前缀做金丝雀
        const result = await window.cfpilot.checkEnvironment($('optHost').value.trim())
        renderEnvModal(result)
        if (result.clean) {
          log('✅ 代理环境正常，优选结果可信', 'ok')
        } else {
          log('⚠ 检测到代理环境异常，优选结果可能失真（建议关闭系统代理 / TUN 后重测）', 'warn')
        }
        const v6 = result.ipv6
        if (v6 && v6.status !== 'ok') {
          log('⚠ ' + (v6.message || '当前网络环境不具备 IPv6 测速条件'), 'warn')
        } else if (v6) {
          log('✅ ' + (v6.message || 'IPv6 环境可用'), 'ok')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('检测失败：' + msg, 'err')
        renderEnvModal({ clean: undefined, findings: ['检测失败：' + msg] })
      } finally {
        if (btn) btn.disabled = false
      }
    }

    document.getElementById('btnEnvCheck')!.addEventListener('click', () => void openEnvCheck())
    document.getElementById('btnEnvRefresh')?.addEventListener('click', () => void openEnvCheck())
    document.getElementById('btnEnvClose')?.addEventListener('click', () => {
      const mask = document.getElementById('envModal')
      if (mask) mask.hidden = true
    })
  }

  /* ------------------------------------------------------------------ */
  /* 优选历史（留底 / 多选复制 / 二次复测）                                */
  /* ------------------------------------------------------------------ */

  /**
   * 全部历史会话（最新在前）。
   *
   * 数据由**后端**在每次优选成功后自动留底（本地优选 / 一键优选都写），
   * 界面只读不写 —— 单一事实来源，避免双写竞态。
   */
  let historySessions: ScanHistorySession[] = []

  /**
   * 当前展开的会话 id 集合（**可同时展开多个**）。
   *
   * 早前是手风琴式（只允许展开一个），理由是「复测要用该次会话保存的域名 /
   * WS 路径，跨会话混一起会打到错误的 SNI」。但用户实际需要「把几次优选里
   * 最好的 IP 挑出来一起复制 / 一起复测」—— 手风琴式让这件事无法操作。
   *
   * 现在改为允许多个同时展开，复测**按会话分组**分别调用后端（每组用该会话
   * 自己的 host / wsPath），既支持跨批次选择，也不会打错 SNI。
   */
  let historyExpandedIds = new Set<string>()

  /** 勾选的 IP（键 = ip:port；**跨会话共享**，可跨批次一起复制 / 复测） */
  let historyChecked = new Set<string>()

  function historyKey(ip: string, port: number): string {
    return ip + ':' + port
  }

  /** 读取历史并重绘（页面加载 / 优选完成 / 删除后都会调） */
  async function loadScanHistory(): Promise<void> {
    const listEl = document.getElementById('historyList')
    if (!listEl) return
    try {
      const res = await window.cfpilot.getScanHistory()
      if (!res || !res.ok) {
        listEl.textContent = '读取历史失败：' + ((res && res.error) || '未知错误')
        return
      }
      historySessions = res.sessions ?? []
      // 展开中的会话可能已被删除 / 裁剪出容量，此时收起（勾选集同步剔除）
      const alive = historySessions.map((s) => s.id)
      let pruned = false
      for (const id of [...historyExpandedIds]) {
        if (!alive.includes(id)) {
          historyExpandedIds.delete(id)
          pruned = true
        }
      }
      if (pruned) {
        const aliveKeys = new Set<string>()
        for (const s of historySessions) for (const e of s.entries) aliveKeys.add(historyKey(e.ip, e.port))
        for (const key of [...historyChecked]) if (!aliveKeys.has(key)) historyChecked.delete(key)
      }
      renderScanHistory()
    } catch (err) {
      listEl.textContent = '读取历史失败：' + (err instanceof Error ? err.message : String(err))
    }
  }

  /** ISO 时间 → 本地可读（MM-DD HH:mm），解析失败原样返回 */
  function fmtHistoryTime(iso: string): string {
    try {
      const d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      const pad = (n: number) => String(n).padStart(2, '0')
      return (
        pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      )
    } catch {
      return iso
    }
  }

  const HISTORY_SOURCE_LABEL: Record<string, string> = {
    local: '本地优选',
    quick: '一键优选',
  }

  function renderScanHistory(): void {
    const listEl = document.getElementById('historyList')
    if (!listEl) return
    listEl.innerHTML = ''

    if (historySessions.length === 0) {
      const p = document.createElement('p')
      p.className = 'history-empty'
      p.textContent = '还没有优选历史。跑一次优选（本地优选或一键优选）后会自动留底。'
      listEl.appendChild(p)
      updateHistoryButtons()
      return
    }

    for (const sess of historySessions) {
      const item = document.createElement('div')
      item.className = 'history-item'

      // ---- 会话头（点击展开 / 收起）----
      const head = document.createElement('div')
      head.className = 'history-head'

      const arrow = document.createElement('span')
      arrow.className = 'arrow'
      arrow.textContent = historyExpandedIds.has(sess.id) ? '▾' : '▸'
      head.appendChild(arrow)

      const at = document.createElement('span')
      at.className = 'h-at'
      at.textContent = fmtHistoryTime(sess.at)
      at.title = sess.at
      head.appendChild(at)

      const meta = document.createElement('span')
      meta.className = 'h-meta'
      const src = HISTORY_SOURCE_LABEL[sess.source] || sess.source
      meta.textContent =
        src + ' · ' + sess.host + ' · ' + sess.entries.length + ' 个 IP' +
        (sess.skipSpeed ? ' · 未测速' : '')
      head.appendChild(meta)

      // 删除按钮（阻止冒泡，不触发展开）
      const del = document.createElement('button')
      del.className = 'h-del'
      del.textContent = '删除'
      del.title = '删除这条历史'
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        try {
          await window.cfpilot.deleteScanHistory(sess.id)
          log('已删除历史记录', 'ok')
        } catch (err) {
          log('删除失败：' + (err instanceof Error ? err.message : String(err)), 'err')
        }
        await loadScanHistory()
      })
      head.appendChild(del)

      head.addEventListener('click', () => {
        // 切换展开时**保留**勾选：允许多个批次同时展开、跨批次一起复制 / 复测
        if (historyExpandedIds.has(sess.id)) historyExpandedIds.delete(sess.id)
        else historyExpandedIds.add(sess.id)
        renderScanHistory()
      })
      item.appendChild(head)

      // ---- 展开体：条目表（含勾选与最近复测状态）----
      if (historyExpandedIds.has(sess.id)) {
        const body = document.createElement('div')
        body.className = 'history-body'
        body.appendChild(buildHistoryTable(sess))
        item.appendChild(body)
      }

      listEl.appendChild(item)
    }
    updateHistoryButtons()
  }

  /** 构建某次会话的条目表：勾选列 + 基本指标 + 最近复测状态列 */
  function buildHistoryTable(sess: ScanHistorySession): HTMLTableElement {
    const table = document.createElement('table')
    const thead = document.createElement('thead')
    const hrow = document.createElement('tr')

    // 表头 checkbox = 本会话全选 / 全不选（只影响本会话，不碰其它批次的勾选）
    const thCheck = document.createElement('th')
    const selAll = document.createElement('input')
    selAll.type = 'checkbox'
    const sessKeys = sess.entries.map((e) => historyKey(e.ip, e.port))
    selAll.checked = sessKeys.length > 0 && sessKeys.every((k) => historyChecked.has(k))
    selAll.indeterminate = !selAll.checked && sessKeys.some((k) => historyChecked.has(k))
    selAll.addEventListener('change', () => {
      if (selAll.checked) {
        for (const k of sessKeys) historyChecked.add(k)
      } else {
        for (const k of sessKeys) historyChecked.delete(k)
      }
      renderScanHistory()
    })
    thCheck.appendChild(selAll)
    hrow.appendChild(thCheck)
    for (const h of ['#', '地址', '机房', 'TLS(ms)', 'TCP(ms)', '下行(MB/s)', '最近复测', '质量报告']) {
      const th = document.createElement('th')
      th.textContent = h
      hrow.appendChild(th)
    }
    thead.appendChild(hrow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    sess.entries.forEach((e, i) => {
      const tr = document.createElement('tr')

      const tdCheck = document.createElement('td')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = historyChecked.has(historyKey(e.ip, e.port))
      cb.addEventListener('change', () => {
        if (cb.checked) historyChecked.add(historyKey(e.ip, e.port))
        else historyChecked.delete(historyKey(e.ip, e.port))
        updateHistoryButtons()
      })
      tdCheck.appendChild(cb)
      tr.appendChild(tdCheck)

      // 跳过测速的会话速度本就是 0，显示 — 而不是 0
      const speed = sess.skipSpeed ? '—' : String(e.speed)
      const tls = e.tlsMs > 0 ? String(e.tlsMs) : '—'
      // 机房列显示「SIN新加坡」——与可复制结果的备注一致
      const colo = e.colo ? e.colo + (e.city || '') : '—'
      // 「TCP(ms)」列显示真正的 TCP 建连耗时；101 握手延迟放进悬浮提示。
      const hasTcp = typeof e.tcpMs === 'number' && e.tcpMs > 0
      const tcpText = hasTcp ? String(e.tcpMs) : String(e.latency)
      const cells = [String(i + 1), e.ip + ':' + e.port, colo, tls, tcpText, speed]
      for (const c of cells) {
        const td = document.createElement('td')
        td.textContent = c
        tr.appendChild(td)
      }
      const tcpCell = tr.querySelectorAll('td')[4]
      if (tcpCell) {
        tcpCell.title = hasTcp
          ? `TCP 建连 ${e.tcpMs} ms · 101 握手 ${e.latency} ms`
          : `未记录 TCP 建连耗时（旧数据），此处为 101 握手延迟 ${e.latency} ms`
      }

      // 最近复测状态列：✓ 可用 / ✗ 失败原因（悬停看时间）
      const tdTest = document.createElement('td')
      const lt = e.lastTest
      if (!lt) {
        tdTest.textContent = '—'
        tdTest.style.color = 'var(--text-muted)'
      } else if (lt.ok) {
        tdTest.textContent =
          '✓ 可用 ' + (lt.colo || '') + (lt.tlsMs > 0 ? ' · TLS ' + lt.tlsMs + 'ms' : '')
        tdTest.style.color = 'var(--ok, #34d399)'
        tdTest.title = '复测时间：' + fmtHistoryTime(lt.at)
      } else {
        tdTest.textContent = '✗ ' + (lt.error || '失败')
        tdTest.style.color = 'var(--err, #f87171)'
        tdTest.title = '复测时间：' + fmtHistoryTime(lt.at)
      }
      tr.appendChild(tdTest)

      const tdReport = document.createElement('td')
      const reportButton = document.createElement('button')
      reportButton.type = 'button'
      reportButton.textContent = '质量报告'
      reportButton.className = 'btn'
      reportButton.title = '查看已保存的质量报告（只读）；要补测证据请用报告里的「重新检测此 IP」'
      tdReport.appendChild(reportButton)
      tr.appendChild(tdReport)
      tbody.appendChild(tr)
      const reportRow = document.createElement('tr')
      reportRow.hidden = true
      const reportCell = document.createElement('td')
      reportCell.colSpan = 9
      reportCell.style.whiteSpace = 'normal'
      reportRow.appendChild(reportCell)
      tbody.appendChild(reportRow)
      let loaded = false
      reportButton.addEventListener('click', async () => {
        // 展开/收起都走这里：报告已加载过就直接切显隐，不重复读。
        reportRow.hidden = !reportRow.hidden
        reportButton.setAttribute('aria-expanded', String(!reportRow.hidden))
        if (reportRow.hidden) return
        if (loaded) return
        reportCell.textContent = '正在读取本地报告…'
        reportButton.disabled = true
        try {
          // 只读：读已保存的证据，不触发任何检测。
          // 要补证据用报告里的「重新检测此 IP」。
          const result = await window.cfpilot.getIPQualityReport({ sessionId: sess.id, ip: e.ip, port: e.port })
          if (!result.ok || !result.report) {
            reportCell.textContent = result.error || '报告不可用'
            return
          }
          renderIPQualityReport(reportCell, result.report, { sessionId: sess.id, host: sess.host, wsPath: sess.wsPath, probePath: sess.probePath })
          loaded = true
        } catch (error) { reportCell.textContent = error instanceof Error ? error.message : String(error) }
        finally { reportButton.disabled = false }
      })
    })
    table.appendChild(tbody)
    return table
  }

  /**
   * 质量报告字段说明（悬浮气泡）。
   *
   * 每个字段写清「是什么 / 哪来的 / 影响什么 / 参考值」，
   * 避免用户看到数字却不知道好坏。
   */
  const QUALITY_FIELD_INFO: Record<string, { label: string; unit: string; kind: 'ms' | 'ms-tls' | 'ms-p95' | 'ms-jitter' | 'speed' | 'percent' | 'bool' | 'text'; tip: string }> = {
    'basic.tcpMs': {
      label: 'TCP 耗时',
      unit: 'ms',
      kind: 'ms',
      tip: '【是什么】本机到该候选 IP 完成 TCP 三次握手所需的时间。\n【来源】优选阶段一实测；历史复测时会用更近的一次覆盖。\n【影响】反映链路往返与运营商路由质量；过大时客户端握手容易超时。\n【参考】<80ms 良好，80–200ms 一般，>200ms 偏慢（跨境链路通常更高）。',
    },
    'protocol.tlsMs': {
      label: 'TLS 耗时',
      unit: 'ms',
      kind: 'ms-tls',
      tip: '【是什么】TCP 建连后完成 TLS 握手（证书校验 + 密钥协商）的时间。\n【来源】优选阶段一之二实测。\n【影响】最关键指标：它超时就是客户端里显示 -1 的典型原因。\n【参考】<300ms 良好，300–800ms 一般，>800ms 偏慢。',
    },
    'protocol.wsOk': {
      label: 'WS101',
      unit: '',
      kind: 'bool',
      tip: '【是什么】用你的数据面域名作 SNI/Host 完成 TLS 后发起 WebSocket 升级，是否收到 101。\n【来源】优选阶段二实测。\n【影响】只有 101 才代表这个 IP 能真正服务你的域名。\n【参考】通过即可用；未通过时该 IP 对你的部署不可用。',
    },
    'protocol.pongOk': {
      label: 'PONG',
      unit: '',
      kind: 'bool',
      tip: '【是什么】在 101 之后再发一帧探针数据，确认对端确实是数据面在应答，而不是静态页。\n【来源】优选阶段二（严格模式）或复测时实测；非严格模式/无探针端点时显示「未执行」。\n【影响】可排除「路径上只有静态资源」的假阳性 IP。\n【参考】通过表示握手后的数据面确实在线。',
    },
    'protocol.realTunnelOk': {
      label: '真实隧道',
      unit: '',
      kind: 'bool',
      tip: '【是什么】用真实 VLESS/Trojan 凭据建立隧道并访问一个外部目标。\n【来源】优选阶段二点五或复测时实测；未提供凭据时显示「未执行」。\n【影响】唯一能证明「节点能真正出网」的检查。\n【参考】通过表示整条代理链路可用。',
    },
    'performance.speedMBps': {
      label: '稳态下行',
      unit: 'MB/s',
      kind: 'speed',
      tip: '【是什么】丢弃慢启动后、按时长加权的平均下行吞吐。\n【来源】优选阶段三真实测速（多流并发 + 丢弃预热）。\n【影响】决定实际下载、看视频与加载体验；也是默认排序依据。\n【参考】>1 MB/s 良好，0.5–1 MB/s 一般，<0.5 MB/s 偏慢（跨境链路整体偏低）。',
    },
    'performance.peakMBps': {
      label: '峰值下行',
      unit: 'MB/s',
      kind: 'speed',
      tip: '【是什么】测速窗口内的瞬时最高吞吐。\n【来源】优选阶段三测速的窗口统计。\n【影响】反映突发能力，不代表持续能力；与稳态值差距大说明链路抖动明显。\n【参考】不参与排序，仅作诊断；与稳态值同量级说明链路稳定。',
    },
    'performance.stabilityP95': {
      label: 'TCP P95',
      unit: 'ms',
      kind: 'ms-p95',
      tip: '【是什么】多次观测中 95% 的 TCP 握手都快于该值（长尾延迟）。\n【来源】历史优选与复测保留的 TCP 观测（至少 3 次才计算）。\n【影响】刻画长尾：均值正常但 P95 高，表现为偶发卡顿、偶发 -1。\n【参考】<120ms 良好，120–250ms 一般，>250ms 抖动明显。',
    },
    'performance.jitter': {
      label: '抖动',
      unit: 'ms',
      kind: 'ms-jitter',
      tip: '【是什么】多次 TCP 观测中最大值与最小值之差。\n【来源】同 P95，取自同一批保留样本。\n【影响】数值越大说明链路质量随时间波动越大，节点更容易时好时坏。\n【参考】<30ms 稳定，30–80ms 一般，>80ms 波动明显。',
    },
    egress: {
      label: '出口识别',
      unit: '',
      kind: 'text',
      tip: '【是什么】通过用户自有的 HTTPS 识别服务，观察该传输路径真正对外的出口地址。\n【来源】实验性能力，需用户显式指定识别服务与传输路径。\n【影响】决定目标网站看到的 IP；数据中心出口常被风控。\n【参考】默认未执行；观测结果只代表当时那条路径。',
    },
    'purity.score': {
      label: '纯净度评分（0~100，越低越干净）',
      unit: '',
      kind: 'text',
      tip: '【是什么】该 IP 在公开信誉库里的欺诈分（0~100，越高越可疑）。\n【来源】质量检测时查公开信誉画像。\n【影响】⚠️ 这是**入口 IP** 的分数；目标站看到的是**出口 IP**，两者不是一回事。\n【参考】0~10 干净，25 以上偏脏。',
    },
    'purity.risk': {
      label: '风险等级',
      unit: '',
      kind: 'text',
      tip: '【是什么】信誉库给出的风险档位（低/中/高）。\n【来源】质量检测时查公开信誉画像。\n【影响】入口 IP 自身的风险档位；不决定目标站是否放行出口。',
    },
    'purity.flags': {
      label: '身份标记',
      unit: '',
      kind: 'text',
      tip: '【是什么】该 IP 是否被标记为机房、代理、VPN、Tor、住宅等。\n【来源】质量检测时查公开信誉画像。\n【影响】机房与代理属性常被目标站提高风控门槛；住宅属性对解锁类服务更友好。',
    },
    'purity.blacklists': {
      label: '黑名单',
      unit: '',
      kind: 'text',
      tip: '【是什么】该 IP 命中的公开黑名单（Spamhaus / Firehol 等）。\n【来源】质量检测时查公开信誉画像。\n【影响】命中越多越容易被风控直接拒绝。',
    },
    'purity.scenarios': {
      label: '场景适配',
      unit: '',
      kind: 'text',
      tip: '【是什么】按信誉画像推导的各使用场景倾向（常规浏览 / 账号登录 / 流媒体与 AI / 风控严格站点）。\n【来源】由评分、身份标记与黑名单推导，不是实测解锁结论。\n【影响】给使用者一个取舍参考；真实能否通过仍取决于目标站策略与**出口 IP**。',
    },
    'purity.attribution': {
      label: '归属信息',
      unit: '',
      kind: 'text',
      tip: '【是什么】该 IP 的国家 / 城市 / ASN / ISP / 组织。\n【来源】质量检测时查公开归属信息。\n【影响】同一网段往往同归属，用于判断「这一批节点是不是来自同一片区域」。',
    },
    compatibility: {
      label: '目标站兼容性',
      unit: '',
      kind: 'text',
      tip: '【是什么】对用户指定的测试站点做低频真实访问，观察是否被挑战或拒绝。\n【来源】实验性能力，需用户显式指定目标站点。\n【影响】反映该路径访问特定网站的可用性，与 IP 快慢无关。\n【参考】默认未执行；结果是某一时点的观测，不代表长期结论。',
    },
    'history.successRate': {
      label: '历史成功率',
      unit: '%',
      kind: 'percent',
      tip: '【是什么】已保留样本（优选 + 复测）中通过的比例。\n【来源】本地历史记录。\n【影响】反映该 IP 在本机当前网络下的稳定程度。\n【参考】>90% 稳定；注意它只统计被保留的样本，不是全部候选的通过率。',
    },
  }

  /** 延迟类指标的阈值（毫秒）：低于 good 绿，低于 warn 黄，其余红。 */
  function latencyColor(value: number, kind: string): string {
    const thresholds: Record<string, [number, number]> = {
      ms: [80, 200],
      'ms-tls': [300, 800],
      'ms-p95': [120, 250],
      'ms-jitter': [30, 80],
    }
    const pair = thresholds[kind] || thresholds['ms']!
    if (value <= pair[0]) return 'quality-good'
    if (value <= pair[1]) return 'quality-warn'
    return 'quality-bad'
  }

  /** 速度类指标的阈值：>1 绿，0.5–1 黄，<0.5 红。 */
  function speedColor(value: number): string {
    if (value > 1) return 'quality-good'
    if (value >= 0.5) return 'quality-warn'
    return 'quality-bad'
  }

  /** 报告呈现已记录证据；缺失指标保留状态，不伪造评分。
   * ctx 可选：给了才提供「重新检测 / 识别本机出口」两个显式动作。 */
  function renderIPQualityReport(container: HTMLElement, report: IPQualityReport, ctx?: { sessionId: string; host: string; wsPath: string; probePath: string }): void {
    container.replaceChildren()
    const title = document.createElement('h4')
    title.textContent = `${report.ip}:${report.port} · IP 质量报告`
    container.appendChild(title)
    const description = document.createElement('p')
    description.textContent = `生成于 ${fmtHistoryTime(report.generatedAt)} · 样本 ${report.history.testCount} 次。`
    container.appendChild(description)
    if (ctx) {
      const actions = document.createElement('div')
      actions.style.display = 'flex'
      actions.style.gap = '8px'
      actions.style.margin = '8px 0'
      const reBtn = document.createElement('button')
      reBtn.type = 'button'
      reBtn.className = 'btn btn-ghost'
      reBtn.textContent = '重新检测此 IP'
      reBtn.title = '对该 IP 跑一遍分层复测（TCP/TLS/WS+PING/真实隧道）并刷新 IP 纯净度，结论写回历史'
      reBtn.addEventListener('click', async () => {
        reBtn.disabled = true
        description.textContent = '正在检测（分层复测 + IP 纯净度，约 15~40 秒）…'
        try {
          const res = await window.cfpilot.runQualityCheck({
            sessionId: ctx.sessionId, ip: report.ip, port: report.port,
          })
          if (!res.ok || !res.report) { description.textContent = '重新检测失败：' + (res.error || '未知错误'); return }
          renderIPQualityReport(container, res.report, ctx)
        } catch (error) { description.textContent = '重新检测失败：' + (error instanceof Error ? error.message : String(error)) }
        finally { reBtn.disabled = false }
      })
      const egressBtn = document.createElement('button')
      egressBtn.type = 'button'
      egressBtn.className = 'btn btn-ghost'
      egressBtn.textContent = '识别本机出口'
      egressBtn.title = '通过你自己的 HTTPS 识别服务，观察本机网络（或指定 SOCKS5 路径）的对外出口；不是候选 IP 的出口'
      egressBtn.addEventListener('click', async () => {
        const serviceUrl = window.prompt('出口识别服务 HTTPS 地址（返回 JSON 的 remote_ip / observed_at）', '')
        if (!serviceUrl) return
        egressBtn.disabled = true
        try {
          const res = await window.cfpilot.identifyEgress({ sessionId: ctx.sessionId, ip: report.ip, port: report.port, serviceUrl })
          if (!res.ok) { description.textContent = '出口识别失败：' + (res.error || '未知错误'); return }
          const fresh = await window.cfpilot.getIPQualityReport({ sessionId: ctx.sessionId, ip: report.ip, port: report.port })
          if (fresh.ok && fresh.report) renderIPQualityReport(container, fresh.report, ctx)
        } catch (error) { description.textContent = '出口识别失败：' + (error instanceof Error ? error.message : String(error)) }
        finally { egressBtn.disabled = false }
      })
      const compatBtn = document.createElement('button')
      compatBtn.type = 'button'
      compatBtn.className = 'btn btn-ghost'
      compatBtn.textContent = '检测目标站兼容性'
      compatBtn.title = '穿该候选的隧道访问你指定的目标站（host[:port]/path），观察是否被挑战或拒绝；需要隧道 UUID'
      compatBtn.addEventListener('click', async () => {
        const spec = window.prompt('目标站（格式 host[:port]/path，缺省端口 443）', 'example.com:80/')
        if (!spec) return
        const uuid = window.prompt('隧道 UUID（VLESS 凭据，仅用于本次检测，不保存）', '')
        if (!uuid) return
        const expectedText = window.prompt('可选正文标记（留空则不校验正文）', '') || undefined
        compatBtn.disabled = true
        try {
          const res = await window.cfpilot.probeTunnelCompatibility({
            sessionId: ctx.sessionId, ip: report.ip, port: report.port, host: ctx.host, wsPath: ctx.wsPath,
            uuid, targets: [{ label: spec, spec, expectedText }],
          })
          if (!res.ok) { description.textContent = '兼容性检测失败：' + (res.error || '未知错误'); return }
          const fresh = await window.cfpilot.getIPQualityReport({ sessionId: ctx.sessionId, ip: report.ip, port: report.port })
          if (fresh.ok && fresh.report) renderIPQualityReport(container, fresh.report, ctx)
        } catch (error) { description.textContent = '兼容性检测失败：' + (error instanceof Error ? error.message : String(error)) }
        finally { compatBtn.disabled = false }
      })
      actions.appendChild(reBtn)
      actions.appendChild(egressBtn)
      actions.appendChild(compatBtn)
      container.appendChild(actions)
    }
    const metric = document.createElement('div')
    const rate = Math.max(0, Math.min(1, report.history.successRate))
    metric.textContent = `已保留样本成功率 ${(rate * 100).toFixed(1)}%（非全部候选通过率）`
    const meter = document.createElement('progress')
    meter.max = 1
    meter.value = rate
    meter.style.width = '100%'
    meter.setAttribute('aria-label', '已保留样本成功率')
    metric.appendChild(meter)
    container.appendChild(metric)

    const statusLabels: Record<QualityFieldStatus, string> = { available: '可用', not_run: '未执行', not_implemented: '尚未实现', failed: '失败', stale: '已过期' }
    const groups: Array<{ key: string; label: string }> = [
      { key: 'basic', label: '基础连接' },
      { key: 'protocol', label: '协议验证' },
      { key: 'performance', label: '性能' },
      { key: 'purity', label: 'IP 纯净度' },
      { key: 'egress', label: '出口' },
      { key: 'compatibility', label: '目标站兼容性' },
      { key: 'history', label: '历史' },
    ]
    // 左栏放连接与性能，右栏放纯净度、出口、兼容性与历史，中间竖线分隔。
    const leftKeys = ['basic', 'protocol', 'performance']
    const layout = document.createElement('div')
    layout.className = 'quality-layout'
    const left = document.createElement('div')
    left.className = 'quality-col'
    const right = document.createElement('div')
    right.className = 'quality-col'
    layout.appendChild(left)
    layout.appendChild(right)
    container.appendChild(layout)

    for (const group of groups) {
      const fields = report.fields.filter((item) => item.name.split('.')[0] === group.key)
      if (fields.length === 0) continue
      const host = leftKeys.includes(group.key) ? left : right
      const heading = document.createElement('strong')
      heading.className = 'quality-group-title'
      heading.textContent = group.label
      host.appendChild(heading)
      for (const field of fields) {
        const info = QUALITY_FIELD_INFO[field.name]
        const row = document.createElement('div')
        row.className = 'quality-row'
        const label = document.createElement('span')
        label.className = 'q-label'
        label.textContent = info?.label || field.name
        if (info) label.setAttribute('data-tip', info.tip)
        const value = document.createElement('span')
        const numeric = typeof field.value === 'number' && Number.isFinite(field.value)
        const raw = field.value === undefined || field.value === null ? '—' : typeof field.value === 'boolean' ? (field.value ? '通过' : '未通过') : String(field.value)
        if (info && info.kind === 'percent' && numeric) {
          // 成功率是 0~1 的比例，展示成百分比。
          value.textContent = `${(field.value as number * 100).toFixed(1)} %`
          value.className = 'q-value'
        } else if (info && info.unit && numeric && info.kind !== 'text') {
          value.textContent = `${raw} ${info.unit}`
          value.className = 'q-value ' + (info.kind === 'speed' ? speedColor(field.value as number) : latencyColor(field.value as number, info.kind))
        } else {
          value.textContent = raw
          value.className = 'q-value'
        }
        if (field.status === 'failed') value.classList.add('quality-bad')
        else if (field.status !== 'available') value.classList.add('quality-note')
        const note = document.createElement('span')
        note.className = 'q-note'
        note.textContent = statusLabels[field.status] || field.status
        if (field.reason) note.textContent += ' · ' + field.reason
        row.appendChild(label)
        row.appendChild(value)
        row.appendChild(note)
        host.appendChild(row)
      }
    }

    // 场景适配：单列展示每个场景的结论与理由（比挤成一行可读得多）。
    const scenarios = report.purity?.scenarios ?? []
    if (scenarios.length > 0) {
      const box = document.createElement('div')
      box.className = 'quality-scenarios'
      const title = document.createElement('strong')
      title.className = 'quality-group-title'
      title.textContent = '场景适配（按信誉画像推导）'
      box.appendChild(title)
      const note = document.createElement('p')
      note.className = 'tip'
      note.textContent = '⚠️ 这是入口 IP 的信誉推导结论，不是实测解锁结果；目标站看到的是出口 IP。'
      box.appendChild(note)
      for (const sc of scenarios) {
        const row = document.createElement('div')
        row.className = 'quality-row'
        const label = document.createElement('span')
        label.className = 'q-label'
        label.textContent = sc.label
        const verdict = document.createElement('span')
        verdict.className = 'q-value'
        const verdictText =
          sc.verdict === 'good' ? '适合' : sc.verdict === 'caution' ? '谨慎' : sc.verdict === 'bad' ? '不适合' : '未知'
        verdict.textContent = verdictText
        if (sc.verdict === 'good') verdict.style.color = 'var(--ok, #34d399)'
        else if (sc.verdict === 'caution') verdict.style.color = 'var(--warn, #fbbf24)'
        else if (sc.verdict === 'bad') verdict.style.color = 'var(--err, #f87171)'
        else verdict.classList.add('quality-note')
        row.appendChild(label)
        row.appendChild(verdict)
        if (sc.reason) {
          const reason = document.createElement('span')
          reason.className = 'q-note'
          reason.textContent = sc.reason
          row.appendChild(reason)
        }
        box.appendChild(row)
      }
      container.appendChild(box)
    }

    const trend = document.createElement('div')
    trend.setAttribute('aria-label', '历史测试趋势，绿色成功，红色失败')
    trend.style.display = 'flex'
    trend.style.gap = '3px'
    trend.style.marginTop = '12px'
    trend.style.alignItems = 'end'
    for (const point of report.history.trend.slice(-60)) {
      const bar = document.createElement('span')
      bar.style.width = '8px'
      bar.style.height = point.ok ? '24px' : '10px'
      bar.style.backgroundColor = point.ok ? 'var(--ok, #34d399)' : 'var(--err, #f87171)'
      bar.title = `${fmtHistoryTime(point.at)} · ${point.kind === 'scan' ? '优选' : '复测'} · ${point.ok ? '通过' : '失败'}`
      trend.appendChild(bar)
    }
    right.appendChild(trend)

    // 悬浮气泡：说明字段定义、来源、影响与参考值。
    const tip = document.createElement('div')
    tip.className = 'quality-tip'
    tip.style.display = 'none'
    document.body.appendChild(tip)
    const hideTip = (): void => { tip.style.display = 'none' }
    container.addEventListener('mouseover', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-tip]') as HTMLElement | null
      if (!target) return
      tip.textContent = target.getAttribute('data-tip') || ''
      tip.style.display = 'block'
    })
    container.addEventListener('mousemove', (event) => {
      if (tip.style.display === 'none') return
      const pad = 14
      const rect = tip.getBoundingClientRect()
      let left = event.clientX + pad
      let top = event.clientY + pad
      if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - pad
      if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - pad
      tip.style.left = Math.max(8, left) + 'px'
      tip.style.top = Math.max(8, top) + 'px'
    })
    container.addEventListener('mouseout', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-tip]') as HTMLElement | null
      if (target) hideTip()
    })
  }

  /**
   * 被勾选的条目（**跨会话**，按会话倒序取首次出现）。
   *
   * 同一 IP 出现在多次优选里时只保留**最近一次**那条 —— 指标更新，
   * 复制出来的备注也才不会重复。
   */
  function selectedHistoryPairs(): Array<{ sess: ScanHistorySession; entry: ScanHistoryEntry }> {
    const out: Array<{ sess: ScanHistorySession; entry: ScanHistoryEntry }> = []
    const seen = new Set<string>()
    for (const sess of historySessions) {
      for (const entry of sess.entries) {
        const key = historyKey(entry.ip, entry.port)
        if (!historyChecked.has(key) || seen.has(key)) continue
        seen.add(key)
        out.push({ sess, entry })
      }
    }
    return out
  }

  function selectedHistoryEntries(): ScanHistoryEntry[] {
    return selectedHistoryPairs().map((p) => p.entry)
  }

  function updateHistoryButtons(): void {
    const hasSel = selectedHistoryEntries().length > 0
    const copyBtn = document.getElementById('btnHistoryCopy') as HTMLButtonElement | null
    const reBtn = document.getElementById('btnHistoryRetest') as HTMLButtonElement | null
    if (copyBtn) copyBtn.disabled = !hasSel
    if (reBtn) reBtn.disabled = !hasSel
  }

  function bindHistory(): void {
    const refresh = document.getElementById('btnHistoryRefresh') as HTMLButtonElement | null
    refresh?.addEventListener('click', () => void loadScanHistory())

    // 复制选中 IP：每行 IP:Port#机房，可直接粘回面板「手动优选 IP」
    const copyBtn = document.getElementById('btnHistoryCopy') as HTMLButtonElement | null
    copyBtn?.addEventListener('click', () => {
      const sel = selectedHistoryEntries()
      if (sel.length === 0) {
        log('请先在历史里勾选 IP', 'warn')
        return
      }
      // 每行 `IP:Port#备注`，备注与面板回填**完全同格式**：
      //   `[2606:4700::1]:443#IPv6_SJC圣何塞_491_6.12`
      //   `104.16.1.1:443#IPv4_LAX洛杉矶_120_35.5`
      //
      // 三个细节缺一不可：
      //   1. IPv6 必须带方括号 —— 否则 `2606:4700::1:443` 无法解析成 host:port；
      //   2. 必须带族标记（`IPv4_`/`IPv6_`）—— 订阅节点名前缀与面板分族都靠它；
      //   3. 必须带**延迟与速度两个数字** —— 面板的 `parseScannerRemark`
      //      靠「末尾两个连续数字」识别这是优选结果，少一个就会把速度当延迟，
      //      机房 / 延迟 / 速度三列与国家筛选一起失效。
      const lines = sel.map((e) => {
        const host = e.ip.includes(':') ? '[' + e.ip + ']' : e.ip
        const family = e.ip.includes(':') ? 'IPv6' : 'IPv4'
        const tag = (e.colo || 'CF') + (e.city || '')
        const latency = Number.isFinite(e.latency) && e.latency > 0 ? Math.round(e.latency) : 0
        const speed = Number.isFinite(e.speed) && e.speed > 0 ? e.speed : 0
        return host + ':' + e.port + '#' + family + '_' + tag + '_' + latency + '_' + speed
      })
      copy(lines.join('\n'))
      log('已复制 ' + sel.length + ' 个 IP（IP:Port#族_机房_延迟_速度）', 'ok')
    })

    // 复测选中：分层校验（TCP → TLS → WS101，可选测速），结论写回历史
    const reBtn = document.getElementById('btnHistoryRetest') as HTMLButtonElement | null
    const hint = document.getElementById('historyHint')
    reBtn?.addEventListener('click', async () => {
      const pairs = selectedHistoryPairs()
      if (pairs.length === 0) {
        log('请先勾选要复测的 IP', 'warn')
        return
      }

      // 按会话分组：复测必须用**该次会话**保存的域名 / WS 路径。
      // 跨批次勾选时每组各用各的参数，否则会打到错误的 SNI 上。
      const groups = new Map<
        string,
        { sess: ScanHistorySession; targets: Array<{ ip: string; port: number }> }
      >()
      for (const { sess, entry } of pairs) {
        let group = groups.get(sess.id)
        if (!group) {
          group = { sess, targets: [] }
          groups.set(sess.id, group)
        }
        group.targets.push({ ip: entry.ip, port: entry.port })
      }

      const total = pairs.length
      const withSpeed = $('optHistorySpeed').checked
      if (reBtn) reBtn.disabled = true
      let okCount = 0
      let doneCount = 0
      const failures: string[] = []
      try {
        for (const { sess, targets } of groups.values()) {
          if (hint) {
            hint.textContent =
              '正在复测 ' + targets.length + ' 个 IP…（' + sess.host +
              '，剩余 ' + pairs.length + ' 个，每 IP 最多约 ' + (withSpeed ? '10' : '6') + ' 秒）'
          }
          try {
            const res = await window.cfpilot.reTestIps({
              sessionId: sess.id,
              // ⚠️ 必须用历史会话保存的参数，不是当前表单 ——
              // 否则改过表单后复测会打到错误的域名 / 路径上。
              host: sess.host,
              wsPath: sess.wsPath,
              probePath: sess.probePath,
              withSpeed,
              // 复测也做 PING/PONG 内容校验（打探针端点），结论进质量报告
              verifyPayload: true,
              targets,
            })
            if (!res || !res.ok) {
              failures.push((res && res.error) || '未知错误')
              continue
            }
            const results = res.results ?? []
            // 把结论写进本地状态并重绘（后端也已写回历史文件）
            for (const r of results) {
              doneCount += 1
              if (r.ok) okCount += 1
              const e = sess.entries.find((x) => x.ip === r.ip && x.port === r.port)
              if (e) {
                e.lastTest = {
                  at: new Date().toISOString(),
                  tcpMs: r.tcpMs,
                  tlsMs: r.tlsMs,
                  wsOk: r.wsOk,
                  colo: r.colo,
                  speed: r.speed,
                  pongVerified: r.pongVerified ?? null,
                  tunnelOk: r.tunnelOk ?? null,
                  tunnelStage: r.tunnelStage,
                  ok: r.ok,
                  error: r.error,
                }
              }
            }
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err))
          }
        }

        if (failures.length > 0) {
          const msg = failures[0] ?? '未知错误'
          if (hint) {
            hint.textContent =
              (doneCount > 0 ? '✅ 已复测 ' + doneCount + '/' + total + ' 个，' : '') +
              '有 ' + failures.length + ' 个批次失败：' + msg
          }
          log('复测部分失败：' + msg, 'err')
        } else {
          if (hint) hint.textContent = '✅ 复测完成：' + okCount + '/' + doneCount + ' 可用。'
          log('复测完成：' + okCount + '/' + doneCount + ' 个 IP 可用', okCount > 0 ? 'ok' : 'warn')
        }
        renderScanHistory()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (hint) hint.textContent = '复测失败：' + msg
        log('复测失败：' + msg, 'err')
      } finally {
        if (reBtn) reBtn.disabled = false
        updateHistoryButtons()
      }
    })

    // 切到优选页时拉一次（首次进入也加载）
    void loadScanHistory()
  }

  /* ------------------------------------------------------------------ */
  /* 优选页：二级页签 / 候选来源 / 反代优选                                */
  /* ------------------------------------------------------------------ */

  /** 当前选中的优选方向 */
  let scanTab: 'entry' | 'relay' | 'task' = 'entry'
  /** 候选来源：默认（网段采样 / 内置清单）或自定义列表 */
  let sourceMode: 'default' | 'custom' = 'default'
  /** 反代体检「全通可取」的 IP（回填按钮用） */
  let relayPicked: string[] = []

  function bindScanSubtabs(): void {
    const nav = document.getElementById('scanTabs')
    if (!nav) return
    nav.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest(
        'button[data-scan-tab]'
      ) as HTMLButtonElement | null
      if (!btn) return
      const raw = btn.dataset.scanTab
      const next: 'entry' | 'relay' | 'task' =
        raw === 'relay' ? 'relay' : raw === 'task' ? 'task' : 'entry'
      if (next === scanTab) return
      scanTab = next
      for (const b of nav.querySelectorAll('button[data-scan-tab]')) {
        b.classList.toggle('active', (b as HTMLElement).dataset.scanTab === next)
      }
      const entryPanel = document.getElementById('scanPanelEntry')
      const relayPanel = document.getElementById('scanPanelRelay')
      const taskPanel = document.getElementById('scanPanelTask')
      if (entryPanel) entryPanel.hidden = next !== 'entry'
      if (relayPanel) relayPanel.hidden = next !== 'relay'
      if (taskPanel) taskPanel.hidden = next !== 'task'

      // 「① 数据面与候选来源」在**定时任务页签**下隐藏：
      // 定时任务自己会从账号的部署清单取数据面域名与 WS 路径，
      // 让用户在这里填一遍只会误导（填了也不生效）。
      const sourceCard = document.getElementById('sourceCard')
      if (sourceCard) sourceCard.hidden = next === 'task'

      // 入口方向的两张产物卡（结果 / 自适应对照）在反代页签下**收起**：
      // 它们只跟入口优选有关，留在反代页里既占地方又容易看错。
      // 反代的结果卡本身在 scanPanelRelay 内部，随面板一起切换。
      const entryResult = document.getElementById('entryResultCard')
      const adaptiveCard = document.getElementById('adaptiveCard')
      if (entryResult) entryResult.hidden = next !== 'entry'
      if (adaptiveCard) adaptiveCard.hidden = next !== 'entry'

      // 定时任务页首次进入时拉一次清单与 IP 池。
      if (next === 'task') void loadScheduledTasks()
    })
  }

  /** 读当前候选文本框的内容 */
  function candidateText(): string {
    const el = document.getElementById('optCandidateText') as HTMLTextAreaElement | null
    return el ? el.value : ''
  }

  /**
   * 更新「已识别 N 个」提示。
   *
   * 提交前先看计数，避免「粘了 1000 行结果只认了 3 个」这种静默失败。
   */
  async function refreshCandidateHint(): Promise<void> {
    const hint = document.getElementById('candidateHint')
    if (!hint) return
    const raw = candidateText().trim()
    if (!raw) {
      hint.textContent = '粘贴或导入后这里会显示识别结果。'
      return
    }
    try {
      // 通用解析器同时接受 IP 与域名；反代链路那个只数 IPv4 的接口不再用于预览
      const res = await window.cfpilot.parseScanCandidates(raw)
      if (res.over) {
        hint.textContent =
          '已识别 ' + res.count + ' 个候选（IP 或域名），超过上限 ' + (res.limit || 0) + ' 个 —— 请分批'
      } else {
        hint.textContent = '已识别 ' + res.count + ' 个候选（IP 或域名）'
      }
    } catch (err) {
      hint.textContent = '识别失败：' + (err instanceof Error ? err.message : String(err))
    }
  }

  function bindCandidateSource(): void {
    const modeSel = document.getElementById('optSourceMode') as HTMLSelectElement | null
    const box = document.getElementById('customSourceBox')
    const text = document.getElementById('optCandidateText') as HTMLTextAreaElement | null

    const syncBox = (): void => {
      sourceMode = modeSel && modeSel.value === 'custom' ? 'custom' : 'default'
      if (box) box.hidden = sourceMode !== 'custom'
      const custom = sourceMode === 'custom'
      // 采样预算类参数只在「默认（网段采样）」下被消费：后端 scan_routes.go
      // 仅在 len(candidates)==0 时调用 sampleCandidates，自定义列表时静默忽略。
      // 置灰比让用户填了却没反应更诚实；用 .disabled 属性，切回默认可恢复。
      ;['optSample', 'optFamily'].forEach((id) => {
        const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
        if (!el) return
        el.disabled = custom
        el.closest('.field')?.classList.toggle('is-disabled', custom)
      })
      const hint = document.getElementById('srcModeParamsHint')
      if (hint) hint.hidden = !custom
      const expHint = document.getElementById('expModeHint')
      if (expHint) expHint.hidden = !custom
    }
    modeSel?.addEventListener('change', syncBox)
    syncBox()

    let timer: ReturnType<typeof setTimeout> | null = null
    text?.addEventListener('input', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refreshCandidateHint(), 350)
    })

    // 本地文件：纯前端读取（FileReader），不经过后端
    const fileInput = document.getElementById('fileImportInput') as HTMLInputElement | null
    document.getElementById('btnImportFile')?.addEventListener('click', () => fileInput?.click())
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        if (text) text.value = String(reader.result ?? '')
        void refreshCandidateHint()
        log('已导入文件：' + file.name, 'ok')
      }
      reader.onerror = () => log('读取文件失败', 'err')
      reader.readAsText(file)
      fileInput.value = ''
    })

    // 远程链接：交给**后端**拉取（界面直连会被 CORS 拦掉）
    document.getElementById('btnImportUrl')?.addEventListener('click', () => {
      const url = window.prompt('清单链接（http/https，上限 2MB）')
      if (!url) return
      void (async () => {
        const hint = document.getElementById('candidateHint')
        if (hint) hint.textContent = '正在拉取…'
        try {
          const res = await window.cfpilot.fetchRelayCandidates(url)
          if (!res.ok) {
            if (hint) hint.textContent = '导入失败：' + (res.error || '未知错误')
            return
          }
          if (text) text.value = res.raw || ''
          await refreshCandidateHint()
          log('已从链接导入 ' + (res.count || 0) + ' 个候选（IP 或域名）', 'ok')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (hint) hint.textContent = '导入失败：' + msg
        }
      })()
    })

    // 「加载数据源清单」：从数据源页的链接里多选，合并原文填入候选框。
    // 原来的「加载内置清单」只加载随版本发布、用户改不了的反代清单，
    // 与「候选来源 = 默认」功能重复；现在改成挑数据源，且数据源本身可增删改查。
    const sourceListMask = document.getElementById('sourceListModal')
    const sourceListBody = document.getElementById('sourceListBody')
    const sourceListCount = document.getElementById('sourceListCount')
    const esc = (s: string): string =>
      s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c] || c)

    const updateSourceListCount = (): void => {
      const picked = sourceListBody
        ? sourceListBody.querySelectorAll<HTMLInputElement>('input[data-src-id]:checked').length
        : 0
      if (sourceListCount) sourceListCount.textContent = '已选 ' + picked + ' 个来源'
    }

    const renderSourceList = (list: Array<{ id: string; name: string }>): void => {
      if (!sourceListBody) return
      if (list.length === 0) {
        sourceListBody.innerHTML = '<p class="country-empty">（还没有数据源，请到「数据源」页添加）</p>'
        updateSourceListCount()
        return
      }
      sourceListBody.innerHTML = list
        .map((s) =>
          '<label data-src-row="' + escapeHtml(s.name) + '" style="display:flex;align-items:center;gap:8px;padding:5px 2px;cursor:pointer">' +
          '<input type="checkbox" data-src-id="' + escapeHtml(s.id) + '" />' +
          '<span>' + escapeHtml(s.name) + '</span></label>'
        )
        .join('')
      sourceListBody.querySelectorAll<HTMLInputElement>('input[data-src-id]').forEach((box) => {
        box.addEventListener('change', updateSourceListCount)
      })
      updateSourceListCount()
    }

    const closeSourceListModal = (): void => {
      if (sourceListMask) sourceListMask.hidden = true
    }

    const openSourceListModal = (): void => {
      if (sourceListMask) sourceListMask.hidden = false
      const search = document.getElementById('sourceListSearch') as HTMLInputElement | null
      if (search) search.value = ''
      if (sourceListBody) sourceListBody.innerHTML = '<p class="country-empty">（正在加载数据源…）</p>'
      void (async () => {
        try {
          const res = await window.cfpilot.sourcesList()
          const list = (res?.config?.sources || []).map((s) => ({ id: s.id, name: s.name || s.id }))
          renderSourceList(list)
        } catch (err) {
          if (sourceListBody) {
            sourceListBody.innerHTML =
              '<p class="country-empty">加载失败：' + escapeHtml(err instanceof Error ? err.message : String(err)) + '</p>'
          }
        }
      })()
    }

    document.getElementById('sourceListSearch')?.addEventListener('input', (ev) => {
      const q = String((ev.target as HTMLInputElement).value || '').trim().toLowerCase()
      sourceListBody?.querySelectorAll<HTMLElement>('[data-src-row]').forEach((row) => {
        row.style.display = (row.getAttribute('data-src-row') || '').toLowerCase().includes(q) ? '' : 'none'
      })
    })
    const setAllSources = (checked: boolean): void => {
      sourceListBody?.querySelectorAll<HTMLInputElement>('input[data-src-id]').forEach((box) => {
        box.checked = checked
      })
      updateSourceListCount()
    }
    document.getElementById('btnSourceListAll')?.addEventListener('click', () => setAllSources(true))
    document.getElementById('btnSourceListNone')?.addEventListener('click', () => setAllSources(false))
    document.getElementById('btnSourceListClose')?.addEventListener('click', closeSourceListModal)
    document.getElementById('btnSourceListCancel')?.addEventListener('click', closeSourceListModal)
    sourceListMask?.addEventListener('click', (ev) => {
      if (ev.target === sourceListMask) closeSourceListModal()
    })

    document.getElementById('btnSourceListApply')?.addEventListener('click', () => {
      const boxes = sourceListBody
        ? Array.from(sourceListBody.querySelectorAll<HTMLInputElement>('input[data-src-id]:checked'))
        : []
      const ids = boxes.map((box) => box.getAttribute('data-src-id') || '').filter(Boolean)
      const hint = document.getElementById('candidateHint')
      if (ids.length === 0) {
        if (hint) hint.textContent = '请先勾选至少一个数据源。'
        return
      }
      if (hint) hint.textContent = '正在拉取 ' + ids.length + ' 个数据源清单…'
      closeSourceListModal()
      void (async () => {
        try {
          const res = await window.cfpilot.sourcesFetchCandidates(ids)
          if (!res.ok || !res.raw) {
            if (hint) hint.textContent = '加载失败：' + ((res.errors && res.errors[0]) || '没有拿到清单内容')
            return
          }
          if (text) text.value = res.raw
          if (modeSel) {
            modeSel.value = 'custom'
            syncBox()
          }
          await refreshCandidateHint()
          log('已从 ' + (res.selected || ids.length) + ' 个数据源加载 ' + res.count + ' 个候选', 'ok')
          if ((res.dropped || 0) > 0) {
            log(
              '清单太长，只加载了前 ' + res.count + ' 行（还有 ' + (res.dropped || 0) + ' 行未加载）—— 请分批加载',
              'warn'
            )
          }
          if (res.truncated) log('一次最多加载 30 个来源，多选项未生效', 'warn')
          if (res.errors && res.errors.length > 0) log('部分来源失败：' + res.errors.join('；'), 'warn')
        } catch (err) {
          if (hint) hint.textContent = '加载失败：' + (err instanceof Error ? err.message : String(err))
        }
      })()
    })

    document.getElementById('btnLoadSourceList')?.addEventListener('click', openSourceListModal)
  }

  /** 渲染反代体检结果表 */
  function renderRelayResult(payload: CFPilotRelayResult): void {
    const out = document.getElementById('relayOut')
    const pushHint = document.getElementById('relayPushHint')
    const appendBtn = document.getElementById('btnRelayPushAppend') as HTMLButtonElement | null
    const overBtn = document.getElementById('btnRelayPushOverwrite') as HTMLButtonElement | null
    const copyBtn = document.getElementById('btnRelayCopy') as HTMLButtonElement | null

    relayPicked = payload.picked ?? []
    const hasPicked = relayPicked.length > 0
    if (appendBtn) appendBtn.disabled = !hasPicked
    if (overBtn) overBtn.disabled = !hasPicked
    if (copyBtn) copyBtn.disabled = !hasPicked

    if (!payload.ok) {
      if (out) out.textContent = '体检失败：' + (payload.error || '未知错误')
      return
    }
    if (!out) return

    out.textContent = ''
    const head = document.createElement('p')
    head.className = 'hint'
    head.textContent =
      '全通 ' + (payload.alwaysOk ?? 0) +
      ' · 抖动 ' + (payload.flaky ?? 0) +
      ' · 全挂 ' + (payload.neverOk ?? 0) +
      ' · 期望 build ' + (payload.expectedBuild ?? '—')
    out.appendChild(head)

    const table = document.createElement('table')
    const thead = document.createElement('thead')
    thead.innerHTML =
      '<tr><th>#</th><th>IP</th><th>成功%</th><th>轮次</th><th>隧道(ms)</th>' +
      '<th>TLS(ms)</th><th>TLSP95</th><th>HTTP(ms)</th><th>失败原因</th></tr>'
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const [index, entry] of (payload.entries ?? []).entries()) {
      const tr = document.createElement('tr')
      const cells = [
        String(index + 1),
        entry.ip,
        String(entry.successPct),
        entry.passed + '/' + entry.rounds,
        String(entry.tunnelMs),
        String(entry.tlsMs),
        String(entry.tlsP95),
        String(entry.httpMs),
        (entry.errors && entry.errors[0]) || '',
      ]
      for (const cell of cells) {
        const td = document.createElement('td')
        td.textContent = cell
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    out.appendChild(table)

    if (pushHint) {
      pushHint.textContent = hasPicked
        ? '可写入 ' + relayPicked.length + ' 条（只含全通项）'
        : '没有全通项，无法写入'
    }
  }

  function bindRelay(): void {
    const uuidInput = document.getElementById('optRelayUuid') as HTMLInputElement | null

    document.getElementById('btnRelayFetchUuid')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await window.cfpilot.relayUUID()
          if (!res.ok) {
            log('读取 UUID 失败：' + (res.error || '未知错误'), 'err')
            return
          }
          if (uuidInput && res.uuid) uuidInput.value = res.uuid
          log('已从面板读取 UUID', 'ok')
        } catch (err) {
          log('读取 UUID 失败：' + (err instanceof Error ? err.message : String(err)), 'err')
        }
      })()
    })

    document.getElementById('btnRelayRun')?.addEventListener('click', () => {
      void (async () => {
        const host = $('optHost').value.trim()
        const path = $('optPath').value.trim()
        const uuid = uuidInput ? uuidInput.value.trim() : ''
        if (!host || !path) {
          log('请先填写 Worker 域名与 WS 路径（两个方向共用）', 'warn')
          return
        }
        if (!uuid) {
          log('请填写 UUID，或点「从面板读取」', 'warn')
          return
        }
        // 候选来源为「默认」时用内置清单（随版本发布），不需要用户填任何东西；
        // 选「自定义列表」时才要求有内容。
        const useBuiltin = sourceMode === 'default'
        const raw = candidateText().trim()
        if (!useBuiltin && !raw) {
          log('候选来源选了「自定义列表」但内容为空：请粘贴/导入 IP，或切回「默认」用内置清单', 'warn')
          return
        }

        const wrap = document.getElementById('relayProgressWrap')
        const bar = document.getElementById('relayBar')
        const progressText = document.getElementById('relayProgressText')
        if (wrap) wrap.hidden = false
        if (bar) bar.style.width = '0%'
        if (progressText) progressText.textContent = '正在启动…'
        const out = document.getElementById('relayOut')
        if (out) out.textContent = '正在体检，请稍候…'
        try {
          const res = await window.cfpilot.runRelay({
            host,
            wsPath: path,
            uuid,
            rounds: Number($('optRelayRounds').value) || 2,
            top: Number($('optRelayTop').value) || 10,
            timeoutMs: Number($('optRelayTimeout').value) || 12000,
            candidates: useBuiltin ? '' : raw,
          })
          if (!res.ok) {
            log('启动失败：' + (res.error || '未知错误'), 'err')
            if (out) out.textContent = '启动失败：' + (res.error || '')
            return
          }
          log('反代体检已启动：' + (res.count || 0) + ' 个候选', 'ok')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log('启动失败：' + msg, 'err')
          if (out) out.textContent = '启动失败：' + msg
        }
      })()
    })

    document.getElementById('btnRelayCancel')?.addEventListener('click', () => {
      void (async () => {
        try {
          await window.cfpilot.cancelRelay()
          log('已请求取消', 'warn')
        } catch {
          /* 没有进行中的任务 */
        }
      })()
    })

    const pushTo = (mode: 'incremental' | 'overwrite'): void => {
      void (async () => {
        if (relayPicked.length === 0) {
          log('没有可写入的 IP', 'warn')
          return
        }
        const hint = document.getElementById('relayPushHint')
        try {
          const res = await window.cfpilot.pushRelayResults(relayPicked, mode)
          if (!res.ok) {
            if (hint) hint.textContent = '写入失败：' + (res.error || '未知错误')
            return
          }
          if (hint) {
            hint.textContent =
              '✅ 已写入 ' + (res.written ?? relayPicked.length) + ' 条，池内共 ' + (res.total ?? '?') + ' 条'
          }
          log('已写入面板反代入口池（' + (mode === 'incremental' ? '增量' : '覆盖') + '）', 'ok')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (hint) hint.textContent = '写入失败：' + msg
        }
      })()
    }
    document
      .getElementById('btnRelayPushAppend')
      ?.addEventListener('click', () => pushTo('incremental'))
    document
      .getElementById('btnRelayPushOverwrite')
      ?.addEventListener('click', () => pushTo('overwrite'))
    document.getElementById('btnRelayCopy')?.addEventListener('click', () => {
      if (relayPicked.length === 0) return
      copy(relayPicked.join('\n'))
    })

    window.cfpilot.onRelayProgress?.((p) => {
      const bar = document.getElementById('relayBar')
      const text = document.getElementById('relayProgressText')
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
      if (bar) bar.style.width = pct + '%'
      if (text) text.textContent = '进度 ' + p.done + '/' + p.total + ' · ' + p.ip + (p.ok ? ' ✓' : ' ✗')
    })
    window.cfpilot.onRelayResult?.((payload) => {
      renderRelayResult(payload)
      const bar = document.getElementById('relayBar')
      if (bar) bar.style.width = payload.ok ? '100%' : '0%'
      const text = document.getElementById('relayProgressText')
      if (text) text.textContent = payload.ok ? '已完成' : '未完成'
    })
  }

  /* ------------------------------------------------------------------ */
  /* 日志页                                                              */
  /* ------------------------------------------------------------------ */

  /** 日志是否已经成功加载过一次（切页时据此决定要不要自动拉） */
  let logsLoaded = false

  /** 已知的日志文件路径（「打开日志文件所在文件夹」要用） */
  let logsFilePath = ''

  /**
   * 读取并渲染日志页的内容。
   *
   * @param tail 取文件末尾多少行（默认 500；后端上限 5000）
   */
  async function loadLogs(tail = 500): Promise<void> {
    const view = document.getElementById('logsView')
    const badge = document.getElementById('logsBadge')
    if (!view) return

    if (badge) {
      badge.textContent = '加载中…'
      badge.className = 'badge info'
    }

    try {
      const result = await window.cfpilot.getLogs(tail)

      // 后端失败时返回 { ok:false, error }；
      // 适配层在某些错误形态下会直接抛异常，两条路都要处理。
      if (!result || !result.ok) {
        const msg = (result && result.error) || '未知错误'
        if (badge) { badge.textContent = '读取失败'; badge.className = 'badge err' }
        // 后端的错误文案本身常带「读取日志失败：」前缀，别叠两遍
        view.textContent = msg.indexOf('读取日志失败') >= 0 ? msg : '读取日志失败：' + msg
        log('读取日志失败：' + msg, 'err')
        return
      }

      const lines = result.lines ?? []

      // 日志里有 IP、路径、错误详情 —— 逐行转义后再插入，
      // 绝不能把日志原文当 HTML 塞进页面。
      view.innerHTML = lines.length > 0
        ? lines.map((l) => escapeHtml(l)).join('\n')
        : '（日志文件是空的）'

      // 自动滚到底部：用户最关心的是最新几行
      view.scrollTop = view.scrollHeight

      logsLoaded = true
      logsFilePath = result.path ?? ''

      $text('logsPath').textContent = result.path || '—'
      $text('logsSize').textContent =
        result.sizeText || (typeof result.size === 'number' ? result.size + ' 字节' : '—')
      const total = typeof result.total === 'number' ? result.total : lines.length
      $text('logsTotal').textContent = total + ' 行'

      if (badge) { badge.textContent = '已加载'; badge.className = 'badge ok' }

      // 提示：只显示了尾部 / 有轮转出来的历史文件
      const hints: string[] = []
      if (result.truncated) {
        hints.push('文件共 ' + total + ' 行，只显示最后 ' + lines.length + ' 行')
      }
      const rotated = result.rotated ?? []
      if (rotated.length > 0) {
        hints.push('历史日志（已轮转）：' + rotated.join('、'))
      }
      $text('logsHint').textContent =
        hints.length > 0 ? hints.join('；') : '已是最新内容。'

      // 知道路径了才能打开所在文件夹
      const openBtn = document.getElementById('btnLogsOpenFolder') as HTMLButtonElement | null
      if (openBtn) openBtn.disabled = !logsFilePath
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (badge) { badge.textContent = '读取失败'; badge.className = 'badge err' }
      view.textContent = msg.indexOf('读取日志失败') >= 0 ? msg : '读取日志失败：' + msg
      log('读取日志失败：' + msg, 'err')
    }
  }

  /** 绑定日志页的按钮 */
  function bindLogs(): void {
    document.getElementById('btnLogsRefresh')!.addEventListener('click', async () => {
      await loadLogs()
    })

    /**
     * 打开日志文件所在文件夹。
     *
     * 走通用的「在文件管理器中定位文件」接口 ——
     * 后端打开的是传入文件**所在的目录**，所以传日志文件本身即可。
     */
    document.getElementById('btnLogsOpenFolder')!.addEventListener('click', async () => {
      if (!logsFilePath) {
        log('还不知道日志文件路径，请先点「刷新」', 'warn')
        return
      }
      try {
        await window.cfpilot.revealFile(logsFilePath)
        log('已在文件管理器中打开日志目录', 'ok')
      } catch (err) {
        log('打开日志目录失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      }
    })
  }

  let pendingUpdateUrl = ''

  /**
   * 执行一次更新检查并渲染结果。
   *
   * 抽成函数是为了让「说明」页打开时能**自动跑一次** ——
   * 之前只有手点按钮才会检查，用户不点就永远不知道有新版。
   */
  async function runUpdateCheck(quiet = false): Promise<void> {
    const badge = document.getElementById('updateBadge')
    const hint = document.getElementById('updateHint')
    const btn = document.getElementById('btnCheckUpdate') as HTMLButtonElement | null
    if (!badge || !hint) return

    if (!quiet) {
      badge.textContent = '检查中…'
      badge.className = 'badge info'
    }
    if (btn) btn.disabled = true

    try {
      const result = await window.cfpilot.checkUpdate()
      if (result.error) {
        badge.textContent = '检查失败'
        badge.className = 'badge err'
        hint.textContent = '检查失败：' + result.error + '（网络问题，稍后再试）'
        return
      }
      if (!result.hasUpdate) {
        badge.textContent = '已是最新'
        badge.className = 'badge ok'
        hint.textContent = '当前版本 ' + result.current + '，没有新版本。'
        ;(document.getElementById('btnUpdate') as HTMLButtonElement).disabled = true
        return
      }
      badge.textContent = '有新版 ' + (result.latest ?? '')
      badge.className = 'badge warn'
      hint.textContent = '发现新版本 ' + result.latest + '（当前 ' + result.current + '）。点击「下载并安装」。'
      pendingUpdateUrl = result.downloadUrl ?? ''
      ;(document.getElementById('btnUpdate') as HTMLButtonElement).disabled = !pendingUpdateUrl
    } catch (err) {
      badge.textContent = '检查失败'
      badge.className = 'badge err'
      hint.textContent = '检查失败：' + (err instanceof Error ? err.message : String(err))
    } finally {
      if (btn) btn.disabled = false
    }
  }

  function bindUpdater(): void {
    // 说明页自动检查（切到该页时触发）
    autoCheckOnAbout = () => {
      void runUpdateCheck(true)
    }

    document.getElementById('btnCheckUpdate')!.addEventListener('click', async () => {
      await runUpdateCheck(false)
    })

    document.getElementById('btnUpdate')!.addEventListener('click', async () => {
      if (!pendingUpdateUrl) { log('请先检查更新', 'warn'); return }
      if (!confirm('将下载新版本并在替换后重启程序，继续？')) return
      const wrap = document.getElementById('updateProgressWrap')!
      const bar = document.getElementById('updateBar')!
      const text = document.getElementById('updateProgressText')
      wrap.hidden = false
      bar.style.width = '0%'
      if (text) { text.hidden = false; text.textContent = '准备下载…' }
      log('开始下载新版本…')
      try {
        const res = await window.cfpilot.downloadUpdate(pendingUpdateUrl)
        bar.style.width = '100%'
        if (text) text.textContent = '下载完成，正在替换并重启…'
        log('下载完成，正在替换并重启…', 'ok')
        const applied = await window.cfpilot.applyUpdate(res.file)
        if (!applied.ok) log('替换失败：' + (applied.error ?? ''), 'err')
      } catch (err) {
        log('更新失败：' + (err instanceof Error ? err.message : String(err)), 'err')
        if (text) text.textContent = '下载失败（已显示在日志）'
        wrap.hidden = true
      }
    })
  }

  function copy(text: string): void {
    if (!text) { log('没有可复制的内容', 'warn'); return }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => { log('已复制到剪贴板') })
        .catch(() => { fallbackCopy(text) })
    } else {
      fallbackCopy(text)
    }
  }

  function fallbackCopy(text: string): void {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      log('已复制到剪贴板')
    } catch {
      log('复制失败，请手动选择文本', 'warn')
    }
    document.body.removeChild(ta)
  }

  function bindPush(): void {
    window.cfpilot.onLog((entry) => {
      log(entry.message, entry.level as never)
      // 只有「真优选进度日志」才交给进度条：后端 Progress 节流后的文案带
      // 「阶段」或（done/total）计数。⚠️ 不要再按「扫描」二字宽泛匹配 ——
      // 取令牌、回填、体检都会推含「扫描」的日志（如「已自动获取扫描令牌」），
      // 它们没有计数，会把进度条算成兜底的 1%。
      // 是否真正生效还由 updateScanProgress 里的 scanProgressActive 门控决定。
      if (entry.message.includes('阶段') || /（\d+\/\d+）/.test(entry.message)) {
        updateScanProgress(entry.message)
      }
    })

    /**
     * 渲染部署状态，并推导「自动判断」模式下的按钮语义。
     *
     * 交互设计：
     *   - 状态卡只回答「现在什么情况」，不承载操作；
     *   - 「自动判断」的按钮文案随状态变化：
     *       none     → 「开始首次部署」
     *       outdated → 「更新到最新内核」(primary 高亮)
     *       latest   → 「重新部署」(ghost，弱化)
     *   - 用户不需要理解「auto/update/fresh」也能直接用默认的「自动判断」。
     *
     * ⚠️ 这里**不直接改按钮 DOM**：算出的文案存进 autoDeploy*，
     * 由 syncDeployButton() 按当前操作模式统一渲染。
     * 否则切到「更新现有部署 / 全新部署」后，按钮会停留在上次检查状态的文案。
     *
     * ⚠️ 不自动填 optHost：`dataProject` 是**项目名**不是域名，
     * 项目名与子域不保证一致（用户可自定义子域）。
     * 域名走「自动识别域名」按钮读真实 subdomain / 自定义域名。
     */
    // 赋值给前面声明的引用：让「检查部署状态」按钮也能调用同一个渲染逻辑
    applyDeployStatus = (status: DeployStatusLike): void => {
      const tip = document.getElementById('rtTip')

      // 记住这次检测结果：本地快照不再覆盖它（否则点了按钮看不到变化）。
      deployChecked = status
      // 每次检查都从默认语义重新推导，不沿用上一次的按钮文案。
      autoDeployLabel = '开始部署'
      autoDeployPrimary = true
      autoDeployHint = '请先点击「检查部署状态」按钮判断部署操作选择。'

      // ⚠️ 只记录「自动判断」模式下的文案，不直接改按钮 DOM：
      // 用户可能正处在「更新现有部署 / 全新部署」，或稍后切过去，
      // 最终显示什么一律由 syncDeployButton() 按当前模式决定。
      const setBtn = (label: string, primary: boolean): void => {
        autoDeployLabel = label
        autoDeployPrimary = primary
        syncDeployButton()
      }
      const setHint = (text: string): void => {
        autoDeployHint = text
        syncDeployButton()
      }

      /** 运行状态卡片底部的提示（升级建议等）。 */
      const setTip = (text: string, warn = false): void => {
        if (!tip) return
        tip.textContent = text
        tip.style.color = warn ? 'var(--warn)' : ''
        tip.style.fontWeight = warn ? '600' : ''
      }

      if (status.state === 'blocked') {
        // 前置条件不满足：明确告诉用户「缺什么、去哪补」，
        // 绝不能显示成「还没部署」（那会让人以为要重新部署一个新实例）
        const guide: Record<string, { title: string; body: string; action: string }> = {
          'no-token': {
            title: '还没填 API Token',
            body: '检查部署状态需要读取 Cloudflare 上的部署记录，所以需要一个 API Token。',
            action: '去「Cloudflare 凭据」页填写 Token 并保存',
          },
          'no-account': {
            title: '还没检测到账号',
            body: 'Token 已保存，但还没确认它属于哪个账号。',
            action: '去「Cloudflare 凭据」页点「检测账号」',
          },
          'no-kv': {
            title: '还没选择 KV 命名空间',
            body: '部署记录保存在 KV 里，需要先选定是哪一个。',
            action: '去「Cloudflare 凭据」页点「刷新 KV 列表」并选择',
          },
        }
        const g = guide[status.reason ?? 'no-token']!
        setTip(
          '👉 ' + g.title + '：' + g.body + ' ' + g.action,
          true
        )
        renderKernelInfo('无法检测线上状态（需先完成设置）', false, '缺少前置条件时无法读取线上部署状态')
        setBtn('开始部署', true)
        setHint('完成上面的设置后，回来再点一次「检查部署状态」。')
        return
      }

      if (!status.hasDeploy) {
        setTip('当前选中的 KV 里还没有部署记录 —— 点下面的「开始首次部署」即可创建实例。')
        renderKernelInfo('尚未部署', false, '这个 KV 里没有部署记录')
        setBtn('开始首次部署', true)
        setHint('首次部署会生成新的 UUID、WS 路径与面板密码，请存好。')
        return
      }

      // 回填节点域名：**用平台上的真实绑定覆盖**，不是"只在为空时填"。
      //
      // ⚠️ 真机事故（2026-11-02）：填的是**另一个账号**的域名，
      // 用户根本没察觉填错 → 点「更新部署」→ 又写坏一次 DATA_HOST → 节点全 -1。
      //
      // 现在这个值来自后端对**当前账号**的实时查询（Worker 绑定 / workers.dev 兜底），
      // 每次「检查部署状态」都会覆盖一次，用户看到的就是当前账号真实的节点域名。
      const hostInput = document.getElementById('dataHost') as HTMLInputElement | null
      const nodeHost = (status as { nodeHost?: string; nodeHostSource?: string; nodeHostWarning?: string }).nodeHost ?? ''
      const nodeHostSource = (status as { nodeHostSource?: string }).nodeHostSource ?? ''
      const nodeHostWarning = (status as { nodeHostWarning?: string }).nodeHostWarning ?? ''
      if (hostInput && nodeHost) {
        hostInput.value = nodeHost
        const hostTip = document.getElementById('dataHostHint')
        if (hostTip) {
          hostTip.textContent = '来源：' + nodeHostSource + '（每次「检查部署状态」都会按平台实际绑定刷新）'
        }
      } else if (hostInput && nodeHostWarning) {
        const hostTip = document.getElementById('dataHostHint')
        if (hostTip) {
          hostTip.textContent = '⚠ ' + nodeHostWarning.replace(/\n/g, ' ')
        }
      }

      // 回填数据面形态（只在用户本次没手动改过时）。
      //
      // 不回填的话，一个 Workers 实例被顺手更新一次就会被悄悄改成 Pages ——
      // 而界面上「默认 Pages」看起来毫无异常。
      if (!dataPlaneTouched) {
        const plane = status.dataPlaneMode === 'workers' ? 'workers' : 'pages'
        const radio = document.querySelector(
          `input[name="dataPlane"][value="${plane}"]`
        ) as HTMLInputElement | null
        if (radio) radio.checked = true
        syncDataPlaneUI()
      }

      // 部署实例与内核版本统一渲染到「运行状态」卡片（见 renderDeployInstance / renderKernelInfo）。

      /**
       * 检查过状态后的内核版本行。
       *
       * 两个版本来自**两个不同的地方**，名字必须唯一（早期挤在一行，
       * 出现过两个「线上」，用户没法判断该不该更新）：
       *
       *   当前已部署 ← Cloudflare 上这个实例正在跑的（现读数据面版本端点）
       *   最新发布   ← GitHub Release 上的最新内核（可升级到它）
       */
      const deployedText =
        '当前已部署 ' +
        (status.kernelVersion ? 'v' + status.kernelVersion : '版本未知') +
        (status.build ? ' · ' + status.build : '')
      const latestText = status.remoteKernelVersion
        ? '最新发布 v' + status.remoteKernelVersion
        : status.kernelRemoteError
          ? '最新发布查询失败'
          : ''
      // 「可升级」单独着色加粗 —— 用户一眼就知道该不该点更新。
      const kernelHtml =
        escapeHtml(deployedText) +
        (latestText ? ' ｜ ' + escapeHtml(latestText) : '') +
        (status.kernelUpdatable ? ' <span class="rt-upg">可升级</span>' : '')
      renderKernelInfo(
        [deployedText, latestText].filter(Boolean).join(' ｜ ') + (status.kernelUpdatable ? ' 可升级' : ''),
        status.kernelUpdatable === true,
        '当前已部署 = Cloudflare 上正在运行的内核；最新发布 = GitHub 上的最新内核',
        kernelHtml
      )

      // 部署实例：项目名（检查时才知道的更准）+ 部署时间
      const instanceText =
        (status.controlProject || '?') + ' / ' + (status.dataProject || '?') +
        (status.at ? '（' + status.at + '）' : '')
      renderDeployInstance(instanceText, true)

      if (status.state === 'latest') {
        setBtn('重新部署', false)
        if (status.kernelUpdatable) {
          setTip(
            '👉 GitHub 上发布了更新的内核（可更新到 ' +
              (status.remoteKernelVersion || '最新版') +
              '），点下面的「更新现有部署」即可升级 —— 不需要升级本程序。',
            true
          )
        } else {
          setTip('当前已部署的内核已是最新发布版本，无需更新。')
        }
        setHint(
          status.kernelUpdatable
            ? '「已部署」与「本程序内置」一致，但 GitHub 上有更新的内核 —— 点「重新部署」会升到最新版。'
            : '「已部署」与「本程序内置」是同一份产物，通常不需要再部署。'
        )
        return
      }

      // 三种子情况分开表达，绝不让用户看到 `unknown` 这种占位符
      if (!status.build) {
        // 已部署的内核读不到版本（早期部署的，或数据面探测不到且清单里没记）
        setBtn('更新并记录版本', true)
        setTip('读不到「已部署」内核的版本号（较早版本部署的，或数据面暂时探测不到）—— 更新一次即可写入版本号。', true)
        setHint('更新一次即可写入版本号，之后就能正常比对。会沿用原 UUID 与 WS 路径。')
        return
      }

      if (!status.localBuild) {
        // 本地读不到版本 —— 通常是产物缺失
        setBtn('重新部署', false)
        setTip('读不到「本程序内置」的内核版本 —— 应用内的内核产物可能缺失，请重新安装。', true)
        setHint('请重新安装或联系维护者；直接部署可能上传不完整的产物。')
        return
      }

      // 正常差异：已部署的比本程序内置的旧
      setBtn('更新到最新内核', true)
      if (status.kernelUpdatable) {
        setTip(
          '👉 GitHub 上发布了更新的内核（可更新到 ' +
            (status.remoteKernelVersion || '最新版') +
            '），点下面的「更新现有部署」即可升级 —— 不需要升级本程序。',
          true
        )
      } else {
        setTip('「已部署」与「本程序内置」不是同一份产物，点下面的「更新到最新内核」即可对齐。')
      }
      setHint(
        '「已部署」与「本程序内置」不是同一份产物，更新会换成后者。沿用原 UUID 与 WS 路径，客户端订阅地址不用改。'
      )
    }

    // 事件入口：部署完成后主进程 / SSE 推送状态时也走同一个渲染函数
    //
    // ⚠️ 这个通道推两种东西，必须先区分：
    //   1. 一次部署的**最终结果** `{ok, error?}` —— 只更新状态行；
    //   2. 部署状态的**快照** `{hasDeploy, state, …}` —— 交给状态卡渲染。
    //
    // 混在一起处理的话，结果事件没有 state 字段，会被当成快照渲染成
    // 「可更新」这类错误结论；反过来快照事件也没有 ok 字段。
    window.cfpilot.onDeployStatus((event) => {
      const s = event as CFPilotDeployStatus & DeployStatusLike
      if (typeof s.ok === 'boolean') {
        log(s.ok ? '── 部署成功（详细信息见上方汇总）──' : '── 部署失败 ──', s.ok ? 'ok' : 'err')
        // 部署结束后运行状态会过时（版本、项目名都变了），静默刷新一次
        if (s.ok) {
          const select = $sel('kvSelect')
          void window.cfpilot
            .checkDeployed(select.value || undefined)
            .then((st) => {
              if (applyDeployStatus) applyDeployStatus(st as DeployStatusLike)
              void loadRuntimeStatus()
            })
            .catch(() => {
              /* 状态刷新失败不影响部署结果，用户可手动点「检查部署状态」 */
            })
        }
        return
      }
      if (s.state && applyDeployStatus) applyDeployStatus(s)
    })

    window.cfpilot.onScanResult((payload) => {
      // ⚠️ 先收尾、再渲染：失败的 payload 只有 { ok:false, error }，没有 entries，
      // 直接读 payload.entries.length 会抛 TypeError，进度条门控就一直关不掉
      // （之后回填 / 部署的日志又来改进度条）。收尾放在最前面，无论后面怎样都生效。
      const entries = Array.isArray(payload && payload.entries) ? payload.entries : []
      // 优选结束 → 总进度条收尾到 100%。
      //
      // ⚠️ 早前只有**失败**路径会调 `finishScanProgress`，成功时进度条永远停在
      // 最后一条日志映射出的百分比上（常见是「处理中 · 总进度 1%」）——
      // 桌面版跑完优选后进度条一直卡着，就是这里漏了收尾。
      finishScanProgress(entries.length > 0)
      renderScanResult(payload)
      // 优选成功后端已自动留底 —— 顺手刷新历史列表，
      // 用户不用手动点「刷新」就能看到刚跑完的这批结果。
      if (entries.length > 0) {
        void loadScanHistory()
      }
    })

    window.cfpilot.onUpdateProgress((p) => {
      const wrap = document.getElementById('updateProgressWrap')
      const bar = document.getElementById('updateBar')
      const text = document.getElementById('updateProgressText')
      if (!wrap || !bar) return
      wrap.hidden = false

      const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
      const pct = p.total > 0 ? Math.round((p.received / p.total) * 100) : 0
      bar.style.width = (p.total > 0 ? pct : 30) + '%'

      if (text) {
        const parts: string[] = []
        if (p.total > 0) {
          parts.push(`${mb(p.received)} / ${mb(p.total)} MB（${pct}%）`)
        } else {
          // 服务端没给 content-length：只能显示已下载量
          parts.push(`已下载 ${mb(p.received)} MB`)
        }
        if (p.source && p.source !== 'GitHub') parts.push(`镜像 ${p.source}`)
        if (p.attempt > 1) parts.push(`第 ${p.attempt} 次尝试`)
        text.textContent = parts.join(' · ')
      }
    })
  }

  /**
   * 链式代理（自建落地节点）
   *
   * ## 为什么叫「链式」
   *
   * 链路形态是 客户端 → Worker（前置）→ 你的 VPS（落地）→ 目标站。
   * 前半段负责抗封锁与就近接入，后半段决定目标站看到的出口 IP。
   *
   * ## 为什么需要它
   *
   * Cloudflare 的出口是机房 IP。流媒体与部分站点对机房 IP 的风控是
   * 结构性的 —— 不是配置错了，是 IP 类型不对。换一个自己的出口，
   * 比任何「解锁检测」都有效。
   *
   * ## 为什么要有「复制命令」这条路
   *
   * 桌面进程没有终端，ssh 读不到 /dev/tty，**无法提示输入密码**。
   * 所以没配密钥的用户走「复制命令」：把整段脚本用 heredoc 包成一条命令，
   * 粘到终端里执行 —— 那里 ssh 才能正常要密码。
   */
  function bindChain(): void {
    const hostEl = $('chainHost')
    const portEl = $('chainPort')
    const outEl = $('chainOut')
    const deployBtn = document.getElementById('btnChainDeploy') as HTMLButtonElement | null
    const copyBtn = document.getElementById('btnChainCopy') as HTMLButtonElement | null
    if (!hostEl || !portEl || !outEl || !deployBtn || !copyBtn) return

    const showOut = (text: string): void => {
      outEl.hidden = false
      outEl.textContent = text
      outEl.scrollTop = outEl.scrollHeight
    }

    const readPort = (): number => {
      const n = Number.parseInt(portEl.value, 10)
      return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 1080
    }

    /** 把端口写进脚本（与 Go 端 withChainPort 同一套规则） */
    const withPort = (script: string, port: number): string => {
      if (port <= 0 || port === 1080) return script
      return script.replace('\nPORT=1080\n', '\nPORT=' + port + '\n')
    }

    deployBtn.addEventListener('click', async () => {
      const host = hostEl.value.trim()
      if (!host) {
        log('请先填写 VPS 地址（形如 root@203.0.113.10）', 'err')
        hostEl.focus()
        return
      }
      const label = deployBtn.textContent || '一键部署到 VPS'
      deployBtn.disabled = true
      deployBtn.textContent = '部署中…（最多 3 分钟）'
      showOut('正在通过 ssh 在 ' + host + ' 上执行部署脚本…\n首次连接会确认主机指纹，需要 root 权限。\n')
      try {
        const r = await window.cfpilot.chainDeploy({ host, port: readPort() })
        showOut(r.output || '(远端没有输出)')
        if (r.ok) {
          log('链式代理部署完成：把输出里的 socks5:// 粘到面板「出站与高级」→ SOCKS5', 'ok')
        } else {
          if (r.error) showOut((r.output || '') + '\n\n' + r.error)
          log('链式代理部署失败：' + (r.error || '详见部署输出'), 'err')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        showOut('调用失败：' + msg)
        log('链式代理部署失败：' + msg, 'err')
      } finally {
        deployBtn.disabled = false
        deployBtn.textContent = label
      }
    })

    copyBtn.addEventListener('click', async () => {
      try {
        const info = await window.cfpilot.chainScript()
        const host = hostEl.value.trim() || 'root@你的VPS_IP'
        const script = withPort(info.script, readPort())
        // 用 heredoc 把脚本和 ssh 包成一条命令：粘贴一次即可，不用先 scp 文件
        const block =
          "ssh -t " + host + " 'bash -s' <<'CFPILOT_EOF'\n" + script + '\nCFPILOT_EOF\n'
        await navigator.clipboard.writeText(block)
        showOut(
          '已复制到剪贴板。\n\n在终端（Git Bash / WSL / macOS / Linux）里粘贴执行，' +
            'ssh 会正常提示输入密码：\n\n' + block.slice(0, 600) + '\n…（完整内容已在剪贴板）'
        )
        log('已复制链式代理部署命令，请在终端里粘贴执行', 'ok')
      } catch (err) {
        log('复制失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      }
    })
  }

  /* ==================== 外部 IP 数据源（Phase 5） ====================
   *
   * 数据源配置、采集记录、本地池表格都只读写 ~/.cfpilot 下的本地文件。
   * 唯一会写 KV 的动作是「一键完整优选」，且必须二次确认。
   * 编辑数据源是「先改内存草稿 → 点保存整体落盘」，避免每改一个字段就写盘。
   */

  const SRC_PAGE_SIZE = 20
  let srcConfig: SourcesFileView = { schema: 1, updatedAt: 0, sources: [], runs: [] }
  let srcCandidates: PoolCandidateView[] = []
  let srcSelected = new Set<string>()
  let srcPage = 1
  let srcLoaded = false
  let srcBusy = false
  let srcEditingId = ''
  let srcListOpen = false
  let srcFormOpen = false
  const srcSelectedSources = new Set<string>()

  /** 批量工具条的选中计数与全选框状态。 */
  function updateSourcesSelectedCount(): void {
    const label = document.getElementById('srcSourcesSelected')
    if (label) label.textContent = '已选 ' + srcSelectedSources.size + ' 条'
    const boxes = [...$text('srcSourcesBody').querySelectorAll<HTMLInputElement>('input[data-src-key]')]
    const all = document.getElementById('srcSourcesCheckAll') as HTMLInputElement | null
    if (all) {
      all.checked = boxes.length > 0 && boxes.every((b) => b.checked)
      all.indeterminate = !all.checked && boxes.some((b) => b.checked)
    }
    ;['btnSrcBulkEnable', 'btnSrcBulkDisable', 'btnSrcBulkDelete'].forEach((id) => {
      const btn = document.getElementById(id) as HTMLButtonElement | null
      if (btn) btn.disabled = srcSelectedSources.size === 0
    })
  }

  /** 来源清单默认折叠：几十条内置来源常驻会把下面的采集记录 / 候选池推到很下面 */
  function setSrcListOpen(open: boolean): void {
    srcListOpen = open
    const wrap = document.getElementById('srcSourcesListWrap')
    const btn = document.getElementById('btnSrcListToggle')
    if (wrap) wrap.hidden = !open
    if (btn) {
      btn.textContent = open ? '收起来源清单' : '展开来源清单'
      btn.setAttribute('aria-expanded', String(open))
    }
  }

  function setSrcFormOpen(open: boolean): void {
    srcFormOpen = open
    const wrap = document.getElementById('srcFormWrap')
    const btn = document.getElementById('btnSrcFormToggle')
    if (wrap) wrap.hidden = !open
    if (btn) {
      btn.textContent = open ? '收起编辑表单' : '新增 / 编辑来源'
      btn.setAttribute('aria-expanded', String(open))
    }
    if (open) wrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function srcErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  function srcNote(text: string, isError = false): void {
    $text('srcLastAction').textContent = text
    log(text, isError ? 'err' : undefined)
  }

  /** HTML 转义：数据源 id / URL 是用户填的，不能直接拼进 innerHTML。 */
  function srcEsc(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c] || c)
  }

  function srcTime(ms: number): string {
    if (!ms) return '从未'
    try { return new Date(ms).toLocaleString() } catch { return '—' }
  }

  function srcBusySet(on: boolean): void {
    srcBusy = on
    const ids = ['btnSrcSync', 'btnSrcConfigSave', 'btnSrcRefresh']
    ids.forEach((id) => {
      const el = document.getElementById(id) as HTMLButtonElement | null
      if (el) el.disabled = on
    })
  }

  /** 拉配置 + 池 + 采集记录 + 定时状态，一次刷齐四个卡片。 */
  async function loadSourcesData(force = false): Promise<void> {
    if (srcLoaded && !force) return
    if (srcBusy) return
    srcBusySet(true)
    try {
      const r = await window.cfpilot.sourcesList()
      if (!r.ok) throw new Error('读取数据源配置失败')
      srcConfig = r.config
      const pool = await window.cfpilot.sourcesPool()
      srcCandidates = pool.candidates || []
      srcLoaded = true
      $text('srcPoolBadge').textContent = String(r.pool.total) + ' 条'
      $text('srcPoolSummary').textContent =
        r.pool.total + ' 条（v4 ' + (r.pool.byFamily.v4 || 0) + ' / v6 ' + (r.pool.byFamily.v6 || 0) +
        '；active ' + (r.pool.byStatus.active || 0) + ' / pending ' + (r.pool.byStatus.pending || 0) +
        ' / failed ' + (r.pool.byStatus.failed || 0) + ' / disabled ' + (r.pool.byStatus.disabled || 0) + '）'
      $text('srcSchedSummary').textContent = r.scheduler.running
        ? '正在同步…'
        : '空闲（上次 ' + srcTime(r.scheduler.lastRun) + '）' + (r.scheduler.lastError ? ' · ' + r.scheduler.lastError : '')
      renderSourceFilter()
      renderSourcesTable()
      renderRuns()
      renderPool()
    } catch (err) {
      srcNote('加载失败：' + srcErr(err), true)
    } finally {
      srcBusySet(false)
    }
  }
  autoLoadSources = () => { void loadSourcesData(false) }

  function isApiSourceType(t: string): boolean {
    return t === 'ripe-stat'
  }

  /** 按来源类型切换表单可用字段与提示，避免清单型/API 型参数混填。 */
  function syncFormTypeHint(): void {
    const type = $sel('srcFormType').value
    const api = isApiSourceType(type)
    $('srcFormUrl').disabled = api
    $('srcFormMirrors').disabled = api
    $('srcFormQuery').disabled = !api
    $('srcFormMaxResults').disabled = !api
    $text('srcFormTypeHint').textContent = api
      ? 'API 型：endpoint 由程序固定，只需填查询串与取样上限。RIPEstat 零 Key，可直接测试。'
      : '清单型：填 HTTPS 主链接（可加镜像），查询串留空。'
  }

  /** 来源下拉从池里实际出现过的 sources 聚合，不写死。 */
  function renderSourceFilter(): void {
    const sel = $sel('srcFilterSource')
    const keep = sel.value
    const all = new Set<string>()
    srcConfig.sources.forEach((s) => all.add(s.id))
    srcCandidates.forEach((c) => c.sources.forEach((s) => all.add(s)))
    sel.replaceChildren(new Option('全部', ''))
    ;[...all].sort().forEach((s) => sel.add(new Option(s, s)))
    sel.value = [...all].includes(keep) ? keep : ''
  }

  function renderSourcesTable(): void {
    const tbody = $text('srcSourcesBody')
    const table = $text('srcSourcesTable') as unknown as HTMLTableElement
    const all = srcConfig.sources
    const domains = all.filter((s) => s.name.startsWith('域名·')).length
    const enabled = all.filter((s) => s.enabled).length
    $text('srcSourcesBadge').textContent = all.length + ' 个'
    $text('srcSourcesSummary').textContent =
      all.length + ' 个来源 · ' + domains + ' 个域名源 / ' + (all.length - domains) + ' 个 IP / API 源 · ' + enabled + ' 个参与同步'
    // 「立即同步」只拉 enabled 源：0 个时按钮看似没反应，必须把原因写在按钮旁
    const syncScope = document.getElementById('srcSyncScope')
    if (syncScope) {
      syncScope.textContent = enabled === 0
        ? '当前 0 个来源参与同步 —— 「立即同步」不会拉取任何清单，请先在下方把来源设为参与同步'
        : '当前 ' + enabled + ' 个来源参与同步'
      syncScope.style.color = enabled === 0 ? 'var(--danger, #e55)' : ''
    }

    const q = (document.getElementById('srcFilterKeyword') as HTMLInputElement | null)?.value.trim().toLowerCase() || ''
    const kind = (document.getElementById('srcFilterKind') as HTMLSelectElement | null)?.value || 'all'
    const rows = all.filter((s) => {
      const isDomain = s.name.startsWith('域名·')
      if (kind === 'enabled' && !s.enabled) return false
      if (kind === 'disabled' && s.enabled) return false
      if (kind === 'domain' && !isDomain) return false
      if (kind === 'ip' && isDomain) return false
      if (kind === 'builtin' && !s.id.startsWith('bestcf-')) return false
      if (kind === 'custom' && s.id.startsWith('bestcf-')) return false
      if (!q) return true
      return (s.id + ' ' + s.name + ' ' + (s.url || s.query || '')).toLowerCase().includes(q)
    })
    // 删掉已不存在的选中项，避免批量操作指向幽灵条目
    for (const id of [...srcSelectedSources]) {
      if (!all.some((s) => s.id === id)) srcSelectedSources.delete(id)
    }
    const filterHint = document.getElementById('srcSourcesFilterHint')
    if (filterHint) {
      filterHint.hidden = rows.length === all.length
      filterHint.textContent = rows.length === all.length ? '' : '显示 ' + rows.length + ' / ' + all.length + ' 条（可改搜索词或类别）'
    }

    if (rows.length === 0) {
      table.hidden = true
      $text('srcSourcesEmpty').hidden = false
      $text('srcSourcesEmpty').textContent = all.length === 0
        ? '还没有数据源，点「新增 / 编辑来源」添加。'
        : '没有匹配的来源，换个搜索词或类别试试。'
      tbody.replaceChildren()
      return
    }
    table.hidden = false
    $text('srcSourcesEmpty').hidden = true
    tbody.innerHTML = rows.map((s) => {
      const state = s.lastError
        ? '<span style="color:var(--danger,#e55)">' + srcEsc(s.lastError) + '</span>'
        : (s.failCount ? '失败 ' + s.failCount + ' 次' : '正常')
      return '<tr>' +
        '<td><input type="checkbox" data-src-key="' + srcEsc(s.id) + '"' +
        (srcSelectedSources.has(s.id) ? ' checked' : '') + ' /></td>' +
        '<td><b>' + srcEsc(s.id) + '</b><br><span class="muted">' + srcEsc(s.name) + '</span></td>' +
        '<td>' + srcEsc(s.type) + '</td>' +
        '<td style="max-width:220px;word-break:break-all">' + srcEsc(s.url || s.query || '—') +
        (s.url ? '' : '<br><span class="muted">上限 ' + (s.maxResults || 200) + '</span>') + '</td>' +
        '<td>' + (s.enabled ? '✅' : '⏸') + '</td>' +
        '<td>' + s.intervalHours + '</td>' +
        '<td>' + srcTime(s.lastSyncAt) + '</td>' +
        '<td>' + state + '</td>' +
        '<td>' +
          '<button class="btn btn-ghost btn-sm" data-src-act="test" data-src-id="' + srcEsc(s.id) + '">测试</button> ' +
          '<button class="btn btn-ghost btn-sm" data-src-act="edit" data-src-id="' + srcEsc(s.id) + '">编辑</button> ' +
          '<button class="btn btn-ghost btn-sm" data-src-act="toggle" data-src-id="' + srcEsc(s.id) + '">' + (s.enabled ? '暂停同步' : '参与同步') + '</button> ' +
          '<button class="btn btn-ghost btn-sm" data-src-act="remove" data-src-id="' + srcEsc(s.id) + '">删除</button>' +
        '</td></tr>'
    }).join('')
    updateSourcesSelectedCount()
  }

  function renderRuns(): void {
    const tbody = $text('srcRunsBody')
    const table = $text('srcRunsTable') as unknown as HTMLTableElement
    const runs = [...srcConfig.runs].reverse().slice(0, 10)
    $text('srcRunsBadge').textContent = srcConfig.runs.length + ' 条'
    if (runs.length === 0) {
      table.hidden = true
      $text('srcRunsEmpty').hidden = false
      tbody.replaceChildren()
      return
    }
    table.hidden = false
    $text('srcRunsEmpty').hidden = true
    tbody.innerHTML = runs.map((r) =>
      '<tr><td>' + srcTime(r.at) + '</td><td>' + srcEsc(r.sourceId) + '</td>' +
      '<td>' + (r.ok ? (r.notModified ? '未变更(304)' : '<span style="color:var(--ok,#2a8)">成功</span>') : '<span style="color:var(--danger,#e55)">' + srcEsc(r.error) + '</span>') + '</td>' +
      '<td>' + r.added + '</td><td>' + r.updated + '</td><td>' + r.rejected + '</td><td>' + r.durationMs + 'ms</td></tr>'
    ).join('')
  }

  function filteredCandidates(): PoolCandidateView[] {
    const q = $('srcFilterText').value.trim().toLowerCase()
    const status = $sel('srcFilterStatus').value
    const family = $sel('srcFilterFamily').value
    const source = $sel('srcFilterSource').value
    const sort = $sel('srcSort').value
    const rows = srcCandidates.filter((c) => {
      if (status && c.status !== status) return false
      if (family && String(c.ipVersion) !== family) return false
      if (source && !c.sources.includes(source)) return false
      if (q && !(c.ip.toLowerCase().includes(q) || c.key.toLowerCase().includes(q) || c.sources.join(',').toLowerCase().includes(q))) return false
      return true
    })
    rows.sort((a, b) => {
      if (sort === 'ip') return a.key.localeCompare(b.key)
      if (sort === 'successCount') return b.successCount - a.successCount || b.lastSeen - a.lastSeen
      if (sort === 'status') return a.status.localeCompare(b.status) || a.key.localeCompare(b.key)
      return b.lastSeen - a.lastSeen
    })
    return rows
  }

  function renderPool(): void {
    const rows = filteredCandidates()
    const pages = Math.max(1, Math.ceil(rows.length / SRC_PAGE_SIZE))
    if (srcPage > pages) srcPage = pages
    const slice = rows.slice((srcPage - 1) * SRC_PAGE_SIZE, srcPage * SRC_PAGE_SIZE)
    const tbody = $text('srcPoolBody')
    const table = $text('srcPoolTable') as unknown as HTMLTableElement
    $text('srcTableBadge').textContent = rows.length + ' / ' + srcCandidates.length + ' 条'
    $text('srcPageInfo').textContent = '第 ' + srcPage + ' / ' + pages + ' 页（每页 ' + SRC_PAGE_SIZE + '）'
    if (rows.length === 0) {
      table.hidden = true
      $text('srcPoolEmpty').hidden = false
      tbody.replaceChildren()
      return
    }
    table.hidden = false
    $text('srcPoolEmpty').hidden = true
    tbody.innerHTML = slice.map((c) => {
      const light = c.lightCheck
        ? (c.lightCheck.tcpOk && c.lightCheck.tlsOk ? '✅ ' + (c.lightCheck.tlsMs || 0) + 'ms' : '❌')
        : '未测'
      const full = c.fullTest && c.fullTest.wsOk
        ? '✅ ' + (c.fullTest.speedMBps || 0).toFixed(1) + ' MB/s ' + (c.fullTest.colo || '')
        : (c.fullTest && c.fullTest.wsOk === false ? '❌' : '—')
      return '<tr>' +
        '<td><input type="checkbox" data-src-key="' + srcEsc(c.key) + '"' + (srcSelected.has(c.key) ? ' checked' : '') + ' /></td>' +
        '<td><code>' + srcEsc(c.key) + '</code></td>' +
        '<td>' + srcEsc(c.status) + '</td>' +
        '<td>' + srcEsc(c.sources.join(', ')) + '</td>' +
        '<td>' + light + '</td><td>' + srcEsc(full) + '</td>' +
        '<td>' + c.successCount + ' / ' + c.failCount + '</td>' +
        '<td>' + srcTime(c.lastSeen) + '</td></tr>'
    }).join('')
  }

  /** 保存整份配置草稿（URL 校验在后端做，失败会把原因带回来）。 */
  async function saveSourceConfig(): Promise<void> {
    if (srcBusy) return
    srcBusySet(true)
    try {
      const r = await window.cfpilot.sourcesSave(srcConfig)
      if (!r.ok) throw new Error(r.error || '保存失败')
      if (r.config) srcConfig = r.config
      srcNote('数据源配置已保存（' + srcConfig.sources.length + ' 个）')
      renderSourceFilter()
      renderSourcesTable()
      renderRuns()
    } catch (err) {
      srcNote('保存失败：' + srcErr(err), true)
    } finally {
      srcBusySet(false)
    }
  }

  function clearSourceForm(): void {
    srcEditingId = ''
    $('srcFormId').value = ''
    $('srcFormId').disabled = false
    $('srcFormName').value = ''
    $('srcFormUrl').value = ''
    $('srcFormMirrors').value = ''
    $('srcFormQuery').value = ''
    $('srcFormMaxResults').value = '200'
    $('srcFormInterval').value = '12'
    $('srcFormEnabled').checked = true
    $sel('srcFormType').value = 'custom-url'
    $text('srcFormTitle').textContent = '新增数据源'
    syncFormTypeHint()
  }

  /** 把表单内容加入/更新内存草稿，不落盘。 */
  function upsertDraft(): void {
    const id = $('srcFormId').value.trim()
    if (!id) { srcNote('请填写数据源 ID', true); return }
    const type = $sel('srcFormType').value as ExternalSourceType
    const api = isApiSourceType(type)
    const url = api ? '' : $('srcFormUrl').value.trim()
    const query = api ? $('srcFormQuery').value.trim() : ''
    const maxResults = Math.max(1, Math.min(2000, Number($('srcFormMaxResults').value) || 200))
    if (!api && (!url || !/^https:\/\//i.test(url))) { srcNote('主链接必须是 https:// 开头', true); return }
    const mirrors = api ? [] : $('srcFormMirrors').value.split(',').map((s) => s.trim()).filter(Boolean)
    for (const m of mirrors) {
      if (!/^https:\/\//i.test(m)) { srcNote('镜像链接也必须是 https:// 开头', true); return }
    }
    if (api && !query) { srcNote('API 型数据源需要填查询串', true); return }
    if (type === 'ripe-stat' && !/^AS\d{1,10}$/i.test(query)) {
      srcNote('RIPEstat 的查询串必须是 ASN，如 AS13335', true); return
    }
    const hours = Math.max(1, Math.min(720, Number($('srcFormInterval').value) || (type === 'github-raw' ? 12 : 24)))
    const draft: SourceConfigView = {
      id, name: $('srcFormName').value.trim() || id, type, url, mirrors,
      enabled: $('srcFormEnabled').checked, intervalHours: hours,
      etag: '', lastModified: '', lastSyncAt: 0, lastError: '', failCount: 0,
      query, maxResults,
    }
    const idx = srcConfig.sources.findIndex((s) => s.id === id)
    if (idx >= 0) {
      // 编辑时保留条件请求头与同步历史，避免下次全量重拉
      draft.etag = srcConfig.sources[idx]!.etag
      draft.lastModified = srcConfig.sources[idx]!.lastModified
      draft.lastSyncAt = srcConfig.sources[idx]!.lastSyncAt
      srcConfig.sources[idx] = draft
    } else {
      srcConfig.sources.push(draft)
    }
    renderSourcesTable()
    renderSourceFilter()
    clearSourceForm()
    // 加入 / 更新后展开清单，让用户立刻看到结果，不必自己再点一次
    setSrcListOpen(true)
    srcNote('已' + (idx >= 0 ? '更新' : '加入') + '「' + id + '」，正在保存…')
    void saveSourceConfig()
  }

  /** 批量参与同步 / 暂停同步 / 删除：勾多个来源一次处理，操作后立即落盘。 */
  async function bulkSourceAction(action: 'enable' | 'disable' | 'delete'): Promise<void> {
    if (srcSelectedSources.size === 0) { srcNote('请先勾选来源', true); return }
    if (srcBusy) return
    const ids = [...srcSelectedSources]
    if (action === 'delete' &&
      !confirm('删除选中的 ' + ids.length + ' 个数据源？\n只会移除配置与来源关联，池内候选请点「刷新」查看关联变化。')) return
    if (action === 'delete') {
      srcConfig.sources = srcConfig.sources.filter((s) => !srcSelectedSources.has(s.id))
    } else {
      for (const s of srcConfig.sources) {
        if (srcSelectedSources.has(s.id)) s.enabled = action === 'enable'
      }
    }
    srcSelectedSources.clear()
    renderSourcesTable()
    renderSourceFilter()
    await saveSourceConfig()
    srcNote('已' + (action === 'delete' ? '删除 ' : action === 'enable' ? '设为参与同步 ' : '暂停同步 ') + ids.length + ' 个来源')
  }

  async function sourceAction(act: string, id: string): Promise<void> {
    const s = srcConfig.sources.find((x) => x.id === id)
    if (!s) return
    if (act === 'edit') {
      setSrcFormOpen(true)
      srcEditingId = id
      $('srcFormId').value = s.id
      $('srcFormId').disabled = true
      $('srcFormName').value = s.name
      $sel('srcFormType').value = s.type
      $('srcFormUrl').value = s.url
      $('srcFormMirrors').value = s.mirrors.join(', ')
      $('srcFormQuery').value = s.query || ''
      $('srcFormMaxResults').value = String(s.maxResults || 200)
      $('srcFormInterval').value = String(s.intervalHours)
      $('srcFormEnabled').checked = s.enabled
      $text('srcFormTitle').textContent = '编辑数据源：' + id
      syncFormTypeHint()
      return
    }
    if (act === 'toggle') {
      s.enabled = !s.enabled
      await saveSourceConfig()
      return
    }
    if (act === 'remove') {
      if (!confirm('删除数据源「' + id + '」？\n只会移除配置与来源关联，仍被其它来源引用的候选会保留。')) return
      srcConfig.sources = srcConfig.sources.filter((x) => x.id !== id)
      await saveSourceConfig()
      srcNote('已删除数据源 ' + id + '；池内候选请点「刷新」查看关联变化')
      return
    }
    if (act === 'test') {
      srcNote('正在测试 ' + id + ' …')
      try {
        const r = await window.cfpilot.sourcesTest(id)
        // API 型源返回 note/upstreamCount，清单型返回 durationMs；两者都带 ok/added/error
        const o = r.outcome as SourceSyncOutcomeView & { note?: string; upstreamCount?: number }
        const detail = o.note || ('解析出 ' + o.added + ' 条' + (o.durationMs ? '（' + o.durationMs + 'ms）' : ''))
        srcNote(o.ok ? id + ' 可用：' + detail : id + ' 不可用：' + (o.error || '未知错误'), !o.ok)
      } catch (err) { srcNote('测试失败：' + srcErr(err), true) }
    }
  }

  /** 批量操作候选；删除需要二次确认。 */
  async function updateSelected(action: 'disable' | 'enable' | 'delete'): Promise<void> {
    if (srcSelected.size === 0) { srcNote('请先勾选候选', true); return }
    if (action === 'delete' && !confirm('确定删除选中的 ' + srcSelected.size + ' 条候选？此操作不可撤销。')) return
    if (srcBusy) return
    srcBusySet(true)
    try {
      const keys = [...srcSelected]
      const r = await window.cfpilot.sourcesPoolUpdate(keys, action)
      if (!r.ok) throw new Error(r.error || '操作失败')
      srcSelected.clear()
      srcNote('已' + (action === 'delete' ? '删除候选' : action === 'disable' ? '禁用候选' : '启用候选') + ' ' + r.changed + ' 条')
      await loadSourcesData(true)
    } catch (err) {
      srcNote('操作失败：' + srcErr(err), true)
    } finally {
      srcBusySet(false)
    }
  }

  /** 导出当前筛选结果（不只是本页），前端生成，不需要后端路由。 */
  function exportPool(format: 'txt' | 'csv'): void {
    const rows = filteredCandidates()
    if (rows.length === 0) { srcNote('当前筛选没有可导出的候选', true); return }
    let text = ''
    if (format === 'txt') {
      text = rows.map((c) => (c.ipVersion === 6 ? '[' + c.ip + ']:' + c.port : c.ip + ':' + c.port) + '#' + c.status).join('\n') + '\n'
    } else {
      const cell = (v: string): string => '"' + v.replace(/"/g, '""') + '"'
      const head = 'ip,port,status,sources,lightCheck,fullTest,successCount,failCount,lastSeen'
      text = [head, ...rows.map((c) => [
        c.ip, String(c.port), c.status, c.sources.join('|'),
        c.lightCheck ? String(c.lightCheck.tcpOk && c.lightCheck.tlsOk) : '',
        c.fullTest && c.fullTest.wsOk ? String(c.fullTest.speedMBps || 0) : '',
        String(c.successCount), String(c.failCount), String(c.lastSeen),
      ].map(cell).join(','))].join('\n') + '\n'
    }
    const blob = new Blob([text], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'cfpilot-external-candidates.' + format
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
    srcNote('已导出 ' + rows.length + ' 条（' + format.toUpperCase() + '）')
  }

  /** 绑定数据源页的全部交互；DOMContentLoaded 时调用一次。 */
  function bindSourcesPage(): void {
    autoLoadSources = () => { void loadSourcesData(false) }
    const on = (id: string, fn: () => void): void => {
      document.getElementById(id)?.addEventListener('click', fn)
    }
    syncFormTypeHint()
    setSrcListOpen(false)
    setSrcFormOpen(false)
    on('btnSrcListToggle', () => setSrcListOpen(!srcListOpen))
    on('btnSrcFormToggle', () => setSrcFormOpen(!srcFormOpen))
    on('btnSrcBulkEnable', () => { void bulkSourceAction('enable') })
    on('btnSrcBulkDisable', () => { void bulkSourceAction('disable') })
    on('btnSrcBulkDelete', () => { void bulkSourceAction('delete') })
    ;['srcFilterKeyword', 'srcFilterKind'].forEach((id) => {
      const el = document.getElementById(id)
      if (!el) return
      // 换筛选条件时清空勾选，避免批量操作误伤当前看不见的行
      const refresh = (): void => { srcSelectedSources.clear(); renderSourcesTable() }
      el.addEventListener('input', refresh)
      el.addEventListener('change', refresh)
    })
    const srcCheckAll = document.getElementById('srcSourcesCheckAll') as HTMLInputElement | null
    srcCheckAll?.addEventListener('change', () => {
      $text('srcSourcesBody').querySelectorAll<HTMLInputElement>('input[data-src-key]').forEach((box) => {
        const id = box.dataset.srcKey || ''
        box.checked = srcCheckAll.checked
        if (srcCheckAll.checked) srcSelectedSources.add(id)
        else srcSelectedSources.delete(id)
      })
      updateSourcesSelectedCount()
    })
    $sel('srcFormType').addEventListener('change', syncFormTypeHint)
    on('btnSrcRefresh', () => { void loadSourcesData(true) })
    on('btnSrcSync', () => {
      if (srcBusy) return
      void (async () => {
        srcBusySet(true)
        srcNote('正在同步所有参与同步的来源（含 TCP/TLS 轻量校验）…')
        try {
          const r = await window.cfpilot.sourcesSync([])
          if (!r.ok) throw new Error(r.error || '同步失败')
          const os = r.report ? r.report.outcomes : []
          const ok = os.filter((o) => o.ok).length
          srcNote('同步完成：' + ok + '/' + os.length + ' 个源成功，池内 ' + (r.report ? r.report.poolCandidates : 0) + ' 条')
          await loadSourcesData(true)
        } catch (err) {
          srcNote('同步失败：' + srcErr(err), true)
        } finally { srcBusySet(false) }
      })()
    })
    on('btnSrcFormSave', upsertDraft)
    on('btnSrcFormClear', clearSourceForm)
    on('btnSrcConfigSave', () => { void saveSourceConfig() })
    on('btnSrcSelectAll', () => {
      filteredCandidates()
        .slice((srcPage - 1) * SRC_PAGE_SIZE, srcPage * SRC_PAGE_SIZE)
        .forEach((c) => srcSelected.add(c.key))
      renderPool()
    })
    on('btnSrcDisable', () => { void updateSelected('disable') })
    on('btnSrcEnable', () => { void updateSelected('enable') })
    on('btnSrcDelete', () => { void updateSelected('delete') })
    on('btnSrcExportTxt', () => exportPool('txt'))
    on('btnSrcExportCsv', () => exportPool('csv'))
    on('btnSrcPrev', () => { if (srcPage > 1) { srcPage--; renderPool() } })
    on('btnSrcNext', () => { srcPage++; renderPool() })

    ;['srcFilterText', 'srcFilterStatus', 'srcFilterFamily', 'srcFilterSource', 'srcSort'].forEach((id) => {
      const el = document.getElementById(id)
      if (!el) return
      el.addEventListener('input', () => { srcPage = 1; renderPool() })
      el.addEventListener('change', () => { srcPage = 1; renderPool() })
    })
    $text('srcSourcesBody').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-src-act]') as HTMLElement | null
      if (btn) void sourceAction(btn.dataset.srcAct!, btn.dataset.srcId!)
    })
    $text('srcSourcesBody').addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement
      const id = box.dataset.srcKey
      if (!id) return
      if (box.checked) srcSelectedSources.add(id)
      else srcSelectedSources.delete(id)
      updateSourcesSelectedCount()
    })
    $text('srcPoolBody').addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement
      const key = box.dataset.srcKey
      if (!key) return
      if (box.checked) srcSelected.add(key)
      else srcSelected.delete(key)
    })
    const checkAll = document.getElementById('srcPoolCheckAll') as HTMLInputElement | null
    checkAll?.addEventListener('change', () => {
      filteredCandidates()
        .slice((srcPage - 1) * SRC_PAGE_SIZE, srcPage * SRC_PAGE_SIZE)
        .forEach((c) => { if (checkAll.checked) srcSelected.add(c.key); else srcSelected.delete(c.key) })
      renderPool()
    })
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindSourcesPage()
    document.getElementById('nav')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-page]') as HTMLElement | null
      if (btn) switchPage(btn.dataset.page!)
    })
    document.getElementById('btnClearLog')!.addEventListener('click', (e) => {
      e.stopPropagation()
      $('logBox').innerHTML = ''
    })

    // 日志栏折叠：点标题条切换
    const logPanel = $('logPanel')
    const logHead = $('logHead')

    /**
     * 折叠 / 展开日志面板。
     *
     * 折叠后高度是 auto（只剩标题条），展开后高度由 CSS 的 --log-ratio 决定。
     * 两者互不干扰，所以这里只切 class。
     */
    logHead.addEventListener('click', () => {
      const collapsed = logPanel.classList.toggle('collapsed')
      logHead.title = collapsed ? '点击展开日志' : '点击折叠日志'
    })

    /* 日志区拖拽调高                                                     */

    /**
     * 拖动日志面板上边缘调整高度。
     *
     * 第一版用 CSS `resize: vertical`，它把高度写成**内联固定 px**，
     * 因此在 2K / 1080P / 缩放窗口后全部错位：
     *   - 2K 折叠后标题条只露一半
     *   - 1080P 展开后溢出窗口下沿，日志看不见
     *
     * 现在拖拽时算的是 **占视口的比例**（0.15 ~ 0.75），
     * 存进 CSS 变量 --log-ratio；.log 的高度是
     * `calc(var(--log-ratio) * (100vh - 110px))`。
     *
     * 好处：
     *   - 换分辨率 / 缩放窗口时比例不变，永远不越界
     *   - 百分比有上下限钳制，内容区至少留 25%
     *   - 不存在内联 px，CSS 是唯一真相
     */
    const logRatioKey = 'cfpilot.logRatio'
    const RATIO_MIN = 0.15
    const RATIO_MAX = 0.75

    /** 应用比例到 CSS 变量（并做边界钳制） */
    const applyLogRatio = (ratio: number): void => {
      const r = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))
      logPanel.style.setProperty('--log-ratio', String(r))
    }

    // 恢复上次拖拽的比例
    try {
      const saved = Number(localStorage.getItem(logRatioKey))
      if (Number.isFinite(saved) && saved > 0) {
        applyLogRatio(saved)
      }
    } catch {
      /* localStorage 不可用就忽略，用默认值 */
    }

    const resizer = document.getElementById('logResizer')

    if (resizer) {
      let dragging = false
      let startY = 0
      let startHeight = 0

      const onMove = (e: MouseEvent): void => {
        if (!dragging) return
        // 向上拖（y 变小）→ 日志变高
        const delta = startY - e.clientY
        const nextHeight = startHeight + delta
        // 换算成比例：可用高度 = 视口 - 固定占用
        const usable = Math.max(200, window.innerHeight - 110)
        applyLogRatio(nextHeight / usable)
      }

      const onUp = (): void => {
        if (!dragging) return
        dragging = false
        logPanel.classList.remove('resizing')
        document.body.classList.remove('resizing-log')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        // 记住这次的比例
        try {
          const cur = parseFloat(logPanel.style.getPropertyValue('--log-ratio'))
          if (Number.isFinite(cur)) localStorage.setItem(logRatioKey, String(cur))
        } catch {
          /* 存不了就算了 */
        }
      }

      resizer.addEventListener('mousedown', (e) => {
        // 折叠状态下不允许拖（没内容可拖）
        if (logPanel.classList.contains('collapsed')) return
        e.preventDefault()
        e.stopPropagation()
        dragging = true
        startY = e.clientY
        // 起点高度取当前日志容器的真实高度
        const box = document.getElementById('logBox')
        startHeight = box ? box.getBoundingClientRect().height : 180
        logPanel.classList.add('resizing')
        document.body.classList.add('resizing-log')
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })

      // 双击手柄 = 恢复默认高度
      resizer.addEventListener('dblclick', (e) => {
        e.preventDefault()
        e.stopPropagation()
        applyLogRatio(0.28)
        try {
          localStorage.removeItem(logRatioKey)
        } catch {
          /* 忽略 */
        }
      })
    }

    /**
     * 兜底：极端情况下（窗口被拖得极矮）保证标题条仍可见。
     *
     * 若标题条底部超出视口，就强制折叠（折叠后高度 auto，必然可见）。
     */
    const ensureLogHeadVisible = (): void => {
      const rect = logHead.getBoundingClientRect()
      if (rect.bottom > window.innerHeight + 1) {
        logPanel.classList.add('collapsed')
        logHead.title = '点击展开日志'
      }
    }
    window.addEventListener('resize', ensureLogHeadVisible)
    ensureLogHeadVisible()

    /**
     * 初始化各步骤**互相隔离**。
     *
     * ## 为什么必须这样写
     *
     *     await refreshProfiles()
     *     await refreshCredState()
     *     renderKvOptions()
     *     void initCountryControls()   ← 前面任何一步抛异常，这行永远不执行
     *
     * 用户在 Go 版里遇到的现象是「机房国家列表一直停在『正在加载国家列表…』」，
     * 但后端接口实测返回的国家目录完全正常 ——
     * 说明**初始化在某一步中断了**，后面的国家选择器初始化根本没被调用。
     *
     * 任何一个可选功能（账户列表、凭据状态、KV 列表、国家列表）出问题，
     * 都不应该拖累其它功能。所以每步各自 try/catch 独立执行。
     */
    const runStep = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        // 只记录，不中断后续步骤
        console.error(`[cfpilot] 初始化步骤「${name}」失败：`, err)
        log(`初始化「${name}」失败：${err instanceof Error ? err.message : String(err)}`, 'warn')
      }
    }

    // ⚠️ 每个 bind 都要**独立兜底**。
    //
    // 账户列表与凭据状态是在所有 bind 之后才加载的（见本函数末尾的
    // `runStep('账户列表', refreshProfiles)`）。只要前面任何一个 bind 抛错，
    // 后面的加载就全部不执行 —— 表现是「凭据页的账户列表空了、要重新添加令牌」，
    // 而磁盘上的凭据其实完好。这里逐个 try/catch：一处坏掉不影响其余，
    // 也不影响最终的数据加载。
    const safeBind = (name: string, fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        log(
          '界面初始化「' + name + '」失败：' + (err instanceof Error ? err.message : String(err)),
          'err'
        )
      }
    }

    // ⚠️ 先装全局兜底，再绑各个模块。
    //
    // 顺序很要紧：兜底要在**任何**模块绑定之前就位 ——
    // 否则绑定阶段抛出的错误会漏出去。
    installGlobalErrorHandlers()
    applyCapabilities()

    safeBind('账户', bindProfiles)
    safeBind('运行时状态', bindRuntime)
    safeBind('凭据', bindCredentials)
    safeBind('部署', bindDeploy)
    safeBind('链式代理', bindChain)
    safeBind('优选', bindScan)
    safeBind('优选页签', bindScanSubtabs)
    safeBind('定时优选任务', bindScheduledTasks)
    safeBind('表格拖曳', bindTableResizers)
    safeBind('候选来源', bindCandidateSource)
    safeBind('反代优选', bindRelay)
    safeBind('优选历史', bindHistory)
    safeBind('实验性设置', bindExperimental)
    safeBind('自适应对照', bindAdaptiveEffect)
    safeBind('用量', bindUsage)
    safeBind('日志', bindLogs)
    safeBind('更新', bindUpdater)
    safeBind('回填', bindPush)

    // 切到「日志」页时自动加载一次。
    //
    // 赋值给前面声明的可空引用（与 autoCheckOnAbout 同一套做法）：
    // switchPage 定义在前面，这里赋的值它能直接用。
    autoLoadLogs = () => {
      // 已经加载过就不重复拉 —— 用户可能正在读日志内容，
      // 每次切页都重拉会把滚动位置顶回底部。
      if (logsLoaded) return
      void loadLogs()
    }

    /**
     * 托盘菜单跳转。
     *
     * 托盘点「检查部署更新」会打开 `?t=<令牌>&page=deploy`，
     * 界面读到 `page` 参数就切到对应页签 ——
     * 这样用户点完托盘菜单，落地时已经在正确的页面上，
     * 而不是停在「Cloudflare 凭据」页再自己找。
     */
    const pageParam = new URLSearchParams(location.search).get('page')
    if (pageParam) {
      const valid = ['cred', 'deploy', 'scan', 'sources', 'about', 'logs']
      if (valid.includes(pageParam)) {
        switchPage(pageParam)
        log('已跳转到「' + pageParam + '」页')
      }
    }

    await runStep('账户列表', refreshProfiles)
    await runStep('凭据状态', refreshCredState)
    await runStep('KV 选项', () => {
      renderKvOptions()
    })
    // 国家选择器：不 await，避免拖慢界面；加载失败也不影响优选
    void runStep('国家选择器', initCountryControls)

    log('CFPilot GUI 已就绪')
    log('凭据只保存在本机，不会上传')

    // 启动时「当前使用」已有选中账户 → 自动检测实例并按个数自动选 KV
    //
    // 用户要求（2026-10-29）：点「检测账号」或者在「当前使用」里选中账户时，
    // 都要自动探测有没有 CFPilot 实例，唯一实例直接选中并保存。
    // 这一条不能 await —— 它要打 Cloudflare API，慢的时候会拖住界面首屏。
    void (async () => {
      try {
        if (hasActiveToken()) await detectAccountAndGuide()
      } catch {
        /* 启动期检测失败不影响其它功能，用户可手点「检测账号」重试 */
      }
    })()
  })
})()