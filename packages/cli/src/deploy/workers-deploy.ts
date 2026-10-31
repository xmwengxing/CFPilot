/**
 * Workers 数据面部署原语。
 *
 * ## 为什么数据面允许跑 Workers
 *
 * 2026-10-31 真机验证通过（面板 / 订阅 / 探针 / 真实 VLESS 5/5，见
 * `docs/workers-dataplane-deploy.md`）。历史「Workers 上必然 522」的结论
 * 只对当时的产物成立（含第三方 vendor 与动态 sockets 导入），当前产物未复现。
 *
 * ## 与控制面的关系
 *
 * **控制面永远留在 Pages**：面板 + 订阅 + 探针不含出站 TCP，Pages 上稳定；
 * 只有数据面（代理入站 + 出站拨号）才允许换成 Workers。
 *
 * ## 三条硬约束（代码里都做了兜底）
 *
 * 1. `*.workers.dev` 生产域名会被阻断 → 节点域名必须用**自定义域名**；
 *    没提供域名时仍可部署，但会告警，并把 `workers.dev` 域名写进订阅。
 * 2. 自定义域名必须属于**本账号的 zone**，否则 `PUT /workers/domains` 直接失败。
 * 3. 绑定的返回值只代表「已受理」，可达性必须再校验一次（见 `probeHost`）。
 */
import { CloudflareClient, type ScriptBinding, type WorkerDomain } from './cf-api'

/** 数据面部署形态 */
export type DataPlaneMode = 'pages' | 'workers'

/**
 * Worker 的 compatibility_date。
 *
 * 固定值而不是取当天：产物必须可复现，且同一次部署在任意机器上行为一致。
 * 改它等于改运行时语义，必须单独评估（例如 `cloudflare:sockets` 的开关）。
 */
export const WORKERS_COMPAT_DATE = '2026-10-01'

export interface WorkersDataPlaneOptions {
  client: CloudflareClient
  accountId: string
  /** 脚本名（随机无特征，与 Pages 项目名同规则） */
  name: string
  /** 数据面产物（`dist/dataplane.js`） */
  code: string
  /** 自定义域名（如 `w1a2b3c4.example.com`）；留空则回落到 workers.dev */
  hostname?: string
  bindings: ScriptBinding[]
  log: (message: string) => void
  warnings: string[]
}

export interface WorkersDataPlaneResult {
  /** 实际生效的脚本名 */
  name: string
  /** 客户端要连的域名（自定义域名，或 workers.dev 回落） */
  host: string
  /** 自定义域名（没绑则为空串） */
  customDomain: string
}

/**
 * 找出 `hostname` 归属的 zone（最长后缀匹配）。
 *
 * 为什么不能只按 `?name=` 精确查：`/zones?name=` 只认 zone 的**顶点域名**，
 * 传 `w1.example.com` 会返回空数组，于是「账号里明明有这个域名」也会被误判成没有。
 */
export async function resolveZoneForHost(
  client: CloudflareClient,
  hostname: string
): Promise<{ id: string; name: string } | null> {
  const zones = await client.listZones()
  const host = hostname.trim().toLowerCase()
  if (!host) return null
  const matches = zones
    .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
    // 最长后缀优先：a.b.example.com 同时匹配 example.com 与 b.example.com
    .sort((a, b) => b.name.length - a.name.length)
  const zone = matches[0]
  return zone ? { id: zone.id, name: zone.name } : null
}

/** 找出某个 Worker 脚本已绑定的自定义域名（多个时取第一个） */
export async function findWorkerDomain(
  client: CloudflareClient,
  accountId: string,
  scriptName: string
): Promise<WorkerDomain | null> {
  const domains = await client.listWorkerDomains(accountId)
  return domains.find((d) => d.service === scriptName) ?? null
}

/** 上传脚本（幂等：同名覆盖即为更新） */
export async function uploadWorkerScript(options: WorkersDataPlaneOptions): Promise<void> {
  await options.client.uploadScript(options.accountId, options.name, {
    mainModule: 'worker.js',
    code: options.code,
    compatibilityDate: WORKERS_COMPAT_DATE,
    bindings: options.bindings,
  })
}

/**
 * 绑定自定义域名。
 *
 * ⚠️ 返回 200 只代表「绑定已受理」。真机上证书签发要 1~3 分钟，
 * 期间访问会 TLS 失败 —— 调用方必须用 `probeHost` 再确认一次。
 */
export async function attachWorkerHostname(
  client: CloudflareClient,
  accountId: string,
  hostname: string,
  scriptName: string
): Promise<WorkerDomain> {
  const zone = await resolveZoneForHost(client, hostname)
  if (!zone) {
    throw new Error(
      `域名 ${hostname} 不在本账号的任何 zone 下，无法绑定为 Worker 自定义域名。\n` +
        '  → 请确认该域名的 DNS 托管在这个 Cloudflare 账号里（Workers 自定义域名不支持外部 CNAME）。'
    )
  }
  return await client.attachCustomDomain(accountId, {
    hostname,
    service: scriptName,
    zoneId: zone.id,
  })
}

/** 解除某个脚本上的自定义域名绑定 */
export async function detachWorkerHostname(
  client: CloudflareClient,
  accountId: string,
  scriptName: string
): Promise<string> {
  const domain = await findWorkerDomain(client, accountId, scriptName)
  if (!domain) return ''
  try {
    await client.deleteWorkerDomain(accountId, domain.id)
    return domain.hostname
  } catch {
    return ''
  }
}

/**
 * 轮询确认域名真的能访问（拿到任意 HTTP 响应即算通）。
 *
 * 只用 HEAD/GET 探一次不够 —— 证书签发期间 TLS 直接失败。
 * 失败**不阻断部署**：域名生效有延迟，用户稍后自己会看到；
 * 但必须告警，否则用户拿着一个连不上的节点排查半天。
 */
export async function probeHost(
  host: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  const interval = options.intervalMs ?? 5_000
  for (;;) {
    try {
      await fetch(`https://${host}/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      return true
    } catch {
      /* 证书未就绪 / DNS 未生效，继续等 */
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, interval))
  }
}

/**
 * 部署 Workers 数据面：上传 → 绑域名（或开 workers.dev）→ 校验可达。
 *
 * 失败会抛错，由调用方决定是否回滚 —— 这里**不吞异常**：
 * 数据面部署失败等于用户拿不到可用节点，必须让上层知道。
 */
export async function deployWorkersDataPlane(
  options: WorkersDataPlaneOptions
): Promise<WorkersDataPlaneResult> {
  const { client, accountId, name, hostname, log, warnings } = options

  log(`· 上传 Workers 数据面脚本 ${name}`)
  await uploadWorkerScript(options)

  let host = ''
  let customDomain = ''

  if (hostname) {
    const domain = await attachWorkerHostname(client, accountId, hostname, name)
    customDomain = domain.hostname
    host = domain.hostname
    log(`✅ 已绑定自定义域名 ${host}`)
    const reachable = await probeHost(host)
    if (!reachable) {
      warnings.push(
        `自定义域名 ${host} 在 90 秒内仍未返回响应（证书签发通常需要 1~3 分钟）。\n` +
          '  → 稍等片刻用浏览器打开该域名确认；若长时间不可用，请到 Cloudflare 控制台检查\n' +
          '    Workers → 你的脚本 → 设置 → 域和路由 里的自定义域名状态。'
      )
    }
  } else {
    // 没有自定义域名 → 回落到 workers.dev（能部署，但多数网络下直连不可用）
    await client.putScriptSubdomain(accountId, name, true)
    const subdomain = await client.getWorkersSubdomain(accountId)
    host = subdomain ? `${name}.${subdomain}.workers.dev` : `${name}.workers.dev`
    warnings.push(
      `未配置自定义域名，数据面使用 ${host}。\n` +
        '  → *.workers.dev 域名直连无法访问，请登录 cloudflare 控制台配置自定义域名，\n' +
        '    否则客户端节点会全部连不上。'
    )
  }

  return { name, host, customDomain }
}

/** 删除 Workers 数据面（先解绑域名，再删脚本） */
export async function deleteWorkersDataPlane(
  client: CloudflareClient,
  accountId: string,
  name: string,
  log: (message: string) => void
): Promise<void> {
  const host = await detachWorkerHostname(client, accountId, name)
  if (host) log(`· 已解绑旧数据面域名 ${host}`)
  await client.deleteScript(accountId, name)
  log(`✅ 已删除旧 Workers 数据面：${name}`)
}
