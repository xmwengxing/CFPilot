/**
 * 部署相关菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status } from './ui'
import { ask, confirm, select } from './prompt'
import { loadConfig, saveConfig, resolveToken } from './store'
import type { Config } from './store'
import { CloudflareClient } from '../deploy/cf-api'
import type { CloudflareAccount } from '../deploy/cf-api'
import { findAccountByKv } from '../deploy/account-resolve'
import { checkTokenPermissions, renderTokenCheck } from '../deploy/token-check'

/** 构造子命令参数对象（避免拼接字符串再解析）。 */
function makeArgs(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: '', flags, positionals: [] }
}

/**
 * 解析本次部署要用的账号。
 *
 * ⚠️ **绝不能静默用 accounts[0]**。
 *
 * KV 是**账号作用域**的：账号取自 A、KV 取自 B 时，
 * 部署会在 A 里建出孤儿 Pages 项目、KV 绑定失败、配置写不进去
 * → 半成品实例 + 一堆垃圾，用户完全不知道发生了什么。
 *
 * 顺序：
 *   1. 配置里已有的账号（与 cfg.kvNamespaceId 出自同一次同步，同源）；
 *   2. 配置里有 KV 但没有账号 → 按 **KV 的归属账号**反查（最准）；
 *   3. 还没有就**列出让用户选**（交互式菜单，本就该问清楚）；
 *   4. 只有一个账号就直接用它。
 *
 * @returns 账号 ID；用户取消或出错时返回空串（调用方应中止）。
 */
async function resolveAccountId(token: string, cfg: Config): Promise<string> {
  if (cfg.accountId) return cfg.accountId

  const client = new CloudflareClient({ token })
  let accounts: CloudflareAccount[]
  try {
    accounts = await client.listAccounts()
  } catch (err) {
    status('fail', `读取账号列表失败：${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
  if (accounts.length === 0) {
    status('fail', '该 Token 没有可访问的账号')
    return ''
  }

  // 配置里有 KV 但没有账号 → KV 属于谁就用谁（比「问用户」更准）
  if (cfg.kvNamespaceId) {
    const { owner } = await findAccountByKv(client, accounts, cfg.kvNamespaceId)
    if (owner) {
      saveConfig({ accountId: owner.id, accountName: owner.name })
      return owner.id
    }
    status('warn', `配置的 KV ${cfg.kvNamespaceId} 不在可见的账号下，将重新选择`)
  }

  if (accounts.length === 1) {
    const only = accounts[0]!
    saveConfig({ accountId: only.id, accountName: only.name })
    return only.id
  }

  const picked = await select(
    '检测到多个账号，请选择本次部署使用哪个',
    accounts.map((a) => ({ label: a.name, value: a.id, hint: a.id.slice(0, 12) + '…' }))
  )
  if (!picked) {
    status('info', '已取消')
    return ''
  }
  const chosen = accounts.find((a) => a.id === picked)
  if (!chosen) return ''
  saveConfig({ accountId: chosen.id, accountName: chosen.name })
  return chosen.id
}

/** 部署菜单（新建 / 更新）。 */
export async function menuDeploy(mode: 'fresh' | 'update'): Promise<void> {
  let cfg = loadConfig()
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    status('info', '请先到「配置」菜单设置，或运行 cfpilot config --token xxx')
    return
  }

  // ⚠️ **必须先确定账号**（见 resolveAccountId 的说明）。
  // 部署命令在没拿到 --account 时会退回「token 的第一个账号」，
  // 而 KV 来自本地配置 —— 两者可能分属不同账号。
  const accountId = await resolveAccountId(token, cfg)
  if (!accountId) return
  cfg = loadConfig()

  box(mode === 'fresh' ? '部署新实例' : '更新现有实例', [
    `${c.gray('账号')}  ${cfg.accountName || accountId}`,
    `${c.gray('KV')}    ${cfg.kvNamespaceId || c.gray('（自动）')}`,
    `${c.gray('模式')}  ${mode === 'fresh' ? '全新部署' : '更新现有'}`,
  ])
  process.stdout.write('\n')

  const panelPassword = await ask('面板密码（留空 = 首次随机 / 更新沿用原密码）', {
    password: true,
    allowEmpty: true,
  })

  if (mode === 'fresh') {
    const ok = await confirm('确认开始全新部署？将创建新的 Pages 项目', true)
    if (!ok) {
      status('info', '已取消')
      return
    }
  }

  process.stdout.write('\n')
  status('info', '开始部署…')
  process.stdout.write('\n')

  const flags: Record<string, string | boolean> = {
    token,
    yes: true,
    mode: mode === 'fresh' ? 'fresh' : 'update',
    // ⚠️ 账号与 KV 来自同一份配置 → 不会错配。
    account: accountId,
  }
  if (mode === 'fresh') flags['new-kv'] = true
  if (panelPassword) flags['panel-password'] = panelPassword
  if (cfg.kvNamespaceId && mode === 'update') flags['kv'] = cfg.kvNamespaceId

  const { runDeployCommand } = await import('../deploy/command')
  await runDeployCommand(makeArgs(flags))
}

/** 修改已部署面板的密码。 */
export async function menuChangePassword(): Promise<void> {
  const cfg = loadConfig()
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 Token')
    return
  }
  if (!cfg.kvNamespaceId || !cfg.accountId) {
    status('warn', '需要先配置 KV 与账号（到「配置」菜单）')
    return
  }

  status('info', '正在读取实例信息…')
  try {
    const client = new CloudflareClient({ token })
    // ⚠️ getKvValue 只把 404（键不存在）当 null，其它错误（403 / 网络）会抛错。
    // 「读不到」必须与「没有部署记录」区分开 —— 否则会误报「该 KV 里没有部署记录」。
    let raw: string | null
    try {
      raw = await client.getKvValue(cfg.accountId, cfg.kvNamespaceId, 'CFP_DEPLOY_MANIFEST')
    } catch (err) {
      status('fail', `读取部署记录失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!raw) {
      status('fail', '该 KV 里没有部署记录')
      return
    }

    const manifest = JSON.parse(raw) as {
      controlProject?: string
      dataProject?: string
      controlSubdomain?: string
      credentials?: { panelPassword?: string; panelPath?: string }
    }
    const host = (manifest.controlSubdomain ?? '').trim()

    process.stdout.write('\n')
    box('当前面板', [
      `${c.gray('地址')} https://${host}${manifest.credentials?.panelPath ?? ''}`,
      `${c.gray('密码')} ${c.yellow(manifest.credentials?.panelPassword ?? '（未记录）')}`,
    ])
    process.stdout.write('\n')

    const newPw = await ask('新的面板密码（留空取消）', { password: true, allowEmpty: true })
    if (!newPw) {
      status('info', '已取消')
      return
    }

    const ok = await confirm('确认修改？修改后需用新密码登录面板', true)
    if (!ok) {
      status('info', '已取消')
      return
    }

    status('info', '正在更新…')
    const { deployPagesSplit } = await import('../deploy/pages-deploy')
    const result = await deployPagesSplit({
      token,
      accountId: cfg.accountId,
      kvNamespaceId: cfg.kvNamespaceId,
      controlProject: manifest.controlProject ?? '',
      dataProject: manifest.dataProject ?? '',
      panelPath: '',
      panelPassword: newPw,
      uuid: '',
      trojanPassword: '',
      wsPath: '',
      enableTrojan: true,
      enableXhttp: false,
      mode: 'update',
      keepCredentials: true,
      skipSameVersion: false,
      log: (m) => process.stdout.write(`  ${m}\n`),
    })

    if (result.panelPassword) {
      status('ok', `面板密码已更新：${c.yellow(result.panelPassword)}`)
    } else {
      status('ok', '已提交更新')
    }
  } catch (err) {
    status('fail', `更新失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Token 权限检查菜单。 */
export async function menuTokenCheck(): Promise<void> {
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    status('info', '请先到「配置」菜单设置')
    return
  }

  const scope = await select('检查范围', [
    { label: '基础权限', value: 'basic', hint: '账号 / KV / Workers（部署必需）' },
    { label: '含自定义域名', value: 'domain', hint: '额外检查 Zone 权限' },
  ])
  if (scope === null) return

  process.stdout.write('\n')
  status('info', '正在逐项探测…')
  process.stdout.write('\n')
  try {
    const result = await checkTokenPermissions({
      token,
      expectCustomDomain: scope === 'domain',
    })
    process.stdout.write(renderTokenCheck(result))
  } catch (err) {
    status('fail', `检查失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
