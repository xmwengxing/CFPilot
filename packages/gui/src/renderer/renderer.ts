/**
 * 渲染层逻辑
 *
 * 注意：这里拿不到 Node 能力，也拿不到令牌明文。
 * 所有敏感操作通过 window.cfpilot 转主进程。
 */
(function () {
  'use strict'

  function $(id: string) { return document.getElementById(id) as HTMLInputElement }

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
  }

  function escapeHtml(s: string): string {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }
    return s.replace(/[&<>"']/g, (c) => map[c]!)
  }

  /* ---------------- 凭据 ---------------- */
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
  }

  function bindCredentials(): void {
    document.getElementById('btnSaveToken')!.addEventListener('click', async () => {
      const token = $('cfToken').value.trim()
      if (!token) { log('请先填写 API Token', 'warn'); return }

      await window.cfpilot.saveCredentials({
        cfToken: token,
        panelPassword: $('panelPassword').value,
      })
      log('凭据已保存到本机', 'ok')
      await refreshCredState()
    })

    document.getElementById('btnDetect')!.addEventListener('click', async () => {
      log('检测账号与 KV…')
      const result = await window.cfpilot.detectAccount()
      document.getElementById('detAccount')!.textContent =
        result.accountName ? result.accountName + '（' + result.accountId + '）' : '—'
      document.getElementById('detKv')!.textContent = result.kvId || '—'
    })

    document.getElementById('btnWipe')!.addEventListener('click', async () => {
      if (!confirm('确定清除本机保存的 API Token 与面板密码？')) return
      await window.cfpilot.wipeCredentials()
      log('已清除本机凭据', 'ok')
      document.getElementById('detAccount')!.textContent = '—'
      document.getElementById('detKv')!.textContent = '—'
      await refreshCredState()
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

  function setBusy(busy: boolean): void {
    for (const id of ['btnDeploy', 'btnCheck', 'btnScan', 'btnDetect']) {
      document.getElementById(id)!.setAttribute('disabled', busy ? '1' : '')
    }
  }

  function bindDeploy(): void {
    document.getElementById('btnDeploy')!.addEventListener('click', async () => {
      setBusy(true)
      log('── 开始部署 ──')
      try {
        const result = await window.cfpilot.runDeploy({
          mode: readMode(),
          force: $('optForce').checked,
          newCredentials: $('optNewCred').checked,
          controlProject: $('controlProject').value.trim(),
          dataProject: $('dataProject').value.trim(),
          panelPath: $('panelPath').value.trim(),
          wsPath: $('wsPath').value.trim(),
        })
        const status = document.getElementById('deployStatus')!
        status.textContent = result.ok ? '✅ 部署完成' : '❌ 部署失败：' + (result.error ?? '')
      } catch (err) {
        log('部署异常：' + (err instanceof Error ? err.message : String(err)), 'err')
        document.getElementById('deployStatus')!.textContent = '❌ 部署异常'
      } finally {
        setBusy(false)
      }
    })

    document.getElementById('btnCheck')!.addEventListener('click', async () => {
      log('检查线上部署状态…')
      await window.cfpilot.checkDeployed()
    })
  }

  /* ---------------- 优选 ---------------- */
  function renderScanResult(payload: {
    entries: Array<{ ip: string; port: number; colo: string; latency: number; speed: number }>
    copyable: string
  }): void {
    const out = $('scanOut')
    out.textContent = payload.copyable || '（没有结果）'
    const table = document.getElementById('scanTable') as HTMLTableElement
    const tbody = table.querySelector('tbody')!
    tbody.innerHTML = ''
    payload.entries.forEach((e, i) => {
      const tr = document.createElement('tr')
      const cells = [String(i + 1), e.ip + ':' + e.port, e.colo, String(e.latency), String(e.speed)]
      for (const c of cells) {
        const td = document.createElement('td')
        td.textContent = c
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    })
    table.hidden = payload.entries.length === 0
  }

  function bindScan(): void {
    document.getElementById('btnScan')!.addEventListener('click', async () => {
      const host = $('optHost').value.trim()
      const path = $('optPath').value.trim()
      if (!host) { log('请填写 Worker 域名（数据面地址）', 'warn'); return }
      if (!path) { log('请填写 WS 路径', 'warn'); return }

      setBusy(true)
      $('scanOut').textContent = '正在优选，请稍候…'
      try {
        const result = await window.cfpilot.runScan({
          host,
          port: Number($('optPort').value),
          wsPath: path,
          probePath: $('optProbePath').value.trim(),
          skipSpeed: $('optNoSpeed').checked,
          sample: Number($('optSample').value) || 300,
          top: Number($('optTop').value) || 15,
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

    window.cfpilot.onDeployStatus((status) => {
      const el = document.getElementById('deployStatus')!
      if (!status.hasDeploy) {
        el.textContent = '尚未部署'
        return
      }
      el.innerHTML = '已有部署：<b>' + escapeHtml(status.controlProject ?? '') + '</b> / ' +
        escapeHtml(status.dataProject ?? '') + '（版本 ' + escapeHtml(status.build ?? '?') + '）'
      // 顺手把数据面域名填进优选表单，省得用户手动输入
      if (status.dataProject) {
        $('optHost').value = status.dataProject + '.pages.dev'
      }
    })

    window.cfpilot.onScanResult((payload) => renderScanResult(payload))
  }

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('nav')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-page]') as HTMLElement | null
      if (btn) switchPage(btn.dataset.page!)
    })
    document.getElementById('btnClearLog')!.addEventListener('click', () => {
      $('logBox').innerHTML = ''
    })

    bindCredentials()
    bindDeploy()
    bindScan()
    bindPush()
    await refreshCredState()
    log('CFPilot GUI 已就绪')
    log('凭据只保存在本机，不会上传')
  })
})()
