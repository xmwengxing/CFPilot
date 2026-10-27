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

  /* ---------------- 导航 ---------------- */
  function switchPage(name: string): void {
    document.querySelectorAll('#nav button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.page === name)
    })
    document.querySelectorAll('.page').forEach((p) => {
      p.classList.toggle('active', p.id === 'page-' + name)
    })
    // 切页时把焦点从输入框移开，避免背景页仍可 Tab 到
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  /* ---------------- 日志 ---------------- */
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

  /* ---------------- 凭据 ---------------- */

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
   * ## 为什么用「可空引用 + 定义处赋值」而不是直接定义函数
   *
   * `checkDeployed()` 的返回值**不会自动渲染**，需要调用方把结果喂进来。
   * 最初它只挂在 `onDeployStatus` 事件上，而「检查状态」按钮只
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

    // 自动刷新 KV 列表（2026-10-27 用户要求减少点击）
    //
    // 早期需要手动点「刷新 KV 列表」。但用户已经在账户页了，
    // 系统也知道账号 ID，没理由还让用户点一次。
    // 这里只在「本地缓存为空」时触发，避免每次刷新都打 API。
    if (kvOptions.length === 0 && currentAccountId) {
      try {
        const opts = await window.cfpilot.listKvOptions(currentAccountId)
        kvOptions = opts.options
        renderKvOptions(state.kvNamespaceId || undefined)
        log(`共 ${kvOptions.length} 个命名空间`, 'ok')
      } catch {
        /* 拉取失败不阻断，用户仍可手动点「刷新 KV 列表」 */
      }
    }

    // 自动选中当前账户保存的 KV（2026-10-27 用户要求）
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
      opt.textContent = currentAccountId ? '（没有可用的 KV，点「新建 KV」）' : '— 请先检测账号 —'
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
        ? '请选择一个命名空间，或点「新建 KV」为本次部署单独建一个。'
        : '点「刷新 KV 列表」查看账号下有哪些命名空间。'
      deployKv.textContent = '—'
      return
    }
    if (item.ownership === 'instance') {
      hint.textContent =
        `这是本工具部署的实例：控制面 ${item.controlProject} / 数据面 ${item.dataProject}，` +
        `部署于 ${item.at}。选它 = 更新这个实例（UUID 与 WS 路径不变）。`
      deployKv.textContent = `${item.title}（${item.id}）`
    } else if (item.ownership === 'foreign') {
      hint.textContent =
        '此命名空间已被其他项目占用，不能用于 CFPilot。' +
        'CFPilot 的数据面已完全自研，两者不再共用同一 KV' +
        '（会共享配额、混淆配置、让排查变难）。请点上方「新建 KV」单独建一个。'
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

  /* ---------------- 多账户（profile） ---------------- */

  /** 「当前使用」下拉框里代表「新建账户」的哨兵值（不会与真实 profile id 冲突） */
  const NEW_PROFILE_VALUE = '__new__'

  /** 当前所有账户配置（渲染层缓存，不含 Token 明文） */
  let profiles: CFPilotProfileView[] = []

  /**
   * 重新拉取账户列表并渲染下拉框。
  /**
   * 重新拉取账户列表并渲染下拉框。
   *
   * ## 下拉框的两种选项（2026-10-26 重构交互）
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

  /** 切换账户后清空上一账户的所有上下文，避免误操作 */
  function resetAccountContext(): void {
    currentAccountId = ''
    kvOptions = []
    renderKvOptions()
    $text('detAccount').textContent = '—'
    $('cfToken').value = ''
    $('panelPassword').value = ''
  }

  /** 绑定账户管理相关事件 */
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
   * 检测账号并给出「下一步该做什么」的引导。
   *
   * 用户要求（2026-10-26）：
   *   - 检测到已有 CFPilot 实例 → 提示去下方 KV 里选本次要用的那个，再点「保存此选择」
   *   - 没检测到 → 提示在下方新建 KV 并保存
   */
  async function detectAccountAndGuide(): Promise<void> {
    if (!hasActiveToken()) return
    log('检测账号…')
    try {
      const result = await window.cfpilot.detectAccount()
      $text('detAccount').textContent =
        result.accountName ? result.accountName + '（' + result.accountId + '）' : '—'
      if (!result.accountId) {
        $text('detHint').textContent = '没能读到账号，请检查 Token 权限是否正确。'
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

      const instances = kvOptions.filter((o) => o.ownership === 'instance')
      const hint = $text('detHint')
      if (instances.length > 0) {
        hint.innerHTML =
          `检测到 <b>${instances.length}</b> 个已部署的 CFPilot 实例：` +
          instances.map((i) => `<code>${escapeHtml(i.title)}</code>`).join('、') +
          '。<br>请在下方「本次部署使用的 KV」里选择要维护的那个，再点「保存此选择」。'
        log(`检测到 ${instances.length} 个已部署实例，请到下方选择本次使用的 KV`, 'ok')
      } else {
        hint.innerHTML =
          '这个账号下<b>还没有部署过 CFPilot</b>。<br>' +
          '请在下方点「新建 KV（部署新实例）」，建好后点「保存此选择」，再去「一键部署」页部署。'
        log('该账号下没有已部署实例，请到下方新建 KV', 'warn')
      }
    } catch (err) {
      log('检测账号失败：' + (err instanceof Error ? err.message : String(err)), 'err')
      $text('detHint').textContent = '检测失败，请检查网络与 Token。'
    }
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
     * ## 关键：新建 vs 修改必须走不同路径（2026-10-26 修复）
     *
     * 早前无论什么情况都调 `saveCredentials()`，而它写的是「当前激活 profile」——
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
        // ---- 新建：createProfile + 立刻写入 Token ----
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

      // ---- 修改：写到当前激活账户 ----
      await window.cfpilot.saveCredentials({ cfToken: token })
      log('Token 已更新到当前账户', 'ok')
      resetAccountContext()
      await refreshProfiles()
      await refreshCredState()
      await detectAccountAndGuide()
    })

    document.getElementById('btnDetect')!.addEventListener('click', async () => {
      if (!hasActiveToken() && !$('cfToken').value.trim()) {
        log('请先填写 API Token 并保存', 'warn')
        return
      }
      await detectAccountAndGuide()
    })


    document.getElementById('btnDetect')!.addEventListener('click', async () => {
      // 没有激活的账户配置时先建一份，避免「检测了但没地方存」
      if (profiles.length === 0) {
        log('还没有账户配置，先新建一份…')
        await window.cfpilot.createProfile()
        await refreshProfiles()
      }

      log('检测账号…')
      const result = await window.cfpilot.detectAccount()
      $text('detAccount').textContent =
        result.accountName ? result.accountName + '（' + result.accountId + '）' : '—'
      if (result.accountId) {
        currentAccountId = result.accountId
        // 把账号名写回当前 profile —— 下拉框就能显示「主账号（xxx）」而不只是「新账户」
        const active = profiles.find((p) => p.active)
        if (active) {
          await window.cfpilot.updateProfile(active.id, {
            accountId: result.accountId,
            accountName: result.accountName,
          })
          await refreshProfiles()
        }
        await loadKvOptions()
      }
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

    document.getElementById('btnKvSave')!.addEventListener('click', async () => {
      const id = $sel('kvSelect').value
      if (!id) { log('请先选择一个 KV 命名空间', 'warn'); return }
      await window.cfpilot.saveCredentials({ kvNamespaceId: id })
      log('已保存本次选择的 KV', 'ok')
    })

    // KV 下拉框改变时**自动保存**（2026-10-27 用户要求「不要增加操作步骤」）
    //
    // 早期需要额外点「保存此选择」按钮，属于多余步骤：
    // 用户既然在这个下拉框里选了，意图已经明确。
    // 现在选完立刻落盘，那个按钮可以不用点（保留是为了兼容旧习惯）。
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

  /* ---------------- 部署 ---------------- */
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
      'btnKvSave',
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
     * ## 为什么用这种写法（2026-10-26 修复「检查状态没反应」）
     *
     * `checkDeployed()` 的返回值**不会自动渲染**，需要调用方把结果喂进来。
     * 最初它只挂在 `onDeployStatus` 事件上，而「检查状态」按钮只
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
      // 用下拉框当前选中的 KV；没有选中则自动新建（2026-10-27 用户要求）
      //
      // ## 为什么自动建而不是让用户先去建
      //
      // 全新部署本来就必须有一个 KV（内核的配置键全局平铺在里面）。
      // 早期让用户先到「Cloudflare 凭据」页点「新建 KV」，
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
      // （2026-10-27 用户明确要求两个用途分开）。
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

        // 成功时**不再重复打印**面板地址与密码（2026-10-26 用户反馈）。
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
        // ⚠️ 必须把返回值渲染出来（2026-10-26 修复）
        //
        // 早前只 `await` 不接收结果 → 用户点完按钮界面上什么都不变，
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

    /* ---------------- 查看面板凭据 ---------------- */

    /**
     * 显示部署清单里保存的面板凭据。
     *
     * ## 为什么需要（2026-10-27 用户反馈）
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

        // 自动复制到剪贴板（2026-10-27 用户要求减少点击）
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

  /* ---------------- 优选 ---------------- */

  /** 读取国家多选框的选中值（空数组 = 不筛选，跑全量） */
  function readOptCountries(): string[] {
    const sel = $sel('optCountries')
    const out: string[] = []
    for (const opt of Array.from(sel.selectedOptions)) {
      const value = opt.value.trim()
      if (value) out.push(value)
    }
    return out
  }

  /**
   * 填充国家多选框。
   *
   * 列表走 IPC 从 scanner-lib 取（与面板、命令行版同一张表）。
   * 旧版 scanner-lib 没有该导出时返回空列表，此时禁用多选框并提示全量测试。
   */
  async function fillCountryOptions(): Promise<void> {
    const sel = $sel('optCountries')
    sel.innerHTML = ''
    let list: Array<{ code: string; name: string }> = []
    try {
      list = await window.cfpilot.listScanCountries()
    } catch {
      list = []
    }
    if (list.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '（国家列表不可用，将直接全量测试）'
      sel.appendChild(opt)
      sel.disabled = true
      return
    }
    for (const c of list) {
      const opt = document.createElement('option')
      opt.value = c.code
      opt.textContent = `${c.name}（${c.code}）`
      sel.appendChild(opt)
    }
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

    // ---- 记录结果并启用「回填面板」按钮（2026-10-27 交互改版）----
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
          // ⚠️ 必须把「不回填」勾选状态传给后端（2026-10-27 修复）
          //
          // 早期完全不传这个参数：Go 后端没有回填实现，
          // 界面也没有读取勾选状态的地方 —— 于是用户取消勾选后
          // 点开始优选，界面重渲染时又把默认值（checked）勾了回去，
          // 看起来像「勾选被自动恢复」，实际是整个开关没接线。
          // 优选阶段**不回填**（2026-10-27 交互改版）
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

    /* ---------------- 优选结果：复制 / 回填 ---------------- */

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
     * ## 为什么放在「优选之后」才做（2026-10-27 交互改版）
     *
     * 回填需要临时令牌（面板签发，10 分钟有效）。
     * 早期是「优选前先取令牌」，但优选本身要跑几分钟 ——
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
        // ---- 1. 现取临时令牌（10 分钟有效，足够用）----
        const tokenRes = await window.cfpilot.fetchScannerToken()
        if (!tokenRes || !tokenRes.ok) {
          const msg = (tokenRes && tokenRes.error) || '未知错误'
          if (hint) hint.textContent = '获取令牌失败：' + msg
          log('回填失败：' + msg, 'err')
          return
        }

        // ---- 2. 回填 ----
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
     * 自动识别：一次填好域名 + WS 路径（2026-10-27 用户要求减少点击）。
     *
     * 早期是两个按钮（「自动识别域名」+「自动识别 WS 路径」），
     * 但它们读的是同一份部署清单，用户总是要连点两次 —— 属于多余步骤。
     *
     * 现在一次点击同时调两个接口，任一失败不影响另一个。
     */
    document.getElementById('btnAutoDetect')!.addEventListener('click', async () => {
      const btn = document.getElementById('btnAutoDetect') as HTMLButtonElement | null
      if (btn) btn.disabled = true
      log('自动识别域名与 WS 路径…')

      try {
        // ---- 域名 ----
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

        // ---- WS 路径 ----
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
        // ⚠️ 必须**总是**输出结果（2026-10-27 用户反馈「按钮没效果」）
        //
        // 早期只在 `if (result.clean)` 分支里 log，环境不干净时
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

  /* ---------------- 应用内更新 ---------------- */
  let pendingUpdateUrl = ''

  function bindUpdater(): void {
    document.getElementById('btnCheckUpdate')!.addEventListener('click', async () => {
      const badge = document.getElementById('updateBadge')!
      const hint = document.getElementById('updateHint')!
      badge.textContent = '检查中…'
      badge.className = 'badge info'
      try {
        const result = await window.cfpilot.checkUpdate()
        if (result.error) {
          badge.textContent = '检查失败'
          badge.className = 'badge err'
          hint.textContent = '检查失败：' + result.error
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
      }
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

  /* ---------------- 复制 ---------------- */
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

  /* ---------------- 主进程推送 ---------------- */
  function bindPush(): void {
    window.cfpilot.onLog((entry) => log(entry.message, entry.level as never))

    /**
     * 渲染部署状态，并**同步驱动部署按钮的语义**。
     *
     * 交互设计（2026-10-25 重构，解决「这页选项和按钮有点乱」）：
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

      if (status.state === 'latest') {
        el.innerHTML =
          '<span class="badge ok">已是最新</span><br>' +
          '实例：' + instance + '<br>' +
          '内核版本 <code>' + escapeHtml(status.localBuild ?? '') + '</code>' +
          deployedAt
        setBtn('重新部署', false)
        if (hint) hint.textContent = '线上与本地内核版本一致，通常不需要再部署。'
        return
      }

      // ---- outdated ----
      // 三种子情况分开表达，绝不让用户看到 `unknown` 这种占位符
      if (!status.build) {
        // 线上没有版本记录（早期部署的，或当时没读到本地版本）
        el.innerHTML =
          '<span class="badge warn">建议更新</span><br>' +
          '实例：' + instance + '<br>' +
          '线上部署记录里<b>没有内核版本号</b>（较早版本部署的）<br>' +
          '本地内核版本：<code>' + escapeHtml(status.localBuild ?? '读取失败') + '</code>' +
          deployedAt
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
          '但<b>读不到本地内核版本</b> —— 应用内的内核产物可能缺失' + deployedAt
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
        deployedAt
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

  /* ---------------- 启动 ---------------- */
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

    /* ------------------------------------------------------------------ */
    /* 日志区拖拽调高                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * 拖动日志面板上边缘调整高度。
     *
     * ## 为什么记录「比例」而不是「像素」（2026-10-26 第三次迭代）
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
     * ## 为什么必须这样写（2026-10-26 真实故障）
     *
     * 早期实现是一串裸 await：
     *
     *     await refreshProfiles()
     *     await refreshCredState()
     *     renderKvOptions()
     *     void fillCountryOptions()   ← 前面任何一步抛异常，这行永远不执行
     *
     * 用户在 Go 版里遇到的现象是「机房国家列表一直停在『正在加载国家列表…』」，
     * 但后端接口实测返回 39 个国家完全正常 ——
     * 说明**初始化在某一步中断了**，后面的 fillCountryOptions 根本没被调用。
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
    bindCredentials()
    bindDeploy()
    bindScan()
    bindUpdater()
    bindPush()

    await runStep('账户列表', refreshProfiles)
    await runStep('凭据状态', refreshCredState)
    await runStep('KV 选项', () => {
      renderKvOptions()
    })
    // 国家列表：不 await，避免拖慢界面；失败也不影响其它功能
    void runStep('国家列表', fillCountryOptions)

    log('CFPilot GUI 已就绪')
    log('凭据只保存在本机，不会上传')
  })
})()