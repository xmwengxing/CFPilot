/**
 * 配置菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status, rule } from './ui'
import { ask, confirm, select, pause } from './prompt'
import { configPath, loadConfig, saveConfig, clearConfig } from './store'
import { CloudflareClient } from '../deploy/cf-api'

/** 交互式配置。 */
export async function menuConfig(): Promise<void> {
  for (;;) {
    const cfg = loadConfig()
    box('配置', [
      `${c.gray('配置文件')} ${configPath()}`,
      `${c.gray('Token')}   ${cfg.token ? c.green('已保存') : c.yellow('未配置')}`,
      `${c.gray('账号')}    ${cfg.accountName || cfg.accountId || c.yellow('未配置')}`,
      `${c.gray('KV')}      ${cfg.kvNamespaceId || c.yellow('未配置')}`,
      `${c.gray('控制面')}  ${cfg.panelHost || c.yellow('未配置')}`,
    ])

    const action = await select('配置操作', [
      { label: '设置 API Token', value: 'token' },
      { label: '设置账号（自动检测）', value: 'account' },
      { label: '设置 KV 命名空间', value: 'kv' },
      { label: '设置控制面域名', value: 'panel' },
      { label: '查看完整配置', value: 'show' },
      { label: '清空配置', value: 'clear' },
      { label: '返回', value: 'back' },
    ])

    if (action === null || action === 'back') return
    process.stdout.write('\n')

    switch (action) {
      case 'token': {
        const token = await ask('Cloudflare API Token', { password: true })
        if (!token) {
          status('warn', '未输入，已取消')
          break
        }
        saveConfig({ token })
        status('ok', 'Token 已保存到本地配置')
        status('info', `文件：${configPath()}`)
        if (await confirm('现在检测账号？', true)) {
          await detectAccount(token)
        }
        break
      }
      case 'account': {
        if (!cfg.token) {
          status('warn', '请先设置 Token')
          break
        }
        await detectAccount(cfg.token)
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
      case 'clear': {
        if (await confirm('确定清空所有本地配置？', false)) {
          clearConfig()
          status('ok', '配置已清空')
        }
        break
      }
    }

    process.stdout.write('\n')
    await pause()
  }
}

/** 用 Token 检测账号并保存。 */
async function detectAccount(token: string): Promise<void> {
  status('info', '正在检测账号…')
  try {
    const client = new CloudflareClient({ token })
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      status('fail', '该 Token 没有可访问的账号')
      return
    }

    let picked = accounts[0]!
    if (accounts.length > 1) {
      const value = await select(
        '选择账号',
        accounts.map((a) => ({ label: a.name, value: a.id, hint: a.id.slice(0, 12) + '…' }))
      )
      picked = accounts.find((a) => a.id === value) ?? accounts[0]!
    }

    saveConfig({ accountId: picked.id, accountName: picked.name })
    status('ok', `账号：${picked.name}`)
    status('info', `ID：${picked.id}`)
  } catch (err) {
    status('fail', `检测失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 命令行 config 子命令。 */
export async function runConfig(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig()
  const flags = args.flags
  const hasSetFlags = ['token', 'kv', 'panel', 'account'].some((k) => typeof flags[k] === 'string')

  if (!hasSetFlags) {
    process.stdout.write(`配置文件：${configPath()}\n\n`)
    // 敏感字段脱敏显示（避免终端录屏 / 截图泄露）
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

/** 脱敏：只显示前 6 位与后 4 位。 */
function maskSecret(s: string): string {
  if (s.length <= 12) return '***'
  return s.slice(0, 6) + '…' + s.slice(-4)
}
