/**
 * 优选相关菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status } from './ui'
import { ask, confirm, multiSelect, select } from './prompt'
import { loadConfig, saveConfig, resolveToken } from './store'
import { SUPPORTED_COUNTRIES } from '../scan/countries'
import { CloudflareClient } from '../deploy/cf-api'
import { listCfPilotNamespaces } from '../deploy/pages-deploy'

/** 构造子命令参数对象。 */
function makeArgs(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: '', flags, positionals: [] }
}

interface Instance {
  id: string
  controlProject: string
  dataProject: string
  controlSubdomain: string
  dataSubdomain: string
  wsPath: string
}

/** 拉取账号下的 CFPilot 实例；失败返回空数组。 */
async function fetchInstances(token: string): Promise<Instance[]> {
  try {
    const client = new CloudflareClient({ token })
    const cfg = loadConfig()
    const accounts = await client.listAccounts()
    const accountId = cfg.accountId || accounts[0]?.id
    if (!accountId) return []

    const list = await listCfPilotNamespaces(client, accountId)
    return list.map((i) => ({
      id: i.id,
      controlProject: i.manifest.controlProject,
      dataProject: i.manifest.dataProject,
      controlSubdomain: i.manifest.controlSubdomain,
      dataSubdomain: i.manifest.dataSubdomain,
      wsPath: i.manifest.credentials?.wsPath ?? '',
    }))
  } catch {
    return []
  }
}

/**
 * 选择要使用的实例，并把域名与 WS 路径写入配置。
 *
 * 返回选中的实例；无实例时返回 null。
 */
async function pickInstance(token: string): Promise<Instance | null> {
  const cfg = loadConfig()

  status('info', '正在识别账号下的实例…')
  const instances = await fetchInstances(token)
  if (instances.length === 0) {
    status('warn', '没有识别到已部署的 CFPilot 实例')
    return null
  }

  let chosen: Instance
  if (instances.length === 1) {
    chosen = instances[0]!
    status('ok', `实例：${chosen.controlProject} / ${chosen.dataProject}`)
  } else {
    const picked = await select(
      '选择要优选的实例',
      instances.map((i) => ({
        label: `${i.controlProject} / ${i.dataProject}`,
        value: i.id,
        hint: i.dataSubdomain,
      })),
      { initial: Math.max(0, instances.findIndex((i) => i.id === cfg.kvNamespaceId)) }
    )
    chosen = instances.find((i) => i.id === picked) ?? instances[0]!
  }

  // 自动填好域名与 WS 路径
  saveConfig({
    kvNamespaceId: chosen.id,
    panelHost: chosen.controlSubdomain,
    dataHost: chosen.dataSubdomain,
    wsPath: chosen.wsPath,
  })

  return chosen
}

/** 本地优选。 */
export async function menuScan(): Promise<void> {
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    status('info', '请先到「配置」菜单添加')
    return
  }

  // ---- 1. 先选实例，自动填域名与 WS 路径 ----
  const instance = await pickInstance(token)
  if (!instance) {
    const manual = await ask('手动输入数据面域名（留空取消）', { allowEmpty: true })
    if (!manual) {
      status('info', '已取消')
      return
    }
    saveConfig({ dataHost: manual })
  }

  const cfg = loadConfig()
  process.stdout.write('\n')
  box('本地优选', [
    `${c.gray('目标域名')} ${cfg.dataHost || c.yellow('未配置')}`,
    `${c.gray('WS 路径')}  ${cfg.wsPath || c.gray('（默认探针路径）')}`,
  ])
  process.stdout.write('\n')

  // ---- 2. 参数 ----
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

  // 回填参数随扫描一起传下去，扫描结束后会交互询问
  const flags: Record<string, string | boolean> = {
    host: cfg.dataHost ?? '',
    sample: String(sample),
    'ask-callback': true,
    panel: cfg.panelHost ?? '',
  }
  if (skipSpeed) flags['no-speed'] = true
  if (countries.length > 0) flags['countries'] = countries.join(',')

  const { runScanCommand } = await import('../scan/command')
  await runScanCommand(makeArgs(flags))
}

/** 回填优选结果到面板。 */
export async function menuScanPush(): Promise<void> {
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    return
  }

  const instance = await pickInstance(token)
  if (!instance) {
    status('warn', '需要先有一个已部署的实例')
    return
  }

  const cfg = loadConfig()
  process.stdout.write('\n')
  box('回填到面板', [
    `${c.gray('控制面')} ${cfg.panelHost}`,
    `${c.gray('数据面')} ${cfg.dataHost}`,
    '结果会写入面板的「手动优选 IP」',
  ])
  process.stdout.write('\n')

  const password = await ask('面板密码（用于申请回填令牌）', {
    password: true,
    allowEmpty: true,
  })
  if (!password) {
    status('warn', '需要面板密码才能申请令牌')
    status('info', '密码在部署时生成，可到「部署」页或面板凭据里查')
    return
  }

  const skipSpeed = await confirm('跳过测速？（快很多，但结果质量略降）', true)

  process.stdout.write('\n')
  status('info', '开始优选并回填…')
  status('info', '令牌会在扫描结束后才申请（10 分钟有效）')
  process.stdout.write('\n')

  const flags: Record<string, string | boolean> = {
    host: cfg.dataHost ?? '',
    panel: cfg.panelHost ?? '',
    'panel-password': password,
    sample: '6556',
  }
  if (skipSpeed) flags['no-speed'] = true

  const { runScanCommand } = await import('../scan/command')
  await runScanCommand(makeArgs(flags))
}
