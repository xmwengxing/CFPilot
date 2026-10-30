/**
 * 渲染层逻辑
 *
 * 注意：这里拿不到 Node 能力，也拿不到令牌明文。
 * 所有敏感操作通过 window.cfpilot 转主进程。
 */
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

  function escapeHtml(s: string): string {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }
    return s.replace(/[&<>"']/g, (c) => map[c]!)
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
    const deployKv = $text('deployKv')
    if (!item) {
      hint.textContent = currentAccountId
        ? '请选择一个命名空间（全新部署时会自动创建 KV）。'
        : '点「刷新 KV 列表」查看账号下有哪些命名空间。'
      deployKv.textContent = '—'
      return
    }
    if (item.ownership === 'instance') {
      hint.textContent =
        `控制面 ${item.controlProject} / 数据面 ${item.dataProject}，部署于 ${item.at}。`
      deployKv.textContent = `${item.title}（${item.id}）`
    } else if (item.ownership === 'foreign') {
      hint.textContent =
        '此命名空间已被其他项目占用，不能用于 CFPilot。' +
        'CFPilot 的数据面已完全自研，两者不再共用同一 KV' +
        '（会共享配额、混淆配置、让排查变难）。请到「部署」页新建一个实例。'
      deployKv.textContent = `${item.title}（${item.id}）— 不可用`
    } else if (item.ownership === 'cfpilot') {
      hint.textContent =
        '此命名空间含 CFPilot 的 CONFIG 键但没有部署清单（残留配置）。' +
        '部署会覆盖它，除非你确实知道自己在做什么。'
      deployKv.textContent = `${item.title}（${item.id}）`
    } else {
      hint.textContent = '空命名空间，可用于部署新实例。'
      deployKv.textContent = `${item.title}（${item.id}）`
    }
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
  async function refreshProfiles(): Promise<void> {
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

    // 对齐：优先保持用户刚选的那一项，其次激活项
    const active = profiles.find((p) => p.active)
    if (previous === NEW_PROFILE_VALUE) sel.value = NEW_PROFILE_VALUE
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
        '当前使用该账户。要换 Token 就粘贴新的再点「修改并保存」；' +
        '要新增账号请选「＋ 新建账户」。'
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
    kvOptions = []
    renderKvOptions()
    $text('detAccount').textContent = '—'
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
   */
  function clearDeployFormFields(): void {
    for (const id of [
      'controlProject',
      'dataProject',
      'panelPath',
      'wsPath',
      'deployPanelPassword',
    ]) {
      const el = document.getElementById(id) as HTMLInputElement | null
      if (el) el.value = ''
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

  async function loadRuntimeStatus(): Promise<void> {
    try {
      const st = await window.cfpilot.serviceStatus()
      $text('rtLocal').textContent =
        '运行中 · 端口 ' + st.port + ' · 已运行 ' + fmtUptime(st.uptimeSeconds)
    } catch {
      $text('rtLocal').textContent = '读取失败'
    }
    try {
      const dep = await window.cfpilot.checkDeployed()
      $text('rtDeploy').textContent = dep.hasDeploy
        ? (dep.controlProject || '?') + ' / ' + (dep.dataProject || '?')
        : '尚未部署'
      // 用 state 而不是版本号：build 是内容指纹（hash-hash），对用户没有意义
      const stateText: Record<string, string> = {
        latest: '已是最新',
        outdated: '线上版本较旧，可更新',
        blocked: '部署被平台标记，需处理',
        none: '尚未部署',
      }
      $text('rtKernel').textContent = stateText[dep.state] || dep.state || '—'
    } catch {
      $text('rtDeploy').textContent = '读取失败'
      $text('rtKernel').textContent = '—'
    }
    try {
      const env = await window.cfpilot.checkEnvironment()
      $text('rtEnv').textContent = env.clean
        ? '未发现干扰因素'
        : (env.findings || []).length + ' 项提示'
    } catch {
      $text('rtEnv').textContent = '读取失败'
    }
  }

  function bindRuntime(): void {
    const refresh = document.getElementById('btnRtRefresh')
    if (refresh) {
      refresh.addEventListener('click', () => {
        void loadRuntimeStatus()
      })
    }
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
        $text('detHint').textContent = '填好 Token 并「添加并保存」后会自动检测账号。'
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
        $text('detHint').textContent = '该账户还没填 Token，请粘贴后点「修改并保存」。'
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
      $text('detAccount').textContent =
        result.accountName ? result.accountName + '（' + result.accountId + '）' : '—'
      if (!result.accountId) {
        $text('detHint').textContent = '没能读到账号，请检查 Token 权限是否正确。'
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
      $text('detHint').textContent = '检测失败，请检查网络与 Token。'
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
    const hint = $text('detHint')

    if (instances.length === 0) {
      hint.textContent = '这个账号下还没有部署过 CFPilot，去「部署」页部署一次即可。'
      showCredAlert('danger', '未检查到CFPilot 实例，请到「部署」页全新部署。')
      log('该账号下没有已部署实例，请到「部署」页全新部署', 'warn')
      return
    }

    if (instances.length === 1) {
      const only = instances[0]
      $sel('kvSelect').value = only.id
      updateKvHint()
      try {
        // 选中即保存：唯一实例没有歧义，不该再让用户点一次「保存」
        await window.cfpilot.saveCredentials({ kvNamespaceId: only.id })
      } catch {
        /* 保存失败不阻断：下拉框当前值仍会用于本次部署 */
      }
      hint.textContent = '已自动选中该账号下唯一的 CFPilot 实例。'
      showCredAlert(
        'ok',
        '已自动选中唯一的 CFPilot 实例 <code>' + escapeHtml(only.title) + '</code>，KV 已保存。'
      )
      log('检测到 1 个实例，已自动选中并保存 KV：' + only.title, 'ok')
      return
    }

    // ≥2 个：绝不替用户选 —— 选错会让所有功能作用到错的实例上
    hint.textContent = '检测到多个 CFPilot 实例，请从下方选择本次使用的 KV。'
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
        await refreshProfiles()
        await refreshCredState()
        // 新建后自动检测，省得用户再点一次
        await detectAccountAndGuide()
        return
      }

      await window.cfpilot.saveCredentials({ cfToken: token })
      log('Token 已更新到当前账户', 'ok')
      resetAccountContext()
      await refreshProfiles()
      await refreshCredState()
      await detectAccountAndGuide()
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

  /**
   * 统一的忙碌态开关。
   *
   * ⚠️ 不要用 `setAttribute('disabled', '')` 来「取消禁用」：
   * HTML 里只要 disabled 属性**存在**就是禁用状态，
   * 设成空字符串仍然禁用，表现为按钮永久变灰、必须重启程序。
   * 必须用 removeAttribute 或直接操作 .disabled 属性。
   */
  function setBusy(busy: boolean): void {
    for (const id of [
      'btnDeploy',
      'btnCheck',
      'btnScan',
      'btnDetect',
      'btnKvRefresh',
      'btnKvManual',
      'btnAutoDetect',
    ]) {
      const el = document.getElementById(id) as HTMLButtonElement | null
      if (el) el.disabled = busy
    }
  }

  function bindDeploy(): void {
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
      let kvId = select.value
      if (!kvId) {
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
      log('── 开始部署 ──')

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
            mode: readMode(),
            force: $('optForce').checked,
            forceKv: $('optForceKv').checked,
            newCredentials: $('optNewCred').checked,
            controlProject: $('controlProject').value.trim(),
            dataProject: $('dataProject').value.trim(),
            panelPath: $('panelPath').value.trim(),
            wsPath: $('wsPath').value.trim(),
            // 本次部署要设的面板密码（留空 = 随机 / 沿用清单）
            panelPassword: deployPw,
          },
          kvId
        )
        const status = document.getElementById('deployStatus')!
        status.textContent = result.ok ? '✅ 部署完成' : '❌ 部署失败：' + (result.error ?? '')

        // 成功时**不再重复打印**面板地址与密码。
        //
        // 部署向导本身在结束时就会打印一次「控制面 / 数据面 / UUID / WS 路径 /
        // 面板密码」的汇总块，这里再打一遍等于同一份信息出现两次，
        // 反而让人怀疑是不是部署了两次。只补一句结束标记即可。
        if (result.ok) {
          log('── 部署成功（详细信息见上方汇总）──', 'ok')
          // 部署成功后自动刷新状态：版本已同步，按钮应回到「已是最新」
          const select = $sel('kvSelect')
          await window.cfpilot.checkDeployed(select.value || undefined)
        }
      } catch (err) {
        log('部署异常：' + (err instanceof Error ? err.message : String(err)), 'err')
        document.getElementById('deployStatus')!.textContent = '❌ 部署异常'
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
      } catch (err) {
        log('检查失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      } finally {
        if (btn) btn.disabled = false
      }
    })


    /**
     * 显示部署清单里保存的面板凭据。
     *
     * Cloudflare 平台上的环境变量是**加密的**（页面只显示 `****`），
     * 所以部署完成后如果没记下面板密码，用户就再也拿不回来，面板进不去。
     *
     * 这里的值从**本机部署清单**（KV 里的 CFP_DEPLOY_MANIFEST）读取，
     * 不依赖云端变量的可见性。
     */
    document.getElementById('btnShowCreds')?.addEventListener('click', async () => {
      const box = document.getElementById('credBox')
      if (!box) return

      // 已经展开就收起（切换行为，避免重复请求）
      if (!box.hidden) {
        box.hidden = true
        return
      }

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
        set('credPanelUrl', r.panelUrl ?? '')
        set('credPanelPw', r.panelPassword ?? '')
        set('credUuid', r.uuid ?? '')
        set('credWsPath', r.wsPath ?? '')
        box.hidden = false

        // 自动复制到剪贴板
        //
        // 用户点「查看面板凭据」几乎总是为了拿去登录面板，
        // 再点一次「复制全部」属于多余步骤。
        const text = [
          '面板地址：' + (r.panelUrl ?? ''),
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

    // 复制全部凭据到剪贴板
    document.getElementById('btnCopyCreds')?.addEventListener('click', async () => {
      const g = (id: string): string => document.getElementById(id)?.textContent ?? ''
      const text = [
        '面板地址：' + g('credPanelUrl'),
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

  function renderScanResult(payload: {
    entries: Array<{ ip: string; port: number; colo: string; latency: number; tlsMs: number; speed: number }>
    copyable: string
    skippedSpeed?: boolean
  }): void {
    const out = $('scanOut')
    out.textContent = payload.copyable || '（没有结果）'
    const table = document.getElementById('scanTable') as HTMLTableElement
    const tbody = table.querySelector('tbody')!
    tbody.innerHTML = ''
    payload.entries.forEach((e, i) => {
      const tr = document.createElement('tr')
      // 跳过测速时速度本就是 0，显示 — 而不是 0，避免误解成「测出来是 0」
      const speed = payload.skippedSpeed ? '—' : String(e.speed)
      // TLS 握手耗时是「导入后会不会 -1」的关键指标，放在最前面
      const tls = e.tlsMs > 0 ? String(e.tlsMs) : '—'
      const cells = [String(i + 1), e.ip + ':' + e.port, e.colo, tls, String(e.latency), speed]
      for (const c of cells) {
        const td = document.createElement('td')
        td.textContent = c
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
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

    const pushBtn = document.getElementById('btnPushToPanel') as HTMLButtonElement | null
    const pushHint = document.getElementById('pushHint')
    if (pushBtn) pushBtn.disabled = lastScanLines.length === 0
    if (pushHint) {
      pushHint.textContent =
        lastScanLines.length > 0
          ? '上方是本次结果。需要让订阅用上这些 IP 就点「回填面板」。'
          : ''
    }
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
      $('scanOut').textContent = '正在优选，请稍候…'
      try {
        const result = await window.cfpilot.runScan({
          host,
          // 端口固定 443：Pages 的 HTTPS 入口，2053 等端口在部分网络会被阻断
          wsPath: path,
          probePath,
          skipSpeed: $('optNoSpeed').checked,
          sample: Number($('optSample').value) || 6556,
          top: Number($('optTop').value) || 15,
          countries: readOptCountries(),
          speedMode: speedUrl ? 'url' : 'auto',
          speedUrl,
          speedConnections: Number($('optSpeedConns').value) || 3,
          speedDurationMs: (Number($('optSpeedDur').value) || 6) * 1000,
          // ⚠️ 必须把「不回填」勾选状态传给后端
          //
          // 界面也没有读取勾选状态的地方 —— 于是用户取消勾选后
          // 点开始优选，界面重渲染时又把默认值（checked）勾了回去，
          // 看起来像「勾选被自动恢复」，实际是整个开关没接线。
          // 优选阶段**不回填**
          //
          // 回填改为结果出来后手动点「回填面板」按钮再执行。
          // 好处：
          //   1. 令牌在回填那一刻才申请，不会因为优选耗时而过期
          //   2. 用户不必理解令牌机制，看到结果再决定要不要回填
          noCallback: true,
        })
        if (!result.ok) {
          $('scanOut').textContent = '优选失败：' + (result.error ?? '')
        }
      } catch (err) {
        log('优选异常：' + (err instanceof Error ? err.message : String(err)), 'err')
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
     * 回填需要临时令牌（面板签发，10 分钟有效）。
     * 令牌很容易在回填前就过期，而且界面上多一个令牌输入框，
     * 用户还得理解「令牌」是什么东西。
     *
     * 现在改为：点这个按钮时才「取令牌 → 回填」，一气呵成。
     * 既不会超时，用户也没有学习成本 —— 拿到结果按一下就好。
     */
    document.getElementById('btnPushToPanel')!.addEventListener('click', async () => {
      const btn = document.getElementById('btnPushToPanel') as HTMLButtonElement | null
      const hint = document.getElementById('pushHint')

      if (lastScanLines.length === 0) {
        log('还没有优选结果，先跑一次优选', 'warn')
        return
      }
      if (btn) btn.disabled = true
      if (hint) hint.textContent = '正在申请临时令牌…'

      try {
        const tokenRes = await window.cfpilot.fetchScannerToken()
        if (!tokenRes || !tokenRes.ok) {
          const msg = (tokenRes && tokenRes.error) || '未知错误'
          if (hint) hint.textContent = '获取令牌失败：' + msg
          log('回填失败：' + msg, 'err')
          return
        }

        if (hint) hint.textContent = '正在回填到面板…'
        const result = await window.cfpilot.pushScanResults(lastScanLines)
        if (!result || !result.ok) {
          const msg = (result && result.error) || '未知错误'
          if (hint) hint.textContent = '回填失败：' + msg
          log('回填失败：' + msg, 'err')
          return
        }

        const n = result.count ?? lastScanLines.length
        if (hint) {
          hint.textContent =
            '✅ 已回填 ' + n + ' 条到面板。打开面板「节点来源 → 手动优选 IP」点「查看」即可看到。'
        }
        log('✅ 已回填 ' + n + ' 条到面板的「手动优选 IP」', 'ok')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (hint) hint.textContent = '回填失败：' + msg
        log('回填失败：' + msg, 'err')
      } finally {
        if (btn) btn.disabled = false
      }
    })

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
            if (host.source === 'custom') {
              log(`已填入自定义域名：${host.host}`, 'ok')
            } else {
              log(`已填入 pages.dev 域名：${host.host}`, 'warn')
              log('该实例没有绑定自定义域名。建议绑定后再优选——', 'warn')
              log('pages.dev 生产链接在部分网络环境会被阻断，测出来的结果不可信。', 'warn')
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
        } catch (err) {
          log('识别 WS 路径异常：' + (err instanceof Error ? err.message : String(err)), 'err')
        }
      } finally {
        if (btn) btn.disabled = false
      }
    })

    document.getElementById('btnEnvCheck')!.addEventListener('click', async () => {
      log('检测网络环境…')
      const btn = document.getElementById('btnEnvCheck') as HTMLButtonElement | null
      if (btn) btn.disabled = true
      try {
        // ⚠️ 必须**总是**输出结果
        //
        // **一个字都不打** —— 用户点了按钮看到日志里只有「检测网络环境…」
        // 然后什么都没有，看起来就是按钮坏了。
        //
        // 正确行为：
        //   - 正常 → 明确说「正常」
        //   - 有发现 → 逐条列出发现项，并说明对优选结果的影响
        const result = await window.cfpilot.checkEnvironment()

        if (result.clean) {
          log('✅ 环境正常，优选结果可信', 'ok')
        } else {
          log('⚠ 检测到网络环境异常，优选结果可能失真：', 'warn')
          const findings = result.findings ?? []
          if (findings.length === 0) {
            log('  （未提供具体发现项）', 'warn')
          } else {
            for (const f of findings) {
              log('  · ' + f, 'warn')
            }
          }
          log('  建议：关闭系统代理 / TUN 模式后重新优选', 'warn')
        }
      } catch (err) {
        log('检测失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      } finally {
        if (btn) btn.disabled = false
      }
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
    window.cfpilot.onLog((entry) => log(entry.message, entry.level as never))

    /**
     * 渲染部署状态，并**同步驱动部署按钮的语义**。
     *
     * 交互设计：
     *   - 状态卡只回答「现在什么情况」，不承载操作；
     *   - 部署卡的按钮文案随状态变化：
     *       none     → 「开始首次部署」
     *       outdated → 「更新到最新内核」(primary 高亮)
     *       latest   → 「重新部署」(ghost，弱化)
     *   - 用户不需要理解「auto/update/fresh」也能直接用默认的「自动判断」。
     *
     * ⚠️ 不自动填 optHost：`dataProject` 是**项目名**不是域名，
     * 项目名与子域不保证一致（用户可自定义子域）。
     * 域名走「自动识别域名」按钮读真实 subdomain / 自定义域名。
     */
    // 赋值给前面声明的引用：让「检查状态」按钮也能调用同一个渲染逻辑
    applyDeployStatus = (status: DeployStatusLike): void => {
      const el = document.getElementById('deployStatus')
      const box = document.getElementById('deployStateBox')
      const btn = document.getElementById('btnDeploy') as HTMLButtonElement | null
      const hint = document.getElementById('deployActionHint')
      if (!el || !box || !btn) return

      const setBtn = (label: string, primary: boolean): void => {
        btn.textContent = label
        btn.classList.toggle('btn-primary', primary)
        btn.classList.toggle('btn-ghost', !primary)
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
        el.innerHTML =
          '<span class="badge warn">需要先完成设置</span><br>' +
          '<b>' + escapeHtml(g.title) + '</b><br>' +
          escapeHtml(g.body) +
          '<br><span style="color:var(--muted)">👉 ' + escapeHtml(g.action) + '</span>'
        setBtn('开始部署', true)
        btn.disabled = false
        if (hint) hint.textContent = '完成上面的设置后，回来再点一次「检查状态」。'
        return
      }
      btn.disabled = false

      if (!status.hasDeploy) {
        el.innerHTML =
          '这个 KV 里<b>还没有部署记录</b> —— 点下面的按钮会创建新的控制面与数据面项目。'
        setBtn('开始首次部署', true)
        if (hint) hint.textContent = '首次部署会生成新的 UUID、WS 路径与面板密码，请存好。'
        return
      }

      const instance =
        '<b>' + escapeHtml(status.controlProject ?? '?') + '</b> / <b>' +
        escapeHtml(status.dataProject ?? '?') + '</b>'
      const deployedAt = status.at
        ? '<br><span style="color:var(--muted)">上次部署：' + escapeHtml(status.at) + '</span>'
        : ''

      /**
       * 内核版本信息行。
       *
       * `build` 是 build 指纹（`<hash>-<hash>`），只能判断「一样不一样」，
       * **判断不了新旧** —— 而部署代码现在可以独立于应用版本更新，
       * 所以必须用可比较的 semver（`kernelVersion`）来判断。
       */
      const kernelLine = (): string => {
        const parts: string[] = []
        if (status.kernelVersion) {
          parts.push('线上内核 <code>' + escapeHtml(status.kernelVersion) + '</code>')
        }
        if (status.localKernelVersion) {
          parts.push('应用内置 <code>' + escapeHtml(status.localKernelVersion) + '</code>')
        }
        if (status.remoteKernelVersion) {
          parts.push('最新可用 <code>' + escapeHtml(status.remoteKernelVersion) + '</code>')
        }
        if (parts.length === 0) return ''
        return '<br>' + parts.join(' · ')
      }

      /**
       * 「内核可更新」提示。
       *
       * 远程内核比线上新时出现 —— 告诉用户点哪个按钮。
       */
      const kernelUpdateHint = (): string => {
        if (!status.kernelUpdatable) return ''
        const target = status.remoteKernelVersion ? '（可更新到 ' + escapeHtml(status.remoteKernelVersion) + '）' : ''
        return (
          '<br><span style="color:var(--warn)">👉 线上内核有新版' + target +
          '，点下面的「更新部署」即可升级 —— <b>不需要升级本程序</b></span>'
        )
      }

      if (status.state === 'latest') {
        el.innerHTML =
          '<span class="badge ok">已是最新</span><br>' +
          '实例：' + instance + '<br>' +
          '内核版本 <code>' + escapeHtml(status.localBuild ?? '') + '</code>' +
          kernelLine() + kernelUpdateHint() + deployedAt
        setBtn('重新部署', false)
        if (hint) {
          hint.textContent = status.kernelUpdatable
            ? '线上内核与本地一致，但远程有更新的内核可用 —— 点「重新部署」会升到最新版。'
            : '线上与本地内核版本一致，通常不需要再部署。'
        }
        return
      }

      // 三种子情况分开表达，绝不让用户看到 `unknown` 这种占位符
      if (!status.build) {
        // 线上没有版本记录（早期部署的，或当时没读到本地版本）
        el.innerHTML =
          '<span class="badge warn">建议更新</span><br>' +
          '实例：' + instance + '<br>' +
          '线上部署记录里<b>没有内核版本号</b>（较早版本部署的）<br>' +
          '本地内核版本：<code>' + escapeHtml(status.localBuild ?? '读取失败') + '</code>' +
          kernelLine() + kernelUpdateHint() + deployedAt
        setBtn('更新并记录版本', true)
        if (hint) {
          hint.textContent =
            '更新一次即可写入版本号，之后就能正常比对。会沿用原 UUID 与 WS 路径。'
        }
        return
      }

      if (!status.localBuild) {
        // 本地读不到版本 —— 通常是产物缺失
        el.innerHTML =
          '<span class="badge err">本地产物异常</span><br>' +
          '实例：' + instance + '<br>' +
          '线上内核版本：<code>' + escapeHtml(status.build) + '</code><br>' +
          '但<b>读不到本地内核版本</b> —— 应用内的内核产物可能缺失' +
          kernelLine() + deployedAt
        setBtn('重新部署', false)
        if (hint) hint.textContent = '请重新安装或联系维护者；直接部署可能上传不完整的产物。'
        return
      }

      // 正常差异：线上旧、本地新
      el.innerHTML =
        '<span class="badge warn">可更新</span><br>' +
        '实例：' + instance + '<br>' +
        '线上内核 <code>' + escapeHtml(status.build) + '</code>' +
        ' → 本地 <code>' + escapeHtml(status.localBuild) + '</code>' +
        kernelLine() + kernelUpdateHint() + deployedAt
      setBtn('更新到最新内核', true)
      if (hint) {
        hint.textContent =
          '更新会沿用原 UUID 与 WS 路径，客户端订阅地址不用改。'
      }
    }

    // 事件入口：部署完成后主进程 / SSE 推送状态时也走同一个渲染函数
    window.cfpilot.onDeployStatus((status) => {
      if (applyDeployStatus) applyDeployStatus(status as DeployStatusLike)
    })

    window.cfpilot.onScanResult((payload) => renderScanResult(payload))

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

  document.addEventListener('DOMContentLoaded', async () => {
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

    bindProfiles()
    bindRuntime()
    bindCredentials()
    bindDeploy()
    bindChain()
    bindScan()
    bindLogs()
      bindUpdater()
    bindPush()

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
      const valid = ['cred', 'deploy', 'scan', 'about', 'logs']
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