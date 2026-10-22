/**
 * cfpilot-deploy —— CFPilot 全中文部署向导
 *
 * 注意：不要在这里手写 shebang。
 * 构建脚本（scripts/build.mjs）会通过 esbuild banner 注入，
 * 两处都写会导致产物出现两行 #!，Node 只认第一行，直接语法报错。
 */
import { flagBool, flagString, parseArgs } from './args'
import { CloudflareClient } from './cf-api'
import { checkTokenPermissions, renderTokenCheck } from './token-check'
import { deploy, printResult } from './wizard'
import { deployPagesSplit } from './pages-deploy'
import { randomPanelPath, randomPassword, randomWorkerName } from './utils'
import { randomUUID } from 'node:crypto'
import { NAME, VERSION } from './version'

const TOKEN_HELP = `
${NAME} token —— 校验 Cloudflare API Token

用法:
  ${NAME} token [选项]          列出 Token 可访问的账号与有效期
  ${NAME} token --check [选项]  逐项探测权限，输出「权限项 / 状态 / 缺失后果」

选项:
  --token <token>     Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>      只检查指定账号（默认第一个可见账号）
  --zone <domain>     指定主域名；与 --domain 一起会把自定义域名相关权限视为必需
  --domain <hostname> 计划绑定的完整自定义域名
  --check             执行权限预检
  --help              显示本帮助

示例:
  npx -y cfpilot-deploy token --check --token "$CLOUDFLARE_API_TOKEN"
  npx -y cfpilot-deploy token --check --zone example.com
`

const HELP = `
${NAME} v${VERSION}
CFPilot 全中文部署向导 —— 自动创建 KV、部署 Worker 内核、绑定自定义域名。

用法:
  ${NAME} init [选项]          执行 Worker 部署（单项目）
  ${NAME} pages-split [选项]   Pages 双项目部署（控制面 + 数据面，推荐）
  ${NAME} token [选项]        仅校验 API Token
  ${NAME} token --check       逐项探测 Token 权限并输出修复建议
  ${NAME} --help              显示帮助
  ${NAME} --version           显示版本

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID（跳过选择）
  --worker <name>        Worker 名称（默认纯随机，不带项目特征）
  --zone <domain>        绑定的主域名，如 example.com
  --domain <hostname>    完整自定义域名，如 cfpilot.example.com
  --kv-title <title>     KV 命名空间标题
  --workers-dev          不绑定自定义域名，直接使用 workers.dev
  --yes                  非交互模式
  --dry-run              只演示流程，不实际上传

部署流程（v${VERSION}）:
  1. 校验 Token → 选择账号 → 生成纯随机 Worker 名
  2. 创建 KV → 生成面板路径 / 密码 / 扫描令牌 → 上传内核
  3. 自动开启 workers.dev 子域路由（否则会显示 "There is nothing here yet"）
  4. 自动开启 Workers Logs（observability）
  5. 绑定自定义域名，并主动 GET 校验真实可访问性；
     接口成功但访问 522 时自动降级 Route + CNAME，仍失败则降级 workers.dev

   pages-split（Pages 双项目，推荐）
   真机复现：合并包部署到 Pages，第一次成功、第二次 HTTP 400 / 8000119 blocked；
   拆成控制面与数据面两个项目后，两边都能原地更新。
   1. 创建两个 Pages 项目（控制面无 sockets，数据面用 CFNext 实现）
   2. 配置 KV 绑定与环境变量（Pages 的绑定只对之后的部署生效）
   3. 先部署数据面，再部署控制面（控制面需要数据面域名生成订阅）

   ⚠️ 双项目是「当前唯一实测可用的安排」，不是 Cloudflare 的硬性要求。
      平台未说明 8000119 的具体触发原因，详见 docs/cloudflare-deployment-diagnosis.md。

Token 所需权限（Cloudflare 新版权限名）:
  Account / Workers KV Storage / Edit
      创建并绑定 KV 命名空间（优选池、配置、会话都存这里）
  Account / Workers Scripts / Edit（或 Workers / Edit/Admin）
      上传内核、开启 workers.dev 子域路由、开启 Workers Logs
  Account / Account Settings / Read
      读取账号列表（部署第一步）
  Zone / Zone / Read
      列出账号下的域名（仅自定义域名需要）
  Zone / DNS / Edit
      检测冲突 DNS、创建 CNAME（自定义域名回退路径）
  Zone / Workers Routes / Edit
      创建 Route（自定义域名 522 时的回退路径）

  以下权限本项目完全用不到，可以不勾：
    Registrar Domains / Registrar Sandbox Domains（域名注册）
    Account DNS Setting（账号级 DNS 默认设置，向导不调用）

Token 有效期说明:
  account-owned Token（cfat_ 前缀）无需 /user/tokens/verify，
  向导会自动改用账号维度校验，不影响部署。

建议先跑一次权限预检：
  npx -y cfpilot-deploy token --check --zone example.com
`

const PAGES_HELP = `
${NAME} pages-split —— Pages 双项目部署（控制面 + 数据面）

⚠️ 这是**当前唯一实测可用的部署形态**，不是 Cloudflare 的硬性要求。
   2026-10-22 真机复现：合并包部署到 Pages，第一次成功、第二次
   HTTP 400 / 8000119 blocked。拆成两个项目后两边都能原地更新。
   Cloudflare 未说明具体触发原因，详见 docs/cloudflare-deployment-diagnosis.md。

用法:
  ${NAME} pages-split [选项]

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID
  --kv <id>              KV 命名空间 ID（两个项目共用；缺省则自动创建）
  --kv-title <title>     自动创建 KV 时使用的标题
  --control <name>       控制面 Pages 项目名（默认随机）
  --data <name>          数据面 Pages 项目名（默认随机）
  --panel-path <path>    面板访问路径（默认随机）
  --yes                  非交互模式

产物来源:
  packages/worker-core/dist/control.js  控制面（面板 + 订阅 + 探针，无 sockets）
  packages/worker-core/dist/dataplane.js 数据面（VLESS/Trojan-WS，CFNext 实现）

部署顺序（不可调换）:
  1. 创建两个 Pages 项目
  2. 配置 KV 绑定与环境变量（Pages 的绑定只对之后的部署生效）
  3. 先部署数据面，再部署控制面（控制面需要数据面域名生成订阅）

Token 所需权限:
  Account / Pages / Edit              创建项目、配置变量、触发部署
  Account / Workers KV Storage / Edit 创建 KV（若未提供 --kv）
`

async function runPagesSplit(args: ReturnType<typeof parseArgs>): Promise<void> {
  const token = flagString(args, 'token') || process.env.CLOUDFLARE_API_TOKEN || ''
  if (!token) {
    process.stderr.write('缺少 --token 参数（或设置 CLOUDFLARE_API_TOKEN）\n')
    process.exitCode = 1
    return
  }

  const client = new CloudflareClient({ token })
  const accountId = flagString(args, 'account') || ''
  let kvId = flagString(args, 'kv') || ''
  let resolvedAccount = accountId

  if (!resolvedAccount) {
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      process.stderr.write('✗ 该 Token 没有可访问的账号\n')
      process.exitCode = 1
      return
    }
    resolvedAccount = accounts[0]!.id
    process.stdout.write(`使用账号：${accounts[0]!.name}（${accounts[0]!.id}）\n`)
  }

  // 缺省则自动创建 KV
  if (!kvId) {
    const title = flagString(args, 'kv-title') || `cfpilot-kv-${Date.now().toString(36)}`
    process.stdout.write(`创建 KV 命名空间：${title}\n`)
    const ns = await client.createKvNamespace(resolvedAccount, title)
    kvId = ns.id
    process.stdout.write(`✓ KV 已创建：${ns.id}\n`)
  }

  const panelPath = flagString(args, 'panel-path') || randomPanelPath()
  const panelPassword = flagString(args, 'panel-password') || randomPassword()
  const controlName = flagString(args, 'control') || randomWorkerName()
  const dataName = flagString(args, 'data') || randomWorkerName()
  const wsPath = flagString(args, 'ws-path') || 'vless'
  const uuid = flagString(args, 'uuid') || randomUUID()
  const trojanPassword = flagString(args, 'trojan-password') || randomPassword()

  process.stdout.write(`\n面板路径：${panelPath}\n面板密码：${panelPassword}\n`)
  process.stdout.write(`UUID：${uuid}\nTrojan 密码：${trojanPassword}\n`)
  process.stdout.write(`控制面项目：${controlName}\n数据面项目：${dataName}\n\n`)

  const result = await deployPagesSplit({
    token,
    accountId: resolvedAccount,
    kvNamespaceId: kvId,
    controlProject: controlName,
    dataProject: dataName,
    panelPath,
    panelPassword,
    uuid,
    trojanPassword,
    wsPath,
    enableTrojan: true,
    enableXhttp: false,
    log: (m) => process.stdout.write(`${m}\n`),
  })

  process.stdout.write(`\n${'─'.repeat(52)}\n`)
  process.stdout.write(`控制面：https://${result.control.subdomain}${panelPath}\n`)
  process.stdout.write(`数据面：https://${result.data.subdomain}\n`)
  process.stdout.write(`\n⚠️ 请把上面的面板路径与密码保存到安全的地方。\n`)

  if (result.warnings.length > 0) {
    process.stdout.write(`\n告警（${result.warnings.length} 条）：\n`)
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.command && !args.command.startsWith('-') ? args.command : ''
  const wantsHelp = flagBool(args, 'h') || flagBool(args, 'help')

  if (command === 'token' && wantsHelp) {
    process.stdout.write(TOKEN_HELP)
    return
  }
  if (command === 'pages-split' && wantsHelp) {
    process.stdout.write(PAGES_HELP)
    return
  }
  if (wantsHelp || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (flagBool(args, 'v') || flagBool(args, 'version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  if (command === 'token') {
    const token = flagString(args, 'token') || process.env.CLOUDFLARE_API_TOKEN || ''
    if (!token) {
      process.stderr.write('缺少 --token 参数（或设置 CLOUDFLARE_API_TOKEN）\n')
      process.exitCode = 1
      return
    }

    // 权限预检：逐项探测并输出人话表格
    if (flagBool(args, 'check')) {
      const zoneName = flagString(args, 'zone') || undefined
      const domain = flagString(args, 'domain') || undefined
      const result = await checkTokenPermissions({
        token,
        accountId: flagString(args, 'account') || undefined,
        zoneName,
        expectCustomDomain: Boolean(zoneName || domain),
      })
      process.stdout.write(renderTokenCheck(result))
      if (!result.ok) process.exitCode = 1
      return
    }

    // 传统模式：只列账号与 Token 有效期
    const client = new CloudflareClient({ token })
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      process.stderr.write('✗ 该 Token 没有可访问的账号\n')
      process.exitCode = 1
      return
    }
    for (const account of accounts) {
      process.stdout.write(`✓ 账号：${account.name}（${account.id}）\n`)
      try {
        const verify = await client.verifyToken(account.id)
        const expiry = verify.expiresOn ? `，到期 ${verify.expiresOn}` : ''
        process.stdout.write(`  Token 状态：${verify.status}${expiry}\n`)
      } catch (err) {
        process.stdout.write(
          `  Token 元信息不可读（${err instanceof Error ? err.message : String(err)}），但账号读取正常\n`
        )
      }
    }
    process.stdout.write('\n提示：加上 --check 可逐项探测 Token 权限并给出缺失后果。\n')
    return
  }

  if (command === 'pages-split') {
    if (flagBool(args, 'dry-run')) {
      process.stdout.write('（dry-run）将执行 Pages 双项目部署，未实际调用 API\n')
      return
    }
    await runPagesSplit(args)
    return
  }

  const result = await deploy({
    token: flagString(args, 'token') || undefined,
    accountId: flagString(args, 'account') || undefined,
    workerName: flagString(args, 'worker') || undefined,
    zoneName: flagString(args, 'zone') || undefined,
    hostname: flagString(args, 'domain') || undefined,
    kvTitle: flagString(args, 'kv-title') || undefined,
    workersDev: flagBool(args, 'workers-dev'),
    yes: flagBool(args, 'yes'),
    dryRun: flagBool(args, 'dry-run'),
  })
  printResult(result)
}

main().catch((err) => {
  process.stderr.write(`\n执行失败：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
