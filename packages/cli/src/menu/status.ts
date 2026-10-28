/**
 * 实例状态查询
 */

import { c, box, status } from './ui'
import { select } from './prompt'
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

    // ⚠️ **不要静默用 accounts[0]**：配置里的 KV / 域名可能是另一个账号的，
    // 拿 accounts[0] 去查会显示完全不相干的实例（看起来像「部署丢了」）。
    //
    // 优先用配置里的账号；没有就列出账号让用户选。
    let account = accounts.find((a) => a.id === cfg.accountId)
    if (!account) {
      if (accounts.length === 1) {
        account = accounts[0]!
      } else {
        const picked = await select(
          '检测到多个账号，请选择要查看哪个',
          accounts.map((a) => ({ label: a.name, value: a.id, hint: a.id.slice(0, 12) + '…' }))
        )
        if (!picked) {
          status('info', '已取消')
          return
        }
        account = accounts.find((a) => a.id === picked) ?? accounts[0]!
      }
    }
    const accountId = account.id
    const accountName = account.name
    if (cfg.accountId !== accountId) saveConfig({ accountId, accountName })

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
