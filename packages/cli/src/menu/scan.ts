/**
 * 优选相关菜单
 */

import type { ParsedArgs } from '../shared/args'
import { c, box, status } from './ui'
import { ask, confirm, multiSelect, select } from './prompt'
import { loadConfig, saveConfig, resolveToken } from './store'
import { SUPPORTED_COUNTRIES, REGION_GROUPS, REGION_GROUP_NAMES } from '../scan/countries'
import { CloudflareClient } from '../deploy/cf-api'
import { findAccountByKv } from '../deploy/account-resolve'
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
    if (accounts.length === 0) return []

    // ⚠️ **不要静默用 accounts[0]**：配置里的 KV / 域名可能是另一个账号的，
    // 拿 accounts[0] 去查会列出完全不相干的实例，并把它们的域名写回配置
    // → 后续回填打到别的账号的面板。
    let accountId = cfg.accountId || ''
    if (!accountId && cfg.kvNamespaceId) {
      // 配置里的 KV 属于哪个账号，就用哪个账号
      const { owner } = await findAccountByKv(client, accounts, cfg.kvNamespaceId)
      if (owner) accountId = owner.id
    }
    if (!accountId && accounts.length === 1) {
      accountId = accounts[0]!.id
    }
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
    // 与桌面版「机房国家」栏的三个筛选器一一对应：
    // 取消选择 / 亚洲组 / 美国组。分组只当关键字往下传，
    // 在 normalizeCountryFilter 里展开成国家码，保证与 `--countries` 行为一致。
    const CLEAR = '__CLEAR__'
    const GROUP = 'GROUP:'
    const picked = await multiSelect(
      '选择地区（空格切换，Enter 确认）',
      [
        { label: '取消选择（不选 = 全部）', value: CLEAR },
        ...Object.entries(REGION_GROUP_NAMES).map(([key, name]) => ({
          label: name,
          hint: `展开为 ${REGION_GROUPS[key]?.length ?? 0} 个国家`,
          value: GROUP + key,
        })),
        ...SUPPORTED_COUNTRIES.map((code) => ({ label: code, value: code })),
      ]
    )
    // 「取消选择」与其它项互斥：选了它就是不筛选
    countries = picked.includes(CLEAR)
      ? []
      : picked.map((v) => (v.startsWith(GROUP) ? v.slice(GROUP.length) : v))
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

/**
 * 反代优选：出站链路体检。
 *
 * 与「本地优选」是**两个方向**：
 *   - 本地优选测「你 → CF 边缘」（结果进订阅节点）
 *   - 反代优选测「Worker → 候选代理 → CF」（结果进面板 ProxyIP 池，不进订阅）
 *
 * UUID 直接从面板配置读，不让用户手抄 —— 它随订阅分发、用户手里往往只有订阅链接。
 */
export async function menuRelayScan(): Promise<void> {
  const cfg = loadConfig()
  if (!cfg.dataHost || !cfg.panelHost) {
    status('warn', '需要先有已部署的实例（缺数据面或控制面域名）')
    return
  }

  process.stdout.write('\n')
  box('反代优选（出站链路体检）', [
    `${c.gray('数据面')} ${cfg.dataHost}`,
    `${c.gray('控制面')} ${cfg.panelHost}`,
    '验证候选代理能否把 SNI 转发到你的数据面',
  ])
  process.stdout.write('\n')

  const source = await select<'file' | 'url'>('候选来源', [
    { label: '本地文件（csv / txt）', value: 'file' },
    { label: '远程链接', value: 'url' },
  ])
  if (source === null) return
  const sourceValue = await ask(source === 'file' ? '文件路径' : '清单链接', { fallback: '' })
  if (!sourceValue.trim()) {
    status('warn', '需要候选清单')
    return
  }

  const password = await ask('面板密码（用于读取 UUID 与写入 ProxyIP 池）', {
    password: true,
    allowEmpty: true,
  })
  if (!password) {
    status('warn', '需要面板密码')
    return
  }

  const { getPanelConfig } = await import('../scan/callback')
  const cfgRes = await getPanelConfig(cfg.panelHost, password)
  if (!cfgRes.ok) {
    status('fail', `读取面板配置失败：${cfgRes.error}`)
    return
  }
  const uuid = String(cfgRes.config?.uuid ?? '')
  const wsPath = cfg.wsPath || String(cfgRes.config?.wsPath ?? '')
  if (!uuid || !wsPath) {
    status('warn', '面板配置里缺 uuid 或 wsPath，先在面板里确认实例配置')
    return
  }

  const topStr = await ask('保留条数（写入/输出）', { fallback: '10' })
  const roundsStr = await ask('轮数（每轮重测一次，抗抖动）', { fallback: '2' })

  const push = await confirm('测完直接写入面板 ProxyIP 池？', true)
  let pushMode: 'incremental' | 'overwrite' = 'incremental'
  if (push) {
    const picked = await select<'incremental' | 'overwrite'>('写入方式', [
      { label: '增量（保留池里已有的）', value: 'incremental' },
      { label: '覆盖（清空后写入）', value: 'overwrite' },
    ])
    if (picked === null) return
    pushMode = picked
  }

  process.stdout.write('\n')
  status('info', '开始出站体检…')
  status('info', '每个候选都要走一条隧道，260 个约 3~4 分钟')
  process.stdout.write('\n')

  const flags: Record<string, string | boolean> = {
    host: cfg.dataHost,
    'ws-path': wsPath,
    uuid,
    rounds: roundsStr || '2',
    top: topStr || '10',
    panel: cfg.panelHost,
    'panel-password': password,
  }
  if (source === 'file') flags.file = sourceValue.trim()
  else flags.url = sourceValue.trim()
  if (push) flags.push = pushMode

  const { runRelayCommand } = await import('../scan/relay')
  await runRelayCommand(makeArgs(flags))
}
