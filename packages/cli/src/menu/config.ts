/**
 * 配置菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status, rule } from './ui'
import { ask, confirm, select, pause } from './prompt'
import { configPath, loadConfig, saveConfig, clearConfig, resolveToken } from './store'
import { CloudflareClient } from '../deploy/cf-api'
import { listCfPilotNamespaces } from '../deploy/pages-deploy'

/** 从 Cloudflare 同步账号 / KV / 控制面信息（写回本地配置）。 */
async function syncFromCloud(token: string): Promise<boolean> {
  // ⚠️ **先清空上一个账户的全部字段**（在任何探测之前）。
  //
  // `saveConfig` 是**合并语义**（`{ ...current, ...patch }`），
  // 没在 patch 里的字段全部保留。于是「换 Token」后配置会变成：
  //
  //   { token: tokenB, accountId: A, kvNamespaceId: KVA,
  //     panelHost: A的域名, dataHost: A的域名, wsPath: A的WS路径 }
  //
  // —— **新 Token 配旧账户的 KV 与域名**。
  // 后续回填会打到上一个账户的面板、改密码会改到上一个账户的实例。
  //
  // 清空放在这里（而不是菜单分支）是为了**覆盖所有调用方**：
  // 交互菜单、`syncAccount()`、以及任何直接调用本函数的地方。
  //
  // 注意 `saveConfig` 会把空串**删除**（不留下空键），语义正好是「清空」。
  saveConfig({
    accountId: '',
    accountName: '',
    kvNamespaceId: '',
    panelHost: '',
    dataHost: '',
    wsPath: '',
  })

  try {
    const client = new CloudflareClient({ token })

    // ---- 账号 ----
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      status('fail', '该 Token 没有可访问的账号')
      return false
    }

    let account = accounts[0]!
    if (accounts.length > 1) {
      const picked = await select(
        '检测到多个账号，请选择',
        accounts.map((a) => ({ label: a.name, value: a.id, hint: a.id.slice(0, 12) + '…' }))
      )
      account = accounts.find((a) => a.id === picked) ?? accounts[0]!
    }
    saveConfig({ accountId: account.id, accountName: account.name })
    status('ok', `账号：${account.name}`)

    // ---- KV 与实例 ----
    const namespaces = await client.listKvNamespaces(account.id)
    if (namespaces.length === 0) {
      // ⚠️ 这里也要**清空**旧实例信息。
      // 之前直接 return，导致上一个账户的 kvNamespaceId / panelHost /
      // dataHost / wsPath 全部留在配置里 —— 配着新 Token，
      // 却指着上一个账户的 KV 与域名。
      saveConfig({
        kvNamespaceId: '',
        panelHost: '',
        dataHost: '',
        wsPath: '',
      })
      status('info', '该账号下还没有 KV（首次部署时会自动创建）')
      return true
    }

    const instances = await listCfPilotNamespaces(client, account.id)

    // 有实例则自动选中（优先已配置的那个）
    if (instances.length > 0) {
      let chosen = instances[0]!
      if (instances.length > 1) {
        const picked = await select(
          '检测到多个 CFPilot 实例，请选择本次使用哪个',
          instances.map((i) => ({
            label: `${i.manifest.controlProject} / ${i.manifest.dataProject}`,
            value: i.id,
            hint: i.manifest.controlSubdomain,
          }))
        )
        chosen = instances.find((i) => i.id === picked) ?? instances[0]!
      }

      // ⚠️ `wsPath` 之前**从不更新** —— 它是上一个账户的残留值。
      // WS 路径是**每实例**的（写在内核的 CONFIG 里），
      // 不跟着实例走就一定会错。
      saveConfig({
        kvNamespaceId: chosen.id,
        panelHost: chosen.manifest.controlSubdomain,
        dataHost: chosen.manifest.dataSubdomain,
        wsPath: chosen.manifest.credentials?.wsPath ?? '',
      })
      status('ok', `实例：${chosen.manifest.controlProject} / ${chosen.manifest.dataProject}`)
      status('info', `控制面：${chosen.manifest.controlSubdomain}`)
      status('info', `数据面：${chosen.manifest.dataSubdomain}`)
      return true
    }

    // 无实例：只记录 KV 供选择
    //
    // 同样要清掉上一个账户的实例信息（域名 / WS 路径）。
    if (namespaces.length === 1) {
      saveConfig({
        kvNamespaceId: namespaces[0]!.id,
        panelHost: '',
        dataHost: '',
        wsPath: '',
      })
      status('info', `KV：${namespaces[0]!.title}（尚无部署）`)
    } else {
      const picked = await select(
        '该账号有多个 KV，请选择（或稍后首次部署时自动创建）',
        [
          ...namespaces.map((ns) => ({
            label: ns.title,
            value: ns.id,
            hint: ns.id.slice(0, 12) + '…',
          })),
          { label: '不指定（部署时自动创建）', value: '' },
        ]
      )
      if (picked) {
        saveConfig({
          kvNamespaceId: picked,
          panelHost: '',
          dataHost: '',
          wsPath: '',
        })
        status('ok', 'KV 已保存')
      }
    }
    return true
  } catch (err) {
    status('fail', `同步失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** 显示当前配置摘要（不含敏感信息）。 */
function summaryLines(): string[] {
  const cfg = loadConfig()
  return [
    `${c.gray('Token')}   ${cfg.token ? c.green('已保存') : c.yellow('未配置')}`,
    `${c.gray('账号')}    ${cfg.accountName || cfg.accountId || c.yellow('未配置')}`,
    `${c.gray('KV')}      ${cfg.kvNamespaceId ? cfg.kvNamespaceId.slice(0, 16) + '…' : c.yellow('未配置')}`,
    `${c.gray('控制面')}  ${cfg.panelHost || c.yellow('未配置')}`,
    `${c.gray('数据面')}  ${cfg.dataHost || c.yellow('未配置')}`,
  ]
}

/** 脱敏：只显示前 6 位与后 4 位。 */
function maskSecret(s: string): string {
  if (s.length <= 12) return '***'
  return s.slice(0, 6) + '…' + s.slice(-4)
}

/** 交互式配置。 */
export async function menuConfig(): Promise<void> {
  // 首次进入时，若已有 Token 但还没识别账号，自动同步一次
  // （用户可能通过 `cfpilot config --token xxx` 直接写入，没走菜单）
  const initial = loadConfig()
  if (initial.token && !initial.accountName) {
    status('info', '检测到已保存 Token，正在识别账号与实例…')
    process.stdout.write('\n')
    await syncFromCloud(initial.token)
    process.stdout.write('\n')
  }

  for (;;) {
    box('配置', [`${c.gray('文件')} ${configPath()}`, ...summaryLines()])
    process.stdout.write('\n')

    const cfg = loadConfig()
    const action = await select('配置操作', [
      {
        label: '添加 API Token（账户）',
        value: 'token',
        hint: cfg.token ? '已保存，可重新添加覆盖' : '',
      },
      { label: '删除 API Token（账户）', value: 'delete', disabled: !cfg.token },
      { label: '设置 KV 命名空间', value: 'kv' },
      { label: '设置控制面域名', value: 'panel' },
      { label: '查看完整配置', value: 'show' },
      { label: '返回', value: 'back' },
    ])

    if (action === null || action === 'back') return
    process.stdout.write('\n')

    switch (action) {
      case 'token': {
        const token = await ask('粘贴 Cloudflare API Token', { password: true })
        if (!token) {
          status('warn', '未输入，已取消')
          break
        }
        // 只存 Token —— 旧账户的字段由 syncFromCloud 在探测前统一清空
        // （见该函数开头的说明：那里覆盖所有调用方）。
        saveConfig({ token })
        status('ok', 'Token 已保存')

        status('info', '正在识别账号与实例…')
        process.stdout.write('\n')
        await syncFromCloud(token)
        break
      }

      case 'delete': {
        process.stdout.write(`当前账号：${c.cyan(cfg.accountName || cfg.accountId || '未知')}\n`)
        if (await confirm('确认删除本地保存的 Token 与账号信息？', false)) {
          clearConfig()
          status('ok', '已删除本地 Token 与账号配置')
          status('info', '云端部署不受影响，可随时重新添加 Token 恢复')
        } else {
          status('info', '已取消')
        }
        break
      }

      case 'kv': {
        const kv = await ask('KV 命名空间 ID', { fallback: cfg.kvNamespaceId })
        if (kv) {
          saveConfig({ kvNamespaceId: kv })
          status('ok', 'KV ID 已保存')
        }
        break
      }

      case 'panel': {
        const host = await ask('控制面域名（如 cpmanager.pages.dev）', { fallback: cfg.panelHost })
        if (host) {
          saveConfig({ panelHost: host.replace(/^https?:\/\//, '').replace(/\/$/, '') })
          status('ok', '控制面域名已保存')
        }
        break
      }

      case 'show': {
        rule()
        const shown: Record<string, unknown> = { ...loadConfig() }
        if (shown.token) shown.token = maskSecret(String(shown.token))
        if (shown.panelPassword) shown.panelPassword = maskSecret(String(shown.panelPassword))
        process.stdout.write(JSON.stringify(shown, null, 2) + '\n')
        rule()
        break
      }
    }

    process.stdout.write('\n')
    await pause()
  }
}

/** 命令行 config 子命令。 */
export async function runConfig(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig()
  const flags = args.flags
  const hasSetFlags = ['token', 'kv', 'panel', 'account'].some((k) => typeof flags[k] === 'string')

  if (!hasSetFlags) {
    process.stdout.write(`配置文件：${configPath()}\n\n`)
    const masked: Record<string, unknown> = { ...cfg }
    if (masked.token) masked.token = maskSecret(String(masked.token))
    if (masked.panelPassword) masked.panelPassword = maskSecret(String(masked.panelPassword))
    process.stdout.write(JSON.stringify(masked, null, 2) + '\n')
    return
  }

  const patch: Record<string, string> = {}
  if (typeof flags['token'] === 'string') patch.token = flags['token']
  if (typeof flags['kv'] === 'string') patch.kvNamespaceId = flags['kv']
  if (typeof flags['panel'] === 'string') patch.panelHost = flags['panel']
  if (typeof flags['account'] === 'string') patch.accountId = flags['account']

  saveConfig(patch)
  process.stdout.write('已保存：' + Object.keys(patch).join(', ') + '\n')
}

/** 供其他菜单复用：用 Token 同步账号与实例。 */
export async function syncAccount(token?: string): Promise<boolean> {
  const t = token || resolveToken()
  if (!t) return false
  return await syncFromCloud(t)
}
