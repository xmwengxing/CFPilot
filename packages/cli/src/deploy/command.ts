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
import { checkKvInAccount, findAccountByKv } from './account-resolve'
import {
  deployPagesSplit,
  listCfPilotNamespaces,
  type PagesSplitDeployResult,
} from './pages-deploy'
import {
  extractBuildVersion,
  fetchRemoteKernelInfo,
  loadBuiltinBundle,
} from './kernel-remote'
import { randomWorkerName } from './utils'
import { DEPLOY_HELP } from './help'
import { renderTokenCheck, checkTokenPermissions } from './token-check'
import { compareSemver } from '../shared/version-util'
import { VERSION } from '../shared/version'

export async function listKvInstances(client: CloudflareClient, accountId: string): Promise<void> {
  const namespaces = await client.listKvNamespaces(accountId)
  process.stdout.write(`账号下共 ${namespaces.length} 个 KV 命名空间：\n`)
  const instances = await listCfPilotNamespaces(client, accountId)
  const instanceIds = new Set(instances.map((i) => i.id))

  // 远程最新内核版本：查不到就是 null（离线 / 限流 / 没有带内核的发行版）。
  //
  // ⚠️ 这里**不阻塞**主流程 —— 查不到时只是少一行「远程」信息，
  // 绝不能因为 GitHub 不可达就让「检查状态」失败。
  const remote = await fetchRemoteKernelInfo({ timeoutMs: 8000 })

  for (const ns of namespaces) {
    const instance = instances.find((i) => i.id === ns.id)
    if (instance) {
      // 线上内核版本：清单里的 kernelVersion（semver）。
      // 旧清单没有这个字段 → 空串 → 显示「未知」，绝不显示 "unknown"。
      const online = instance.manifest.kernelVersion?.trim() || '未知'
      process.stdout.write(
        `  ● ${ns.id}  ${ns.title}\n` +
          `      实例：控制面 ${instance.manifest.controlProject} / 数据面 ${instance.manifest.dataProject}\n` +
          `      域名：${instance.manifest.controlSubdomain} / ${instance.manifest.dataSubdomain}\n` +
          `      部署于 ${instance.manifest.at}，版本 ${instance.manifest.build}\n` +
          `      内核版本：线上 ${online} ｜ 内置 ${VERSION} ｜ 远程 ${remote?.version ?? '未知'}\n`
      )
    } else {
      process.stdout.write(`  ○ ${ns.id}  ${ns.title}  （不含 CFPilot 实例）\n`)
    }
  }

  // 内置 vs 远程：semver 能比出**谁更新**，build 指纹只能说明「不一样」。
  if (remote) {
    const cmp = compareSemver(remote.version, VERSION)
    const hint =
      cmp > 0
        ? `远程内核 ${remote.version} 比内置 ${VERSION} 更新，部署时会自动使用远程内核。`
        : cmp === 0
          ? `远程内核 ${remote.version} 与内置版本一致。`
          : `远程内核 ${remote.version} 比内置 ${VERSION} 旧，将使用内置内核。`
    process.stdout.write(`\n${hint}\n`)
  }

  process.stdout.write(
    `\n共 ${instances.length} 个 CFPilot 实例。\n` +
      (instanceIds.size > 0
        ? '更新某个实例：cfpilot deploy --kv <id>\n'
        : '') +
      '部署新实例：cfpilot deploy --new-kv\n'
  )
}


/**
 * 解析本次部署要用的账号。
 *
 * ## 规则
 *
 *   1. 给了 `--account` → 用它；若同时给了 `--kv`，**校验两者同源**。
 *   2. 只给了 `--kv` → 用 KV **反查**它所属的账号（KV 是账号作用域的）。
 *      查不到就报错要求显式指定 `--account`。
 *   3. 两个都没给 → 回落第一个账号（全新部署的常见场景，没有 KV 参与）。
 *
 * ## 为什么第 2 条不能盲取 accounts[0]
 *
 * 账号取自 A、KV 取自 B 时，部署会在 A 里建出**孤儿 Pages 项目**，
 * KV 绑定必然失败、配置写不进去 → 半成品实例 + 一堆垃圾。
 * KV 归属哪个账号只能靠反查（CF 没有「按 KV ID 查账号」的接口）。
 *
 * @returns 解析结果；`ok: false` 时 `message` 是给用户看的错误说明。
 */
export interface AccountResolution {
  ok: boolean
  /** 解析出的账号 ID（ok 为 true 时有值） */
  accountId: string
  /** 账号名（仅用于展示） */
  accountName: string
  /** 给用户看的说明 */
  message: string
  /** 账号是怎么来的 */
  source: 'flag' | 'kv-lookup' | 'first'
}

export async function resolveDeployAccount(
  client: CloudflareClient,
  options: { accountFlag: string; kvId: string; /** --list-kv 只按账号列实例，与 KV 无关 */
    ignoreKv?: boolean }
): Promise<AccountResolution> {
  const { accountFlag } = options
  const kvId = options.ignoreKv ? '' : options.kvId

  if (accountFlag) {
    // ⚠️ **账号与 KV 必须同源**。
    //
    // 显式给了 --account 与 --kv，但两者分属不同账号时，
    // 部署会在 --account 的账号下建出孤儿 Pages 项目、KV 绑定必然失败。
    // 这里提前拦下来（比部署到一半失败好得多）。
    if (kvId) {
      const check = await checkKvInAccount(client, accountFlag, kvId)
      if (check === 'no') {
        return {
          ok: false,
          accountId: '',
          accountName: '',
          source: 'flag',
          message:
            `✗ KV ${kvId} 不属于账号 ${accountFlag}\n` +
            '  → 账号与 KV 必须属于同一个 Cloudflare 账号，否则会建出无法使用的孤儿项目\n',
        }
      }
      if (check === 'unknown') {
        // 读不到 → 不能确认，但也不该直接拒绝（可能是权限不足）。
        // 真正的归属校验在部署前的 assertKvOwnership 里还会再做一次。
        return {
          ok: true,
          accountId: accountFlag,
          accountName: accountFlag,
          source: 'flag',
          message: `· 未能确认 KV ${kvId} 是否属于该账号（读取 KV 列表失败），继续\n`,
        }
      }
    }
    return {
      ok: true,
      accountId: accountFlag,
      accountName: accountFlag,
      source: 'flag',
      message: `使用账号：${accountFlag}\n`,
    }
  }

  const accounts = await client.listAccounts()
  if (accounts.length === 0) {
    return {
      ok: false,
      accountId: '',
      accountName: '',
      source: 'first',
      message: '✗ 该 Token 没有可访问的账号\n',
    }
  }

  if (kvId) {
    // 用 KV 反查它属于哪个账号（KV 是账号作用域的，只能逐个账号查）。
    const { owner, unreadable } = await findAccountByKv(client, accounts, kvId)
    if (!owner) {
      const names = accounts.map((a) => a.name).join('、')
      return {
        ok: false,
        accountId: '',
        accountName: '',
        source: 'kv-lookup',
        message:
          unreadable > 0
            ? `✗ 无法确定 KV ${kvId} 属于哪个账号（${names}；其中 ${unreadable} 个账号的 KV 列表读取失败）\n` +
              '  → 请用 --account <账号ID> 与 --kv <KV ID> 一起指定\n'
            : `✗ KV ${kvId} 不属于该 Token 的任何账号（${names}）\n` +
              '  → 请用 --account <账号ID> 与 --kv <KV ID> 一起指定\n',
      }
    }
    return {
      ok: true,
      accountId: owner.id,
      accountName: owner.name,
      source: 'kv-lookup',
      message: `使用账号：${owner.name}（${owner.id}，由 --kv 反查）\n`,
    }
  }

  // 没给 --kv 时才回落第一个账号（全新部署的常见场景）
  return {
    ok: true,
    accountId: accounts[0]!.id,
    accountName: accounts[0]!.name,
    source: 'first',
    message: `使用账号：${accounts[0]!.name}（${accounts[0]!.id}）\n`,
  }
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
  let kvId = flagString(args, 'kv') || ''

  // --list-kv：只列出账号下的实例，不部署（与 KV 无关）
  const listKv = flagBool(args, 'list-kv')

  const resolution = await resolveDeployAccount(client, {
    accountFlag: flagString(args, 'account') || '',
    kvId,
    ignoreKv: listKv,
  })
  if (!resolution.ok) {
    process.stderr.write(resolution.message)
    process.exitCode = 1
    return
  }
  const resolvedAccount = resolution.accountId
  process.stdout.write(resolution.message)

  if (listKv) {
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

  // 数据面部署形态：不传 = 沿用清单（旧清单按 pages 处理）
  const dataPlaneRaw = (flagString(args, 'data-plane') || '').toLowerCase()
  if (dataPlaneRaw && dataPlaneRaw !== 'pages' && dataPlaneRaw !== 'workers') {
    process.stderr.write(`✗ --data-plane 只接受 pages / workers，收到：${dataPlaneRaw}\n`)
    process.exitCode = 1
    return
  }
  const dataPlaneMode = dataPlaneRaw ? (dataPlaneRaw as 'pages' | 'workers') : undefined
  const dataHost = flagString(args, 'data-host') || ''
  if (dataHost && dataPlaneMode !== 'workers') {
    process.stderr.write('· --data-host 只对 --data-plane workers 生效，已忽略\n')
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
    // XHTTP 默认开启（2026-10-28 用户要求）：
    // 数据面上它只是多一条「必须带合法 VLESS 头」的 POST 路由，开了不影响安全；
    // 想关在面板「入站配置 → 启用服务端 XHTTP 入站监听」关即可
    //（KV 配置优先级高于环境变量，面板开关会覆盖这里的默认值）。
    enableXhttp: true,
    // 数据面形态：不传 = 沿用清单；显式传且与清单不一致 = 切换形态
    dataPlaneMode,
    dataHost: dataPlaneMode === 'workers' ? dataHost : undefined,
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
 *
 * ⚠️ 早期这里的正则只认**纯数字时间戳**格式（`abc1234-202610221430`），
 * 而现在的构建指纹是 `<git 短 hash>-<源码 hash>`（如 `c431307-65b74f9b`），
 * 两者都是十六进制 —— 于是正则**匹配不到**，版本号恒为 undefined，
 * 「同版本跳过」与清单里的 build 字段因此一直是空的。
 * 现在统一走 shared 的 extractBuildVersion，两种格式都认。
 */
async function readLocalBuild(): Promise<string | undefined> {
  try {
    const code = await loadBuiltinBundle('control.js')
    return extractBuildVersion(code) || undefined
  } catch {
    /* 读不到就当没有版本号 */
  }
  return undefined
}

