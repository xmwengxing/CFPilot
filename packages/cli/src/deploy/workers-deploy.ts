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
 * 决定订阅里的**节点域名**。
 *
 * 用户填了就用它（工具只把它写进 DATA_HOST，不绑定），否则退回 workers.dev。
 */
export function resolveNodeHost(dataHost: string | undefined, devHost: string): string {
  const host = (dataHost ?? '').trim()
  return host || devHost
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
  /**
   * 节点域名（用户自定义域名）。
   *
   * ⚠️ 工具**不会**去绑定它，只把它作为订阅里的节点地址写进控制面 `DATA_HOST`，
   * 并提示用户到 Worker 的「域」标签页添加。
   */
  dataHost?: string
  /**
   * 控制面项目名（用于校验节点域名没有串号 —— 控制面的域名不能当节点域名用）。
   */
  controlProject?: string
  bindings: ScriptBinding[]
  log: (message: string) => void
  warnings: string[]
}

export interface WorkersDataPlaneResult {
  /** 实际生效的脚本名 */
  name: string
  /** 订阅里要用的节点域名（用户填的自定义域名，或 workers.dev 兜底） */
  host: string
  /** Worker 自身的生产域名（`<name>.<sub>.workers.dev`），仅用于提示 */
  devHost: string
}

/**
 * 检查填写的节点域名是否"串号"。
 *
 * 拦：控制面的自定义域名、账号里别的 Worker 的域名。
 * 放行：还没绑定的域名（首次部署后用户自己去控制台绑的正常流程）。
 *
 * 返回空串表示没问题；否则返回一段可直接展示给用户的原因。
 */
async function findNodeHostClash(
  client: CloudflareClient,
  accountId: string,
  controlProject: string,
  dataPlaneName: string,
  host: string
): Promise<string> {
  const target = host.trim().toLowerCase()
  if (!target) return ''
  // 0) 与数据面**已绑定**的域名必须一致（这条正好拦下真机事故）。
  //
  // 真机事故里：数据面早就绑了 data.shijingtian.dpdns.org，
  // 而输入框里残留的是另一个域名 → 写进 DATA_HOST → 节点全部 -1。
  // 数据面还没绑过任何域名时放行（首次部署的正常流程）。
  try {
    const domains = await client.listWorkerDomains(accountId)
    const bound = domains.find((dm) => dm.service === dataPlaneName && dm.hostname)?.hostname
    if (bound && bound.trim().toLowerCase() !== target) {
      return (
        `节点域名填的是 ${host}，但数据面 Worker 已绑定的自定义域名是 ${bound} —— 两者必须一致\n` +
        '  → 填错的域名会被写进控制面 DATA_HOST，订阅节点会全部连不上；\n' +
        '  → 若要换域名，请先到控制台解绑旧的、再绑定新的，然后填新的。'
      )
    }
  } catch {
    /* 读不到就跳过这项检查 */
  }
  try {
    if (controlProject) {
      const project = await client.getPagesProject(accountId, controlProject)
      for (const domain of project.domains ?? []) {
        if (domain.trim().toLowerCase() === target) {
          return `节点域名 ${host} 是**控制面**的域名，不能用作数据面节点域名（控制面不转发代理流量，节点会全部连不上）`
        }
      }
    }
  } catch {
    /* 读不到就跳过这项检查 */
  }
  try {
    const domains = await client.listWorkerDomains(accountId)
    for (const domain of domains) {
      if (domain.service !== dataPlaneName && domain.hostname.trim().toLowerCase() === target) {
        return `节点域名 ${host} 已绑定在账号里的另一个 Worker（${domain.service}）上，不能同时用作数据面节点域名`
      }
    }
  } catch {
    /* 读不到就跳过这项检查 */
  }
  return ''
}

/**
 * 部署 Workers 数据面：上传脚本 → 调整 workers.dev 链接 → 返回节点域名。
 *
 * ## 节点域名从哪来
 *
 * 控制面的 `DATA_HOST` 决定订阅里节点的 sni/host，**必须**是用户能连通的域名。
 * `*.workers.dev` 在很多网络下直连不可访问，所以：
 *
 *   - 用户填了自定义域名 → 用它做节点域名（工具**不绑定**，只提示去「域」标签页添加）；
 *   - 没填 → 用 workers.dev 兜底，并显著告警。
 *
 * ## workers.dev 链接必须关掉（有自定义域名时）
 *
 * 真机事故（2026-11-02）：数据面绑了自定义域名后，
 * workers.dev 的**生产链接与预览链接都要关掉**，否则订阅节点全部 -1。
 * 详见下面注释。
 */
export async function deployWorkersDataPlane(
  options: WorkersDataPlaneOptions
): Promise<WorkersDataPlaneResult> {
  const { client, accountId, name, log, warnings } = options
  const dataHost = (options.dataHost ?? '').trim()

  log(`· 上传 Workers 数据面脚本 ${name}`)
  await client.uploadScript(accountId, name, {
    mainModule: 'worker.js',
    code: options.code,
    compatibilityDate: WORKERS_COMPAT_DATE,
    bindings: options.bindings,
  })

  // workers.dev 的生产与预览链接：有自定义域名时**必须都关掉**。
  //
  // 真机事故（2026-11-02）：数据面绑了自定义域名后，
  // 生产链接与预览链接都开着 → 订阅节点全部 -1。
  //
  // 判定依据有两个（任一成立就关）：
  //   - 用户在部署参数里填了「数据面域名」→ 他的意图就是走自定义域名；
  //   - 这个 Worker 确实绑了自定义域名（读 /workers/domains）。
  //
  // 没绑定自定义域名时反而要开着 —— 否则连一个能用的入口都没有。
  let boundCustom = ''
  try {
    const domains = await client.listWorkerDomains(accountId)
    const hit = domains.find((dm) => dm.service === name && dm.hostname)
    if (hit?.hostname) boundCustom = hit.hostname
  } catch {
    /* 读不到就按「用户填了没填」判断 */
  }

  if (dataHost || boundCustom) {
    try {
      await client.putScriptSubdomain(accountId, name, false, false)
      log('✅ 已关闭 workers.dev 的生产链接与预览链接（节点走自定义域名）')
    } catch (err) {
      warnings.push(
        `关闭 workers.dev 链接失败：${err instanceof Error ? err.message : String(err)}\n` +
          '  → 到控制台 → Workers → 你的脚本 → 设置 → 域和路由，把「生产」与「预览」都关掉，\n' +
          '    否则节点会全部连不上（真机事故 2026-11-02）。'
      )
    }
  } else {
    // 上传成功后 workers.dev 路由默认是关闭的，必须显式开启，
    // 否则 https://<name>.<sub>.workers.dev 一直返回「There is nothing here yet」。
    try {
      await client.putScriptSubdomain(accountId, name, true, false)
    } catch (err) {
      warnings.push(
        `开启 workers.dev 路由失败：${err instanceof Error ? err.message : String(err)}\n` +
          '  → 到控制台 → Workers → 你的脚本 → 设置 → 域和路由 里手动开启即可。'
      )
    }
  }

  let subdomain = ''
  try {
    subdomain = await client.getWorkersSubdomain(accountId)
  } catch {
    /* 读不到就用裸名兜底 */
  }
  const devHost = workersDevHost(name, subdomain)
  // 节点域名：用户填的优先；没填但 Worker 绑了自定义域名 → 用绑定的那个。
  const host = dataHost ? resolveNodeHost(dataHost, devHost) : boundCustom || devHost

  // ⚠️ 防线：填的域名不能是**控制面**或**账号里别的 Worker** 的域名。
  //
  // 真机事故（2026-11-02）：切换账户后「数据面域名」残留了上一个账号的值，
  // 更新部署时写进控制面 DATA_HOST → 订阅节点全部 -1。
  // 部署是写操作，这里加一道服务端校验，避免同类问题复发。
  if (dataHost) {
    const clash = await findNodeHostClash(client, accountId, options.controlProject ?? '', name, dataHost)
    if (clash) {
      throw new Error(
        clash +
          '\n  → 请改成数据面 Worker 自己的域名；确认是否切换过账户导致输入框残留。'
      )
    }
  }

  if (dataHost) {
    warnings.push(
      `控制面的节点域名已设为 ${dataHost}（写入 DATA_HOST）。\n` +
        `  → 工具不会替你绑定域名，请到 Cloudflare 控制台 → Workers 和 Pages → ${name} → 「域」标签页 → 添加自定义域名，填 ${dataHost}\n` +
        '  → 没绑定之前，这个域名的流量到不了 Worker。'
    )
  } else if (boundCustom) {
    warnings.push(
      `控制面的节点域名已设为 ${boundCustom}（数据面已绑定的自定义域名，写入 DATA_HOST）。\n` +
        '  → workers.dev 的生产与预览链接已关闭，节点只走这个自定义域名。'
    )
  } else {
    warnings.push(
      `未填写节点域名，控制面的 DATA_HOST 用的是 ${devHost}。\n` +
        '  → *.workers.dev 域名在很多网络下直连不可访问，节点会连不上；\n' +
        `  → 请到 Workers 和 Pages → ${name} → 「域」标签页添加自定义域名，然后回面板「设置 → 数据面域名」填上它。`
    )
  }

  return { name, host, devHost }
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
