/**
 * cfpilot token —— 检查 API Token 权限
 */

import { flagBool, flagString, type ParsedArgs } from '../shared/args'
import { CloudflareClient } from './cf-api'
import { checkTokenPermissions, renderTokenCheck } from './token-check'

export async function runTokenCheck(args: ParsedArgs): Promise<void> {
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
}
