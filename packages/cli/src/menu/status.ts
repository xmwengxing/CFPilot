/**
 * 实例状态查询
 */

import { c, box, status } from './ui'
import { loadConfig, saveConfig, resolveToken } from './store'
import { CloudflareClient } from '../deploy/cf-api'
import { listKvInstances } from '../deploy/command'

/** 交互式状态查询。 */
export async function menuStatus(): Promise<void> {
  const cfg = loadConfig()
  const token = resolveToken()
  if (!token) {
    status('warn', '尚未配置 API Token')
    status('info', '请到「配置」菜单设置')
    return
  }

  status('info', '正在读取账号与实例…')
  try {
    const client = new CloudflareClient({ token })
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      status('fail', '该 Token 没有可访问的账号')
      return
    }

    const accountId = cfg.accountId || accounts[0]!.id
    const accountName = accounts.find((a) => a.id === accountId)?.name ?? accounts[0]!.name
    if (!cfg.accountId) saveConfig({ accountId, accountName })

    process.stdout.write('\n')
    box('当前实例', [`${c.gray('账号')} ${accountName}`, `${c.gray('ID')}   ${accountId}`])
    process.stdout.write('\n')

    await listKvInstances(client, accountId)
  } catch (err) {
    status('fail', `查询失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 命令行 status 子命令。 */
export async function runStatus(): Promise<void> {
  await menuStatus()
}
