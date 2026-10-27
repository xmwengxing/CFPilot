/**
 * 主菜单
 */

import { NAME, VERSION } from '../shared/version'
import { box, c, clearScreen, rule, status } from './ui'
import { select, pause } from './prompt'
import { loadConfig, isConfigured } from './store'

type Action =
  | 'deploy-new'
  | 'deploy-update'
  | 'status'
  | 'scan'
  | 'change-password'
  | 'token-check'
  | 'config'
  | 'help'
  | 'exit'

/** 读取当前状态摘要（不联网，只读本地配置）。 */
function statusLines(): string[] {
  const cfg = loadConfig()
  const lines: string[] = []
  lines.push(`${c.gray('账号')}  ${cfg.accountName || cfg.accountId || c.yellow('未配置')}`)
  lines.push(`${c.gray('实例')}  ${cfg.kvNamespaceId ? cfg.kvNamespaceId.slice(0, 12) + '…' : c.yellow('未配置')}`)
  if (cfg.panelHost) lines.push(`${c.gray('控制面')} ${cfg.panelHost}`)
  lines.push(`${c.gray('凭据')}  ${isConfigured(cfg) ? c.green('已配置') : c.yellow('未配置')}`)
  return lines
}

export async function runMenu(): Promise<void> {
  for (;;) {
    clearScreen()
    box(`${NAME} v${VERSION}`, ['Cloudflare Pages 代理部署与优选'], 52)
    process.stdout.write('\n')
    process.stdout.write(c.gray('  当前状态\n'))
    for (const line of statusLines()) process.stdout.write(`  ${line}\n`)
    process.stdout.write('\n')

    const action = await select<Action>('请选择操作', [
      { label: '部署新实例', value: 'deploy-new', hint: '全新部署一套 Pages 双项目' },
      { label: '更新现有实例', value: 'deploy-update', hint: '沿用凭据，只更新内核' },
      { label: '查看实例状态', value: 'status', hint: '读取线上部署信息' },
      { label: '本地优选（真连接测速）', value: 'scan', hint: '扫描可用 IP' },
      { label: '修改面板密码', value: 'change-password' },
      { label: '检查 Token 权限', value: 'token-check' },
      { label: '配置（Token / 账号 / KV）', value: 'config' },
      { label: '帮助', value: 'help' },
      { label: '退出', value: 'exit' },
    ])

    if (action === null || action === 'exit') {
      clearScreen()
      process.stdout.write(`${c.gray('再见')}\n`)
      return
    }

    process.stdout.write('\n')
    try {
      switch (action) {
        case 'deploy-new': {
          const { menuDeploy } = await import('./deploy')
          await menuDeploy('fresh')
          break
        }
        case 'deploy-update': {
          const { menuDeploy } = await import('./deploy')
          await menuDeploy('update')
          break
        }
        case 'status': {
          const { menuStatus } = await import('./status')
          await menuStatus()
          break
        }
        case 'scan': {
          const { menuScan } = await import('./scan')
          await menuScan()
          break
        }
        case 'change-password': {
          const { menuChangePassword } = await import('./deploy')
          await menuChangePassword()
          break
        }
        case 'token-check': {
          const { menuTokenCheck } = await import('./deploy')
          await menuTokenCheck()
          break
        }
        case 'config': {
          const { menuConfig } = await import('./config')
          await menuConfig()
          break
        }
        case 'help': {
          const { menuHelp } = await import('./help')
          await menuHelp()
          break
        }
      }
    } catch (err) {
      process.stdout.write('\n')
      status('fail', err instanceof Error ? err.message : String(err))
      await pause()
    }

    await pause()
  }
}

export { rule }
