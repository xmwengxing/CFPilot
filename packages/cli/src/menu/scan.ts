/**
 * 优选相关菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status } from './ui'
import { ask, confirm, multiSelect, select } from './prompt'
import { loadConfig, saveConfig } from './store'
import { SUPPORTED_COUNTRIES } from '../scan/countries'

/** 构造子命令参数对象。 */
function makeArgs(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: '', flags, positionals: [] }
}

/** 本地优选。 */
export async function menuScan(): Promise<void> {
  const cfg = loadConfig()

  box('本地优选', [
    `${c.gray('目标域名')} ${cfg.dataHost || c.yellow('待填写')}`,
    `${c.gray('WS 路径')}  ${cfg.wsPath || c.gray('（自动探测）')}`,
  ])
  process.stdout.write('\n')

  const host = await ask('数据面域名（如 cpdata-xxx.pages.dev）', { fallback: cfg.dataHost })
  if (!host) {
    status('warn', '必须填写数据面域名（代理所在的那个项目）')
    return
  }
  if (host !== cfg.dataHost) saveConfig({ dataHost: host })

  // 国家筛选（可选）
  const wantFilter = await confirm('要按机房地区筛选吗？（不筛选跑全量）', false)
  let countries: string[] = []
  if (wantFilter) {
    const picked = await multiSelect(
      '选择地区（空格切换，Enter 确认）',
      SUPPORTED_COUNTRIES.map((code) => ({ label: code, value: code }))
    )
    countries = picked
  }

  const sampleStr = await ask('采样数量', { fallback: '6556' })
  const sample = Number(sampleStr) || 6556

  const skipSpeed = await confirm('跳过测速？（只按延迟排序，快很多）', false)

  process.stdout.write('\n')
  status('info', '开始优选…')
  process.stdout.write('\n')

  const flags: Record<string, string | boolean> = {
    host,
    sample: String(sample),
    'no-callback': true,
  }
  if (skipSpeed) flags['no-speed'] = true
  if (countries.length > 0) flags['countries'] = countries.join(',')

  const { runScanCommand } = await import('../scan/command')
  await runScanCommand(makeArgs(flags))
}

/** 回填优选结果到面板。 */
export async function menuScanPush(): Promise<void> {
  const cfg = loadConfig()

  box('回填到面板', [
    '优选结果会写入面板的「手动优选 IP」',
    c.gray('需要控制面域名 + 面板密码'),
  ])
  process.stdout.write('\n')

  const host = await ask('控制面域名（如 cpmanager.pages.dev）', { fallback: cfg.panelHost })
  if (!host) {
    status('warn', '必须填写控制面域名（面板所在的那个项目）')
    return
  }
  if (host !== cfg.panelHost) saveConfig({ panelHost: host })

  const dataHost = await ask('数据面域名（优选目标）', { fallback: cfg.dataHost })
  if (!dataHost) {
    status('warn', '必须填写数据面域名')
    return
  }
  if (dataHost !== cfg.dataHost) saveConfig({ dataHost })

  const password = await ask('面板密码（用于申请回填令牌）', {
    password: true,
    allowEmpty: true,
  })
  if (!password) {
    status('warn', '需要面板密码才能申请令牌')
    return
  }

  const skipSpeed = await confirm('跳过测速？（快很多，但结果质量略降）', true)

  process.stdout.write('\n')
  status('info', '开始优选并回填…')
  status('info', '令牌会在扫描结束后才申请（10 分钟有效）')
  process.stdout.write('\n')

  const flags: Record<string, string | boolean> = {
    host: dataHost,
    panel: host,
    'panel-password': password,
    sample: '6556',
  }
  if (skipSpeed) flags['no-speed'] = true

  const { runScanCommand } = await import('../scan/command')
  await runScanCommand(makeArgs(flags))
}
