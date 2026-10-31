/**
 * Workers 数据面部署原语（**不含自定义域名托管**）。
 *
 * ## 设计取舍（2026-10-31 重构）
 *
 * 早期版本试图替用户绑定 Worker 自定义域名，结果踩了一串平台限制：
 *
 *   - Pages 绑过自定义域名后，解绑**不会**删掉那条 CNAME；
 *   - Worker 自定义域名要求主机名**没有任何现存记录**，否则 409 / 100117；
 *   - 删记录要 Zone / DNS 写权限，而账号级 Token（`cfat_`）在很多账号下
 *     根本拿不到这一项 —— 真机两个令牌读 DNS 都是 403。
 *
 * 于是「工具替用户绑域名」这条路对相当一部分用户是走不通的。
 *
 * 现在改为：**工具只负责把 Worker 部署到它的生产域名**（`*.workers.dev`），
 * 自定义域名由用户在控制台自行绑定，然后到面板「设置 → 数据面域名」填一次
 * （`CONFIG.subDomain` 优先级高于 `DATA_HOST` 环境变量，订阅会跟着变）。
 *
 * 这样部署路径上不再有任何 DNS / Routes 依赖，也就不存在 100117 这类坑。
 */
import { CloudflareClient, CloudflareError, type ScriptBinding } from './cf-api'

/** 数据面部署形态 */
export type DataPlaneMode = 'pages' | 'workers'

/**
 * Worker 的 compatibility_date。
 *
 * 固定值而不是取当天：产物必须可复现，同一次部署在任意机器上行为一致。
 * 改它等于改运行时语义，必须单独评估（例如 `cloudflare:sockets` 的开关）。
 */
export const WORKERS_COMPAT_DATE = '2026-10-01'

const WORKERS_PERMISSIONS = {
  scripts: {
    label: 'Workers 脚本',
    hint: 'Token 中添加 Account / Workers Scripts / Edit',
  },
} as const

/** 是否是「权限不足」类错误（401 / 403） */
export function isPermissionError(err: unknown): boolean {
  return err instanceof CloudflareError && (err.status === 401 || err.status === 403)
}

/** 把权限错误翻译成「缺哪一项、去哪补」；不是权限错误时返回 null */
export function describeWorkersPermissionError(
  err: unknown,
  which: keyof typeof WORKERS_PERMISSIONS
): string | null {
  if (!isPermissionError(err)) return null
  const perm = WORKERS_PERMISSIONS[which]
  const detail = err instanceof Error ? err.message : String(err)
  return (
    `Token 缺少「${perm.label}」权限（${detail}）。\n` +
    `  → ${perm.hint}\n` +
    '  → Workers 模式比 Pages 模式多这一项权限；不想加就把数据面部署模式改回 Pages。'
  )
}

/**
 * 计算 Worker 的生产域名。
 *
 * 账号没注册 workers.dev 子域时返回 `<name>.workers.dev`（大概率不可用），
 * 调用方据此告警。
 */
export function workersDevHost(name: string, subdomain: string): string {
  const sub = subdomain.trim()
  return sub ? `${name}.${sub}.workers.dev` : `${name}.workers.dev`
}

/**
 * 部署前权限预检（**只读**，不创建任何资源）。
 *
 * 只检查 Workers 脚本权限 —— 因为不再绑自定义域名，Routes / DNS 都不需要。
 */
export async function preflightWorkersDataPlane(
  client: CloudflareClient,
  accountId: string,
  log: (message: string) => void,
  warnings: string[]
): Promise<void> {
  log('· 预检 Workers 数据面所需权限…')

  try {
    const scripts = await client.listScripts(accountId)
    log(`  · Workers 脚本权限正常（账号下 ${Array.isArray(scripts) ? scripts.length : 0} 个脚本）`)
  } catch (err) {
    const message = describeWorkersPermissionError(err, 'scripts')
    if (message) throw new Error(message)
    warnings.push(`无法读取 Workers 脚本列表：${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const subdomain = await client.getWorkersSubdomain(accountId)
    if (subdomain) log(`  · workers.dev 子域：${subdomain}`)
    else {
      warnings.push(
        '该账号还没有 workers.dev 子域。\n' +
          '  → 请到 Cloudflare 控制台 → Workers 和 Pages → 设置一次子域，否则节点域名不可用。'
      )
    }
  } catch {
    // 读不到子域不影响部署，后面按 `<name>.workers.dev` 兜底
  }
}

export interface WorkersDataPlaneOptions {
  client: CloudflareClient
  accountId: string
  /** 脚本名（随机无特征，与 Pages 项目名同规则） */
  name: string
  /** 数据面产物（`dist/dataplane.js`） */
  code: string
  bindings: ScriptBinding[]
  log: (message: string) => void
  warnings: string[]
}

export interface WorkersDataPlaneResult {
  /** 实际生效的脚本名 */
  name: string
  /** 客户端要连的域名（`<name>.<sub>.workers.dev`） */
  host: string
}

/**
 * 部署 Workers 数据面：上传脚本 → 开启 workers.dev 路由 → 返回生产域名。
 *
 * 不做任何域名绑定 —— 自定义域名由用户在控制台配。
 */
export async function deployWorkersDataPlane(
  options: WorkersDataPlaneOptions
): Promise<WorkersDataPlaneResult> {
  const { client, accountId, name, log, warnings } = options

  log(`· 上传 Workers 数据面脚本 ${name}`)
  await client.uploadScript(accountId, name, {
    mainModule: 'worker.js',
    code: options.code,
    compatibilityDate: WORKERS_COMPAT_DATE,
    bindings: options.bindings,
  })

  // 上传成功后 workers.dev 路由默认是关闭的，必须显式开启，
  // 否则 https://<name>.<sub>.workers.dev 一直返回「There is nothing here yet」。
  try {
    await client.putScriptSubdomain(accountId, name, true)
  } catch (err) {
    warnings.push(
      `开启 workers.dev 路由失败：${err instanceof Error ? err.message : String(err)}\n` +
        '  → 到控制台 → Workers → 你的脚本 → 设置 → 域和路由 里手动开启即可。'
    )
  }

  let subdomain = ''
  try {
    subdomain = await client.getWorkersSubdomain(accountId)
  } catch {
    /* 读不到就用裸名兜底 */
  }
  const host = workersDevHost(name, subdomain)

  warnings.push(
    `数据面已部署到 ${host}。\n` +
      '  → *.workers.dev 域名在很多网络下直连不可访问，**需要**配一个自定义域名：\n' +
      `     Cloudflare 控制台 → Workers 和 Pages → ${name} → 设置 → 域和路由 → 添加 → 自定义域名\n` +
      '  → 配好后到面板「设置 → 数据面域名」填上它（优先级高于部署时写入的 DATA_HOST），订阅会跟着切过去。'
  )

  return { name, host }
}

/** 删除 Workers 数据面（脚本一删，它上面的自定义域名绑定也随之释放） */
export async function deleteWorkersDataPlane(
  client: CloudflareClient,
  accountId: string,
  name: string,
  log: (message: string) => void
): Promise<void> {
  await client.deleteScript(accountId, name)
  log(`✅ 已删除旧 Workers 数据面：${name}`)
}
