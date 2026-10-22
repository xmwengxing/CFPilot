/**
 * Pages 双项目部署（控制面 + 数据面）
 *
 * ## 背景
 *
 * 2026-10-22 真机复现：合并包部署到 Pages，第一次成功、第二次
 * `HTTP 400 / 8000119 Your Pages project has been blocked`。
 * 拆成两个项目后两边都能原地更新。
 *
 * ⚠️ 这不是「Cloudflare 要求拆分」的结论，而是**当前唯一实测可用的安排**。
 * Cloudflare 未说明具体触发原因，因此不能断定是哪段代码、哪条规则导致的。
 * 详见 docs/cloudflare-deployment-diagnosis.md。
 *
 * ## 部署形态
 *
 *   ┌─────────────┐      ┌─────────────┐
 *   │ 控制面 Pages │      │ 数据面 Pages │
 *   │ 面板/订阅/探针│      │ VLESS/Trojan │
 *   │ 无 sockets   │      │ CFNext 数据面 │
 *   └──────┬──────┘      └──────┬──────┘
 *          └────── 共用同一 KV ──┘
 *
 *   控制面通过 DATA_HOST 环境变量知道数据面域名，
 *   生成订阅时用它作为节点地址（sni/host）。
 *
 * ## 硬性顺序
 *
 * 建项目 → 设变量/绑 KV → 最后才部署。
 * Pages 的绑定与变量只对**之后的**部署生效，先部署再配置等于白配。
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CloudflareClient, CloudflareError, type PagesDeployment } from './cf-api'

export interface PagesSplitDeployOptions {
  token: string
  accountId: string
  /** KV 命名空间 ID（两个项目共用） */
  kvNamespaceId: string
  /** 控制面 Pages 项目名 */
  controlProject: string
  /** 数据面 Pages 项目名 */
  dataProject: string
  /** 面板访问路径，如 /p-a1b2c3 */
  panelPath: string
  /** 面板密码 */
  panelPassword: string
  /** VLESS UUID */
  uuid: string
  /** Trojan 密码 */
  trojanPassword: string
  /** WS 路径（不含前导斜杠） */
  wsPath: string
  /** 是否启用 Trojan */
  enableTrojan: boolean
  /** 是否启用 XHTTP */
  enableXhttp: boolean
  /** 扫描令牌（可选） */
  scannerToken?: string
  /** 部署完成后的等待与轮询配置 */
  wait?: { timeoutMs: number; intervalMs: number }
  /** 覆盖 API 地址（测试用；生产环境不要传） */
  apiBase?: string
  /**
   * 覆盖内核产物内容（测试用；生产环境不传，从 dist/ 读取）。
   * 键为 control / data，值为对应 JS 源码。
   */
  bundles?: { control?: string; data?: string }
  log?: (message: string) => void
}

export interface PagesSplitDeployResult {
  control: { name: string; subdomain: string; deploymentId?: string }
  data: { name: string; subdomain: string; deploymentId?: string }
  warnings: string[]
}

/**
 * 检测 KV 里是否已有会覆盖环境变量的配置。
 *
 * 内核的配置优先级是 **KV(CONFIG) > 环境变量 > 默认值**。
 * 因此复用已有 KV 时，本次生成的随机路径 / 密码 / UUID / WS 路径都不会生效，
 * 用户会拿着「新密码」登不进去。这里提前读出来并明确告知。
 */
async function detectKvConfigConflict(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  log: (m: string) => void
): Promise<void> {
  const keys = ['PANEL_PATH', 'ADMIN_PW_HASH', 'CONFIG', 'config']
  const found: string[] = []
  for (const key of keys) {
    const value = await client.getKvValue(accountId, namespaceId, key)
    if (value !== null) found.push(key)
  }
  if (found.length === 0) {
    log('· KV 是空的，本次生成的凭据会生效')
    return
  }

  log(`⚠ KV 里已存在配置：${found.join('、')}`)
  log('  内核优先级为 KV(CONFIG) > 环境变量，因此本次生成的随机凭据不会生效。')
  log('  请使用首次部署时生成的凭据登录；如需重置，先删除这些 KV 键再重新部署。')

  const panelPath = await client.getKvValue(accountId, namespaceId, 'PANEL_PATH')
  if (panelPath) log(`  · 实际生效的面板路径：${panelPath}`)
}

/** 测试专用：用显式 apiBase 跑 KV 冲突检测 */
export async function detectKvConfigConflictForTest(
  apiBase: string,
  log: (m: string) => void
): Promise<void> {
  const client = new CloudflareClient({ token: 'test-token', apiBase })
  await detectKvConfigConflict(client, 'acc', 'ns', log)
}

/**
 * 读取 worker-core 的构建产物。
 *
 * 打包后 `here` 是 `packages/deploy-wizard/dist`，所以 worker-core 在
 * `../worker-core/dist/`；开发时（ts 源码直接跑）`here` 是 `src/`，
 * 需要 `../../worker-core/dist/`。两种情况都试。
 */
async function loadBundle(fileName: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, `../worker-core/dist/${fileName}`),
    resolve(here, `../../worker-core/dist/${fileName}`),
    resolve(here, `../assets/${fileName}`),
    resolve(process.cwd(), `packages/worker-core/dist/${fileName}`),
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      /* 尝试下一个 */
    }
  }
  throw new Error(
    `未找到 ${fileName}，请先执行 npm run build -w @cfpilot/worker-core`
  )
}

/** 轮询部署直到终态 */
async function waitForDeployment(
  client: CloudflareClient,
  accountId: string,
  project: string,
  options: { timeoutMs: number; intervalMs: number },
  log: (m: string) => void
): Promise<PagesDeployment | null> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    let list: PagesDeployment[]
    try {
      list = await client.getPagesDeployments(accountId, project)
    } catch (err) {
      log(`· 查询 ${project} 部署状态失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    const latest = list[0]
    if (!latest) return null
    const status = latest.latest_stage?.status
    if (status === 'success' || status === 'failure' || status === 'canceled') {
      return latest
    }
    if (Date.now() > deadline) {
      log(`· ${project} 部署轮询超时（最后状态：${status}）`)
      return latest
    }
    await new Promise((r) => setTimeout(r, options.intervalMs))
  }
}

/**
 * 执行双项目部署。
 *
 * 设计原则与单 Worker 向导一致：**尽力而为，绝不抛出**。
 * 任何一步失败都记录到 warnings，让用户至少拿到已成功的部分。
 */
export async function deployPagesSplit(
  options: PagesSplitDeployOptions
): Promise<PagesSplitDeployResult> {
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const client = new CloudflareClient({ token: options.token, apiBase: options.apiBase })
  const wait = options.wait ?? { timeoutMs: 90000, intervalMs: 3000 }

  const result: PagesSplitDeployResult = {
    control: { name: options.controlProject, subdomain: '' },
    data: { name: options.dataProject, subdomain: '' },
    warnings,
  }

  const kv = { KV: { namespace_id: options.kvNamespaceId } }

  /* ---------------- 1. 创建两个 Pages 项目 ---------------- */
  for (const [label, name] of [
    ['控制面', options.controlProject],
    ['数据面', options.dataProject],
  ] as const) {
    try {
      const project = await client.createPagesProject(options.accountId, {
        name,
        productionBranch: 'main',
      })
      log(`✅ 已创建${label}项目 ${name}（${project.subdomain}）`)
      if (label === '控制面') result.control.subdomain = project.subdomain
      else result.data.subdomain = project.subdomain
    } catch (err) {
      // 「项目已存在」的错误码不固定（实测返回的是无 code 的 800 型错误），
      // 因此按消息内容判断，覆盖原地更新场景。
      const message = err instanceof Error ? err.message : String(err)
      const alreadyExists = /already exists/i.test(message)
      if (alreadyExists) {
        try {
          const project = await client.getPagesProject(options.accountId, name)
          log(`· ${label}项目 ${name} 已存在，复用它（${project.subdomain}）`)
          if (label === '控制面') result.control.subdomain = project.subdomain
          else result.data.subdomain = project.subdomain
        } catch {
          warnings.push(`无法读取已存在的${label}项目 ${name}`)
        }
      } else {
        warnings.push(
          `创建${label}项目 ${name} 失败：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  /* ---------------- 2. 配置环境变量与 KV（必须在部署前） ---------------- */

  // KV 已有配置时，环境变量不生效（优先级 KV > 环境变量）。
  // 这会让用户拿到「新生成的路径/密码却登不进去」，必须提前告知。
  const kvConflict = await detectKvConfigConflict(client, options.accountId, options.kvNamespaceId, log)

  if (result.control.subdomain) {
    try {
      await client.updatePagesDeploymentConfig(options.accountId, options.controlProject, {
        kv_namespaces: kv,
        env_vars: {
          PANEL_PATH: { value: options.panelPath },
          PANEL_PASSWORD: { value: options.panelPassword },
          // 拆分部署：控制面用 DATA_HOST 指定节点域名
          DATA_HOST: { value: result.data.subdomain },
          ...(options.scannerToken ? { SCANNER_TOKEN: { value: options.scannerToken } } : {}),
        },
      })
      log('✅ 控制面已配置 KV 与环境变量')
    } catch (err) {
      warnings.push(
        `控制面配置失败：${err instanceof Error ? err.message : String(err)}（会导致部署后变量不生效）`
      )
    }
  }

  if (result.data.subdomain) {
    try {
      await client.updatePagesDeploymentConfig(options.accountId, options.dataProject, {
        kv_namespaces: kv,
        env_vars: {
          UUID: { value: options.uuid },
          TROJAN: { value: options.enableTrojan ? 'true' : 'false' },
          TROJAN_PASSWORD: { value: options.trojanPassword },
          PATH: { value: options.wsPath },
          XHTTP: { value: options.enableXhttp ? 'true' : 'false' },
        },
      })
      log('✅ 数据面已配置 KV 与环境变量')
    } catch (err) {
      warnings.push(
        `数据面配置失败：${err instanceof Error ? err.message : String(err)}（会导致部署后变量不生效）`
      )
    }
  }

  /* ---------------- 3. 部署（先数据面，控制面的 DATA_HOST 才有效） ---------------- */
  let dataCode = options.bundles?.data ?? ''
  let controlCode = options.bundles?.control ?? ''
  if (!dataCode) {
    try {
      dataCode = await loadBundle('dataplane.js')
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (!controlCode) {
    try {
      controlCode = await loadBundle('control.js')
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (dataCode && result.data.subdomain) {
    try {
      const deployment = await client.deployPagesWorker(options.accountId, options.dataProject, {
        code: dataCode,
      })
      result.data.deploymentId = deployment.id
      log(`✅ 数据面已触发部署：${deployment.id}`)
      const final = await waitForDeployment(client, options.accountId, options.dataProject, wait, log)
      if (final?.latest_stage?.status === 'success') {
        log('✅ 数据面部署完成')
      } else {
        warnings.push(`数据面部署未确认成功（状态：${final?.latest_stage?.status ?? '未知'}）`)
      }
    } catch (err) {
      warnings.push(
        `数据面部署失败：${err instanceof Error ? err.message : String(err)}` +
          '（若错误含 8000119，说明项目已被平台标记，需联系 abusereply@cloudflare.com）'
      )
    }
  }

  if (controlCode && result.control.subdomain) {
    try {
      const deployment = await client.deployPagesWorker(options.accountId, options.controlProject, {
        code: controlCode,
      })
      result.control.deploymentId = deployment.id
      log(`✅ 控制面已触发部署：${deployment.id}`)
      const final = await waitForDeployment(client, options.accountId, options.controlProject, wait, log)
      if (final?.latest_stage?.status === 'success') {
        log('✅ 控制面部署完成')
      } else {
        warnings.push(`控制面部署未确认成功（状态：${final?.latest_stage?.status ?? '未知'}）`)
      }
    } catch (err) {
      warnings.push(
        `控制面部署失败：${err instanceof Error ? err.message : String(err)}` +
          '（若错误含 8000119，说明项目已被平台标记，需联系 abusereply@cloudflare.com）'
      )
    }
  }

  return result
}
