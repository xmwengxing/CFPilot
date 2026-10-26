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
        opt.textContent = `○ ${item.title} — 已被其他项目占用`
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
        '此命名空间正被另一个项目使用（键名与本工具不重叠，可以共存），' +
        '但建议为 CFPilot 单独建一个，避免混淆。'
      deployKv.textContent = `${item.title}（${item.id}）`
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

    document.getElementById('btnKvNew')!.addEventListener('click', async () => {
      if (!currentAccountId) { log('请先点「检测账号」', 'warn'); return }
      const created = await window.cfpilot.createKvNamespace(currentAccountId)
      if (!created) return
      log(`已创建 KV：${created.title}`, 'ok')
      await loadKvOptions()
      const select = $sel('kvSelect')
      select.value = created.id
      updateKvHint()
      log('已为新实例选中新建的 KV，可直接部署', 'ok')
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

    $('kvSelect').addEventListener('change', () => { updateKvHint() })

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
      'btnKvNew',
      'btnKvSave',
      'btnKvManual',
      'btnAutoHost',
      'btnAutoPath',
    ]) {
      const el = document.getElementById(id) as HTMLButtonElement | null
      if (el) el.disabled = busy
    }
  }

  function bindDeploy(): void {
    document.getElementById('btnDeploy')!.addEventListener('click', async () => {
      // 用下拉框当前选中的 KV；没有选中则回落到本机保存的值
      const select = $sel('kvSelect')
      const kvId = select.value
      if (!kvId) {
        log('请先在「Cloudflare 凭据」页选择 KV 命名空间（可点「新建 KV」）', 'warn')
        const st = document.getElementById('deployStatus')
        if (st) {
          st.innerHTML =
            '<span class="badge warn">需要先完成设置</span><br>' +
            '<b>还没选择 KV 命名空间</b><br>' +
            '<span style="color:var(--muted)">👉 去「Cloudflare 凭据」页点「刷新 KV 列表」并选择</span>'
        }
        return
      }
      setBusy(true)
      log('── 开始部署 ──')

      // 部署页填了面板密码就先写入当前账户（部署读的是账户里的值）。
      // 留空表示「沿用原密码/随机生成」，不要覆盖已有值。
      const deployPw = $('deployPanelPassword').value
      if (deployPw.trim()) {
        await window.cfpilot.saveCredentials({ panelPassword: deployPw })
        log('已使用本次填写的面板密码')
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
      await window.cfpilot.checkDeployed(select.value || undefined)
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
      if (!text || text.includes('还没有结果')) { log('还没有可复制的结果', 'warn'); return }
      copy(text)
    })

    // 自动识别域名：有自定义域名优先填它，没有则填 pages.dev
    document.getElementById('btnAutoHost')!.addEventListener('click', async () => {
      log('自动识别数据面域名…')
      try {
        const result = await window.cfpilot.detectScanHost()
        if (result.ok && result.host) {
          $('optHost').value = result.host
          if (result.source === 'custom') {
            log(`已填入自定义域名：${result.host}`, 'ok')
          } else {
            log(`已填入 pages.dev 域名：${result.host}`, 'warn')
            log('该实例没有绑定自定义域名。建议绑定后再优选——', 'warn')
            log('pages.dev 生产链接在部分网络环境会被阻断，测出来的结果不可信。', 'warn')
          }
        } else {
          log('自动识别失败：' + (result.error ?? '未知错误'), 'err')
        }
      } catch (err) {
        log('自动识别异常：' + (err instanceof Error ? err.message : String(err)), 'err')
      }
    })

    // 自动识别 WS 路径：从 KV 的 CONFIG 读（最权威），回落数据面环境变量
    document.getElementById('btnAutoPath')!.addEventListener('click', async () => {
      log('自动识别 WS 路径…')
      try {
        const result = await window.cfpilot.detectScanPath()
        if (result.ok && result.path) {
          $('optPath').value = result.path
          if (result.source === 'kv') {
            log(`已填入 WS 路径：${result.path}`, 'ok')
          } else {
            log(`已从数据面环境变量填入 WS 路径：${result.path}`, 'ok')
          }
        } else {
          log('自动识别失败：' + (result.error ?? '未知错误'), 'err')
        }
      } catch (err) {
        log('自动识别异常：' + (err instanceof Error ? err.message : String(err)), 'err')
      }
    })

    document.getElementById('btnEnvCheck')!.addEventListener('click', async () => {
      log('检测网络环境…')
      try {
        const result = await window.cfpilot.checkEnvironment()
        if (result.clean) {
          log('✅ 环境正常，优选结果可信', 'ok')
        }
      } catch (err) {
        log('检测失败：' + (err instanceof Error ? err.message : String(err)), 'err')
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
    window.cfpilot.onDeployStatus((status) => {
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
    logHead.addEventListener('click', () => {
      const collapsed = logPanel.classList.toggle('collapsed')
      logHead.title = collapsed ? '点击展开日志' : '点击折叠日志'
    })

    bindProfiles()
    bindCredentials()
    bindDeploy()
    bindScan()
    bindUpdater()
    bindPush()
    await refreshProfiles()
    await refreshCredState()
    renderKvOptions()
    void fillCountryOptions()
    log('CFPilot GUI 已就绪')
    log('凭据只保存在本机，不会上传')
  })
})()