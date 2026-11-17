/**
 * cfpilot edge —— 盲中继 / 云监测台部署命令。
 *
 * 与桌面版「部署 → 盲中继 / 云监测台」分类标签同源（Go 端 internal/edge）。
 */
import { flagString, flagBool, flagNumber, type ParsedArgs } from '../shared/args'
import { CloudflareClient } from '../deploy/cf-api'
import {
  deployEdgeRelay,
  formatEdgeDeploySummary,
  zoneNameFromDomain,
} from './deploy'

const EDGE_HELP = `
cfpilot edge —— 盲中继 / 云监测台部署（MobiHop 边缘工程）

用法:
  cfpilot edge deploy [选项]    部署盲中继 Worker + 监测面板
  cfpilot edge help             显示本帮助

选项:
  --token <token>        Cloudflare API Token（或 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID（不传则取账号列表第一个）
  --domain <host>        盲中继自定义域名（必填；*.workers.dev 国内被污染）
  --worker-name <name>   Worker 名（默认 mobihop-edge-relay）
  --monitor-password <pw> 监测台初始密码（≥8 位；留空则随机生成）
  --monitor-token <t>    上报令牌（留空则随机生成）
  --dashboard-project <n> 监测面板 Pages 项目名（默认 <worker-name>-dashboard）
  --no-dashboard         只部署 Worker，不部署监测面板
  --zone-id <id>         绑定自定义域名所需 zone ID（不传则按域名主域查；查不到会提示手绑）
  --window-ms <n>        滑动窗口 ms（默认 1000）
  --max-bytes <n>        窗口字节上限（默认 1048576）
  --max-packets <n>      窗口包数上限（默认 2000）
  --max-peers <n>        单房间连接上限（默认 512）

Token 权限（新增，基础代理部署不需要）:
  Workers Scripts / Edit · Durable Objects / Edit · D1 / Edit · Pages / Edit
  Zone & DNS / Edit（绑定自定义域时需要）

示例:
  cfpilot edge deploy --token <TOKEN> --domain relay.example.com --monitor-password <PW>
`

function randomPassword(bytes = 12): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

export async function runEdgeCommand(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? (flagBool(args, 'h') || flagBool(args, 'help') ? 'help' : 'deploy')

  if (action === 'help' || flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(EDGE_HELP)
    return
  }
  if (action !== 'deploy') {
    process.stderr.write(`未知 edge 动作：${action}\n\n`)
    process.stderr.write(EDGE_HELP)
    process.exitCode = 1
    return
  }

  const token = flagString(args, 'token') || process.env.CLOUDFLARE_API_TOKEN || ''
  if (!token) {
    process.stderr.write('缺少 --token 参数（或设置 CLOUDFLARE_API_TOKEN）\n')
    process.exitCode = 1
    return
  }
  const domain = flagString(args, 'domain').trim()
  if (!domain) {
    process.stderr.write('缺少 --domain（盲中继必须自定义域名）\n')
    process.exitCode = 1
    return
  }

  const client = new CloudflareClient({ token })
  let accountId = flagString(args, 'account').trim()
  if (!accountId) {
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      process.stderr.write('账号列表为空，请用 --account 指定\n')
      process.exitCode = 1
      return
    }
    const account = accounts[0]!
    accountId = account.id
    process.stderr.write(`使用账号：${account.name}（${accountId.slice(0, 8)}…）\n`)
  }

  // zone：显式 zone-id 优先；否则按域名主域查，查不到则由用户手绑
  let zoneId = flagString(args, 'zone-id').trim()
  if (!zoneId) {
    const zones = await client.listZones(zoneNameFromDomain(domain))
    const match = zones.find((z) => domain.toLowerCase().endsWith('.' + z.name.toLowerCase()) || domain.toLowerCase() === z.name.toLowerCase())
    if (match) {
      zoneId = match.id
      process.stderr.write(`找到 zone：${match.name}，将自动绑定域名\n`)
    } else {
      process.stderr.write(`未找到 zone（${zoneNameFromDomain(domain)}），跳过自动绑定；请部署后在控制台手动绑定 ${domain}\n`)
    }
  }

  let password = flagString(args, 'monitor-password').trim()
  let generatedPw = false
  if (!password) {
    password = randomPassword()
    generatedPw = true
  }
  if (password.length < 8) {
    process.stderr.write('监测台密码至少 8 位\n')
    process.exitCode = 1
    return
  }

  const result = await deployEdgeRelay(client, {
    accountId,
    domain,
    workerName: flagString(args, 'worker-name').trim() || undefined,
    monitorPassword: password,
    monitorToken: flagString(args, 'monitor-token').trim() || undefined,
    dashboardProject: flagString(args, 'dashboard-project').trim() || undefined,
    withDashboard: !flagBool(args, 'no-dashboard'),
    zoneId: zoneId || undefined,
    limits: {
      windowMs: flagNumber(args, 'window-ms', 1000).toString(),
      maxBytesPerWindow: flagNumber(args, 'max-bytes', 1048576).toString(),
      maxPacketsPerWindow: flagNumber(args, 'max-packets', 2000).toString(),
      maxPeersPerRoom: flagNumber(args, 'max-peers', 512).toString(),
    },
    onProgress: (m) => process.stdout.write(`[edge] ${m}\n`),
  })

  process.stdout.write(formatEdgeDeploySummary(result))
  if (generatedPw) {
    process.stdout.write('（监测台密码为自动生成，上方已显示，请立即保存）\n')
  }
}
