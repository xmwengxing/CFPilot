/**
 * cfpilot deploy —— Pages 双项目部署（子命令实现）
 *
 * 与原 cfpilot-deploy pages-split 的命令行行为完全一致。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  flagBool,
  flagString,
  type ParsedArgs,
} from '../shared/args'
import { CloudflareClient } from './cf-api'
import {
  deployPagesSplit,
  listCfPilotNamespaces,
  type PagesSplitDeployResult,
} from './pages-deploy'
import { randomWorkerName } from './utils'
import { DEPLOY_HELP } from './help'
import { renderTokenCheck, checkTokenPermissions } from './token-check'

export async function listKvInstances(client: CloudflareClient, accountId: string): Promise<void> {
  const namespaces = await client.listKvNamespaces(accountId)
  process.stdout.write(`账号下共 ${namespaces.length} 个 KV 命名空间：\n`)
  const instances = await listCfPilotNamespaces(client, accountId)
  const instanceIds = new Set(instances.map((i) => i.id))
  for (const ns of namespaces) {
    const instance = instances.find((i) => i.id === ns.id)
    if (instance) {
      process.stdout.write(
        `  ● ${ns.id}  ${ns.title}\n` +
          `      实例：控制面 ${instance.manifest.controlProject} / 数据面 ${instance.manifest.dataProject}\n` +
          `      域名：${instance.manifest.controlSubdomain} / ${instance.manifest.dataSubdomain}\n` +
          `      部署于 ${instance.manifest.at}，版本 ${instance.manifest.build}\n`
      )
    } else {
      process.stdout.write(`  ○ ${ns.id}  ${ns.title}  （不含 CFPilot 实例）\n`)
    }
  }
  process.stdout.write(
    `\n共 ${instances.length} 个 CFPilot 实例。\n` +
      (instanceIds.size > 0
        ? '更新某个实例：cfpilot deploy --kv <id>\n'
        : '') +
      '部署新实例：cfpilot deploy --new-kv\n'
  )
}


export async function runDeployCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(DEPLOY_HELP)
    return
  }

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

  // --list-kv：只列出账号下的实例，不部署
  if (flagBool(args, 'list-kv')) {
    await listKvInstances(client, resolvedAccount)
    return
  }

  /* ---------------- KV 解析：定位本次要部署的实例 ---------------- */

  const forceNewKv = flagBool(args, 'new-kv')
  const existing = await listCfPilotNamespaces(client, resolvedAccount)

  if (!kvId && !forceNewKv) {
    if (existing.length === 0) {
      // 账号下还没有 CFPilot 实例 → 全新部署
      const title = flagString(args, 'kv-title') || `cfpilot-kv-${Date.now().toString(36)}`
      process.stdout.write(`创建 KV 命名空间：${title}\n`)
      const ns = await client.createKvNamespace(resolvedAccount, title)
      kvId = ns.id
      process.stdout.write(`✓ KV 已创建：${ns.id}\n`)
    } else if (existing.length === 1) {
      // 恰好一个实例 → 复用（进入更新模式，沿用 UUID 与 WS 路径）
      const only = existing[0]!
      kvId = only.id
      process.stdout.write(
        `✓ 复用已有实例的 KV：${only.title}（${only.id}）\n` +
          `  控制面 ${only.manifest.controlProject} / 数据面 ${only.manifest.dataProject}\n` +
          `  部署于 ${only.manifest.at}\n`
      )
    } else {
      // 多个实例 → 必须明确指定，避免部署到错误的实例上
      process.stderr.write('✗ 该账号下有多个 CFPilot 实例，请用 --kv <id> 指定要部署哪一个：\n')
      for (const item of existing) {
        process.stderr.write(
          `    ${item.id}  ${item.title}  ` +
            `控制面 ${item.manifest.controlProject} / 数据面 ${item.manifest.dataProject}  ` +
            `（${item.manifest.at}）\n`
        )
      }
      process.stderr.write('  部署第 N 个新实例请加 --new-kv\n')
      process.exitCode = 1
      return
    }
  } else if (!kvId && forceNewKv) {
    // 显式要求新建实例
    const title = flagString(args, 'kv-title') || `cfpilot-kv-${Date.now().toString(36)}`
    process.stdout.write(`创建新的 KV 命名空间（--new-kv）：${title}\n`)
    const ns = await client.createKvNamespace(resolvedAccount, title)
    kvId = ns.id
    process.stdout.write(`✓ KV 已创建：${ns.id}\n`)
    if (existing.length > 0) {
      process.stdout.write(`· 账号下现有 ${existing.length} 个实例，本次为第 ${existing.length + 1} 个\n`)
    }
  }

  const mode = (flagString(args, 'mode') || 'auto') as 'auto' | 'fresh' | 'update'
  if (!['auto', 'fresh', 'update'].includes(mode)) {
    process.stderr.write(`✗ --mode 只接受 auto / fresh / update，收到：${mode}\n`)
    process.exitCode = 1
    return
  }
  // 默认沿用旧凭据：客户端订阅地址不变。显式传参则覆盖。
  const keepCredentials = !flagBool(args, 'new-credentials')
  const skipSameVersion = !flagBool(args, 'force')

  const panelPath = flagString(args, 'panel-path') || ''
  const panelPassword = flagString(args, 'panel-password') || ''
  const controlName = flagString(args, 'control') || randomWorkerName()
  const dataName = flagString(args, 'data') || randomWorkerName()
  // WS 路径默认随机：不用 /vless 这类字面量（强特征文本，且所有默认部署完全一致）
  const wsPath = flagString(args, 'ws-path') || ''
  const uuid = flagString(args, 'uuid') || ''
  const trojanPassword = flagString(args, 'trojan-password') || ''

  // 本地产物版本：构建时由 build.mjs 注入，这里从产物里读出来
  const localBuild = await readLocalBuild()

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
    mode,
    keepCredentials,
    skipSameVersion,
    force: flagBool(args, 'force-kv'),
    // 默认开启；`--resolve-preferred=false` 可关闭
    resolvePreferred: args.flags['resolve-preferred'] === undefined
      ? true
      : flagBool(args, 'resolve-preferred'),
    localBuild,
    log: (m) => process.stdout.write(`${m}\n`),
  })

  process.stdout.write(`\n${'─'.repeat(52)}\n`)
  process.stdout.write(`控制面：https://${result.control.subdomain}${result.panelPath ?? ''}\n`)
  process.stdout.write(`数据面：https://${result.data.subdomain}\n`)
  if (result.uuid) process.stdout.write(`UUID：${result.uuid}\n`)
  if (result.wsPath) process.stdout.write(`WS 路径：${result.wsPath}\n`)
  if (result.panelPassword) process.stdout.write(`面板密码：${result.panelPassword}\n`)

  process.stdout.write(`✅ 部署成功\n`)

  if (result.warnings.length > 0) {
    process.stdout.write(`\n告警（${result.warnings.length} 条）：\n`)
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`)
  }
}

/**
 * 从本地产物里读构建版本。
 *
 * 版本号在构建时由 esbuild 的 define 注入为 `__CFP_BUILD__` 常量，
 * 打包后会以字符串形式出现在产物里。读不到时返回 undefined，
 * 此时不做版本跳过（保守起见仍然部署）。
 */

async function readLocalBuild(): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      resolve(here, '../worker-core/dist/control.js'),
      resolve(here, '../../worker-core/dist/control.js'),
      resolve(process.cwd(), 'packages/worker-core/dist/control.js'),
    ]
    for (const candidate of candidates) {
      try {
        const code = await readFile(candidate, 'utf8')
        // 匹配形如 "abc1234-202610221430" 的版本串
        const m = /["']([0-9a-f]{7,10}-\d{12})["']/.exec(code)
        if (m) return m[1]
      } catch {
        /* 试下一个 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return undefined
}

