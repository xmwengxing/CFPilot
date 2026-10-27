/**
 * 优选相关菜单
 */

import { c, box, status } from './ui'
import { ask, confirm, multiSelect, pause, select } from './prompt'
import { loadConfig, saveConfig, resolveToken } from './store'
import { parseArgs } from '../shared/args'

/** 本地优选。 */
export async function menuScan(): Promise<void> {
  const cfg = loadConfig()

  box('本地优选', [
    `${c.gray('目标域名')} ${cfg.dataHost || c.yellow('待填写')}`,
    `${c.gray('WS 路径')}  ${cfg.wsPath || c.gray('（自动）')}`,
  ])
  process.stdout.write('\n')

  const host = await ask('数据面域名（如 cpdata-xxx.pages.dev）', { fallback: cfg.dataHost })
  if (!host) {
    status('warn', '必须填写数据面域名')
    return
  }
  if (host !== cfg.dataHost) saveConfig({ dataHost: host })

  const sampleStr = await ask('采样数量', { fallback: '6556' })
  const sample = Number(sampleStr) || 6556

  const skipSpeed = await confirm('跳过测速（只按延迟排序，快很多）？', false)

  process.stdout.write('\n')
  status('info', '开始优选…')
  process.stdout.write('\n')

  const argv = ['--host', host, '--sample', String(sample), '--no-callback']
  if (skipSpeed) argv.push('--no-speed')

  const { runScanCommand } = await import('../scan/command')
  const args = parseArgs(argv)
  await runScanCommand({ ...args, command: '', positionals: [] })
}

/** 回填优选结果到面板。 */
export async function menuScanPush(): Promise<void> {
  const cfg = loadConfig()

  status('info', '回填需要：控制面域名 + 面板密码')
  status('info', '结果会写入面板的「手动优选 IP」')
  process.stdout.write('\n')

  const host = await ask('控制面域名（如 cpmanager.pages.dev）', { fallback: cfg.panelHost })
  if (!host) {
    status('warn', '必须填写控制面域名')
    return
  }
  if (host !== cfg.panelHost) saveConfig({ panelHost: host })

  const dataHost = await ask('数据面域名（优选用，也是回填的 IP 来源）', { fallback: cfg.dataHost })
  if (!dataHost) {
    status('warn', '必须填写数据面域名')
    return
  }
  if (dataHost !== cfg.dataHost) saveConfig({ dataHost })

  const password = await ask('面板密码', { password: true, allowEmpty: true })
  if (!password) {
    status('warn', '需要面板密码才能申请回填令牌')
    return
  }

  process.stdout.write('\n')
  status('info', '开始优选并回填…')
  process.stdout.write('\n')

  const argv = [
    '--host',
    dataHost,
    '--panel',
    host,
    '--panel-password',
    password,
    '--sample',
    '6556',
    '--no-speed',
  ]

  const { runScanCommand } = await import('../scan/command')
  const args = parseArgs(argv)
  await runScanCommand({ ...args, command: '', positionals: [] })
}
