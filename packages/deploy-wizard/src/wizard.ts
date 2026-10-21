/**
 * 全中文部署向导
 *
 * 步骤：
 *   1. 校验 Cloudflare API Token
 *   2. 选择账号
 *   3. 生成随机化 Worker 名称
 *   4. 自动创建并绑定 KV 命名空间
 *   5. 生成面板路径 / 管理密码 / 扫描令牌
 *   6. 绑定自定义域名（或回退到 workers.dev）
 *   7. 上传内核并输出面板地址、订阅地址与扫描命令
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { CloudflareClient, CloudflareError, type ScriptBinding } from './cf-api'
import { randomPanelPath, randomPassword, randomWorkerName, randomHex } from './utils'

export interface DeployOptions {
  token?: string
  accountId?: string
  workerName?: string
  zoneName?: string
  /** 完整自定义域名，例如 cfpilot.example.com */
  hostname?: string
  kvTitle?: string
  /** 强制使用 workers.dev */
  workersDev?: boolean
  /** 非交互模式 */
  yes?: boolean
  dryRun?: boolean
}

export interface DeployResult {
  accountId: string
  workerName: string
  kvId: string
  panelPath: string
  panelPassword: string
  scannerToken: string
  url: string
  subscriptionUrl: string
  mode: 'custom-domain' | 'workers.dev'
}

const COMPATIBILITY_DATE = '2026-01-01'

function line(text = ''): void {
  stdout.write(`${text}\n`)
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const suffix = fallback ? ` [${fallback}]` : ''
    const answer = (await rl.question(`${question}${suffix}: `)).trim()
    return answer || fallback
  } finally {
    rl.close()
  }
}

async function askChoice(question: string, options: string[]): Promise<number> {
  options.forEach((option, index) => line(`  ${index + 1}) ${option}`))
  for (;;) {
    const answer = (await ask(`${question} [1-${options.length}]`, '1')).trim()
    const index = Number(answer)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return index - 1
    line('  请输入列表中的序号。')
  }
}

/** 读取内置内核资产（dist/../assets/cfpilot-worker.js） */
export async function loadWorkerAsset(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../assets/cfpilot-worker.js'),
    resolve(here, '../../assets/cfpilot-worker.js'),
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      /* 尝试下一个路径 */
    }
  }
  throw new Error(
    '未找到内核资产 assets/cfpilot-worker.js，请在 monorepo 中执行 npm run build -w @cfpilot/worker-core'
  )
}

/** 执行部署 */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const interactive = !options.yes
  const token =
    options.token ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CF_API_TOKEN ||
    (interactive ? await ask('请输入 Cloudflare API Token') : '')

  if (!token) throw new Error('缺少 API Token')

  const client = new CloudflareClient({ token })
  line('正在校验 API Token…')
  try {
    const verify = await client.verifyToken()
    line(`✓ Token 有效（状态：${verify.status}）`)
  } catch (err) {
    if (err instanceof CloudflareError) {
      throw new Error(`Token 校验失败：${err.message}`)
    }
    throw err
  }

  // 1) 账号
  const accounts = await client.listAccounts()
  if (accounts.length === 0) throw new Error('该 Token 没有可访问的账号')
  let accountId = options.accountId
  if (!accountId) {
    if (interactive) {
      const index = await askChoice(
        '请选择要部署到的账号',
        accounts.map((a) => `${a.name}（${a.id}）`)
      )
      accountId = accounts[index]!.id
    } else {
      accountId = accounts[0]!.id
    }
  }
  const account = accounts.find((a) => a.id === accountId)
  line(`✓ 目标账号：${account?.name ?? accountId}`)

  // 2) Worker 名称
  const workerName = options.workerName || randomWorkerName()
  line(`✓ Worker 名称：${workerName}`)

  // 3) KV 命名空间
  const kvTitle = options.kvTitle || `${workerName}-kv`
  let kvId = ''
  if (!options.dryRun) {
    line('正在创建 KV 命名空间…')
    const namespace = await client.createKvNamespace(accountId, kvTitle)
    kvId = namespace.id
    line(`✓ KV 命名空间：${kvTitle}（${kvId}）`)
  } else {
    kvId = 'dry-run-namespace-id'
    line('（dry-run：跳过 KV 创建）')
  }

  // 4) 面板凭证
  const panelPath = randomPanelPath()
  const panelPassword = randomPassword()
  const scannerToken = randomHex(24)
  line(`✓ 面板路径：${panelPath}`)
  line(`✓ 管理密码：${panelPassword}`)

  // 5) 域名
  let hostname = options.hostname ?? ''
  let mode: 'custom-domain' | 'workers.dev' = 'workers.dev'
  const workersSubdomain = await client.getWorkersSubdomain(accountId).catch(() => '')
  const zones = options.workersDev ? [] : await client.listZones(options.zoneName)

  if (!options.workersDev && zones.length > 0) {
    if (!hostname) {
      if (interactive) {
        const index = await askChoice(
          '请选择要绑定的域名',
          zones.map((z) => `${z.name}（${z.id}）`)
        )
        const zone = zones[index]!
        const sub = await ask('请输入二级域名（不含主域名）', 'cfpilot')
        hostname = `${sub}.${zone.name}`
      } else {
        const zone = zones[0]!
        hostname = `cfpilot.${zone.name}`
      }
    }
    mode = 'custom-domain'
  }

  // 6) 上传内核
  if (!options.dryRun) {
    const code = await loadWorkerAsset()
    const bindings: ScriptBinding[] = [
      { type: 'kv_namespace', name: 'KV', namespace_id: kvId },
      { type: 'plain_text', name: 'PANEL_PASSWORD', text: panelPassword },
      { type: 'plain_text', name: 'PANEL_PATH', text: panelPath },
      { type: 'plain_text', name: 'SCANNER_TOKEN', text: scannerToken },
    ]
    line('正在上传 Worker 内核…')
    await client.uploadScript(accountId, workerName, {
      mainModule: 'worker.js',
      code,
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
    })
    line('✓ 内核已上传')

    // 7) 绑定域名
    if (mode === 'custom-domain' && hostname) {
      const zone = zones.find((z) => hostname.endsWith(z.name))
      try {
        await client.attachCustomDomain(accountId, {
          hostname,
          service: workerName,
          zoneId: zone?.id ?? '',
        })
        line(`✓ 已绑定自定义域名：${hostname}`)
      } catch (err) {
        line(`⚠ 自定义域名绑定失败（${err instanceof Error ? err.message : String(err)}），改用 Route 方式`)
        if (workersSubdomain) {
          await client.createDnsRecord(zone!.id, {
            type: 'CNAME',
            name: hostname,
            content: `${workerName}.${workersSubdomain}.workers.dev`,
            proxied: true,
          })
        }
        await client.createRoute(zone!.id, { pattern: `${hostname}/*`, script: workerName })
        line(`✓ 已创建 Route：${hostname}/*`)
      }
    }
  } else {
    line('（dry-run：跳过上传与域名绑定）')
  }

  const base = mode === 'custom-domain' && hostname ? `https://${hostname}` : `https://${workerName}.${workersSubdomain}.workers.dev`

  return {
    accountId,
    workerName,
    kvId,
    panelPath,
    panelPassword,
    scannerToken,
    url: `${base}${panelPath}`,
    subscriptionUrl: `${base}/sub/<UUID>`,
    mode,
  }
}

/** 打印部署结果 */
export function printResult(result: DeployResult): void {
  line('')
  line('══════════════════════════════════════════════════')
  line('  CFPilot 部署完成 🎉')
  line('══════════════════════════════════════════════════')
  line(`  面板地址   ：${result.url}`)
  line(`  管理密码   ：${result.panelPassword}`)
  line(`  Worker 名  ：${result.workerName}`)
  line(`  KV 命名空间：${result.kvId}`)
  line(`  订阅地址   ：${result.subscriptionUrl}（把 <UUID> 换成面板里的 UUID）`)
  line('')
  line('  本地优选命令：')
  line(`  npx -y cfpilot-scanner@latest --host "${new URL(result.url).hostname}" --token "${result.scannerToken}"`)
  line('')
  line('  提示：')
  line('   1. 请妥善保存管理密码；面板路径可随时更换。')
  line('   2. 若使用 workers.dev 域名，部分网络可能无法直连，建议绑定自定义域名。')
  line('   3. 想升级内核？重新执行 cfpilot-deploy init 即可，KV 数据会保留。')
  line('')
}
