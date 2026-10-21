/**
 * cfpilot-deploy —— CFPilot 全中文部署向导
 *
 * 注意：不要在这里手写 shebang。
 * 构建脚本（scripts/build.mjs）会通过 esbuild banner 注入，
 * 两处都写会导致产物出现两行 #!，Node 只认第一行，直接语法报错。
 */
import { flagBool, flagString, parseArgs } from './args'
import { CloudflareClient } from './cf-api'
import { deploy, printResult } from './wizard'
import { NAME, VERSION } from './version'

const HELP = `
${NAME} v${VERSION}
CFPilot 全中文部署向导 —— 自动创建 KV、部署 Worker 内核、绑定自定义域名。

用法:
  ${NAME} init [选项]     执行部署
  ${NAME} token [选项]   仅校验 API Token
  ${NAME} --help         显示帮助
  ${NAME} --version      显示版本

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID（跳过选择）
  --worker <name>        Worker 名称（默认随机）
  --zone <domain>        绑定的主域名，如 example.com
  --domain <hostname>    完整自定义域名，如 cfpilot.example.com
  --kv-title <title>     KV 命名空间标题
  --workers-dev          不绑定自定义域名，直接使用 workers.dev
  --yes                  非交互模式
  --dry-run              只演示流程，不实际上传

Token 所需权限（Cloudflare 新版权限名）:
  Developer Platform / Workers / Admin
      上传内核、读脚本与 workers.dev 子域名、绑定自定义域名
      注意：仅勾 Edit 无法创建 Worker，也无法管理 Routes
  Developer Platform / Workers KV Storage / Edit
      创建并绑定 KV 命名空间（优选池、配置、会话都存这里）
  DNS & Zones / DNS / Edit
      绑定自定义域名时创建 CNAME（仅 Route 回退路径需要）
  DNS & Zones / Workers Routes / Edit（可选）
      自定义域名绑定失败时的 Route 回退路径
  DNS & Zones / Zone / Read
      列出账号下的域名

    以下权限本项目完全用不到，可以不勾：
      Registrar Domains / Registrar Sandbox Domains（域名注册）
      Account DNS Setting（账号级 DNS 默认设置，向导不调用）

Token 有效期说明:
  account-owned Token（cfat_ 前缀）无需 /user/tokens/verify，
  向导会自动改用账号维度校验，不影响部署。
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.command && !args.command.startsWith('-') ? args.command : ''

  if (flagBool(args, 'h') || flagBool(args, 'help') || command === 'help') {
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
      process.exit(1)
    }
    const client = new CloudflareClient({ token })
    // 先取账号：这是 Token 可用性最可靠的判断依据
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      process.stderr.write('✗ 该 Token 没有可访问的账号\n')
      process.exit(1)
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
  process.stderr.write(`\n部署失败：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
