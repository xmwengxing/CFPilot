/**
 * 部署相关菜单
 */

import { c, box, status, rule } from './ui'
import { ask, confirm, select, pause } from './prompt'
import { loadConfig, saveConfig, resolveToken } from './store'
import { CloudflareClient } from '../deploy/cf-api'
import { checkTokenPermissions, renderTokenCheck } from '../deploy/token-check'
import { parseArgs } from '../shared/args'

/** 部署菜单（新建 / 更新）。 */
export async function menuDeploy(mode: 'fresh' | 'update'): Promise<void> {
  const cfg = loadConfig()
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    status('info', '请到「配置」菜单设置，或先运行 cfpilot config --token xxx')
    return
  }

  box(mode === 'fresh' ? '部署新实例' : '更新现有实例', [
    `${c.gray('账号')}  ${cfg.accountName || c.yellow('待检测')}`,
    `${c.gray('KV')}    ${cfg.kvNamespaceId || c.gray('（自动）')}`,
  ])
  process.stdout.write('\n')

  // 收集参数
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

  // 组装参数，复用现成的子命令实现
  const argv: string[] = ['deploy', '--token', token, '--yes']
  if (mode === 'fresh') argv.push('--new-kv')
  if (panelPassword) argv.push('--panel-password', panelPassword)
  if (cfg.kvNamespaceId) argv.push('--kv', cfg.kvNamespaceId)

  const args = parseArgs(argv.slice(1))
  // parseArgs 的第一个非 flag 会当 command，这里手动指定
  const deployArgs = { ...args, command: '' }

  const { runDeployCommand } = await import('../deploy/command')
  await runDeployCommand(deployArgs)
}

/** 修改已部署面板的密码。 */
export async function menuChangePassword(): Promise<void> {
  const cfg = loadConfig()
  const token = resolveToken()
  if (!token || !cfg.kvNamespaceId) {
    status('warn', '需要先配置 Token 与 KV')
    return
  }

  status('info', '正在读取当前实例信息…')
  try {
    const { deployPagesSplit } = await import('../deploy/pages-deploy')
    void deployPagesSplit

    // 直接读清单拿控制面域名
    const client = new CloudflareClient({ token })
    const accountId = cfg.accountId
    if (!accountId) {
      status('fail', '缺少账号 ID，请先到「配置」菜单检测账号')
      return
    }

    const raw = await client.getKvValue(accountId, cfg.kvNamespaceId, 'CFP_DEPLOY_MANIFEST')
    if (!raw) {
      status('fail', '该 KV 里没有部署记录')
      return
    }
    const manifest = JSON.parse(raw) as {
      controlSubdomain?: string
      credentials?: { panelPassword?: string }
    }
    const host = (manifest.controlSubdomain ?? '').trim()
    if (!host) {
      status('fail', '清单里没有控制面域名')
      return
    }

    status('ok', `控制面：${host}`)
    if (manifest.credentials?.panelPassword) {
      status('info', `当前密码：${c.yellow(manifest.credentials.panelPassword)}`)
    }

    const newPw = await ask('新的面板密码', { password: true })
    if (!newPw) {
      status('warn', '未输入，已取消')
      return
    }

    status('info', '正在更新…')
    const { deployPagesSplit: deploy } = await import('../deploy/pages-deploy')
    const result = await deploy({
      token,
      accountId,
      kvNamespaceId: cfg.kvNamespaceId,
      controlProject: host.replace('.pages.dev', ''),
      dataProject: '',
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
    })
    if (result.panelPassword) {
      status('ok', `面板密码已更新：${result.panelPassword}`)
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
    return
  }

  const scope = await select('检查范围', [
    { label: '基础权限（账号 / KV / Workers）', value: 'basic' },
    { label: '包含自定义域名（需要 Zone 权限）', value: 'domain' },
  ])
  if (scope === null) return

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
