#!/usr/bin/env node
/**
 * cfpilot-deploy —— CFPilot 全中文部署向导
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

Token 所需权限:
  Account / Workers Scripts / Edit
  Account / Workers KV Storage / Edit
  Account / Workers Tail / Read（可选）
  Zone / Zone / Read
  Zone / DNS / Edit
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
    const verify = await client.verifyToken()
    process.stdout.write(`✓ Token 有效（状态：${verify.status}）\n`)
    const accounts = await client.listAccounts()
    for (const account of accounts) {
      process.stdout.write(`  账号：${account.name}（${account.id}）\n`)
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
