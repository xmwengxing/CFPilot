/**
 * 部署相关菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status } from './ui'
import { ask, confirm, select } from './prompt'
import { loadConfig, saveConfig, resolveToken } from './store'
import { CloudflareClient } from '../deploy/cf-api'
import { checkTokenPermissions, renderTokenCheck } from '../deploy/token-check'

/** 构造子命令参数对象（避免拼接字符串再解析）。 */
function makeArgs(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: '', flags, positionals: [] }
}

/** 部署菜单（新建 / 更新）。 */
export async function menuDeploy(mode: 'fresh' | 'update'): Promise<void> {
  const cfg = loadConfig()
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    status('info', '请先到「配置」菜单设置，或运行 cfpilot config --token xxx')
    return
  }

  box(mode === 'fresh' ? '部署新实例' : '更新现有实例', [
    `${c.gray('账号')}  ${cfg.accountName || c.yellow('待检测')}`,
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
    const raw = await client.getKvValue(cfg.accountId, cfg.kvNamespaceId, 'CFP_DEPLOY_MANIFEST')
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
