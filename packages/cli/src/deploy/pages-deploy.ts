/**
 * Pages 双项目部署（控制面 + 数据面）
 *
 * ## 背景
 *
 * 真机复现：合并包部署到 Pages，第一次成功、第二次
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
 *   │ 无 sockets   │      │ 数据面 │
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
import { randomBytes, randomUUID } from 'node:crypto'
import { CloudflareClient, CloudflareError, type PagesDeployment } from './cf-api'
import { randomPanelPath, randomPassword, randomWorkerName, randomWsPath } from './utils'
import { extractBuildVersion, loadKernelBundle } from './kernel-remote'
import { compareSemver } from '../shared/version-util'
import { VERSION } from '../shared/version'

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
  /**
   * 部署模式。
   *   - 'auto'      ：读 KV 清单自动判断（有清单=更新，无清单=首次）
   *   - 'fresh'     ：强制首次部署，忽略清单
   *   - 'update'    ：强制更新部署，沿用 KV 里的 UUID / 路径 / 密码
   */
  mode?: 'auto' | 'fresh' | 'update'
  /**
   * 更新部署时是否沿用已有凭据（UUID / WS 路径 / Trojan 密码 / 面板密码）。
   * 默认 true —— 否则用户每次更新都要在客户端改一遍订阅地址。
   */
  keepCredentials?: boolean
  /**
   * 出站前是否自动 DoH 解析优选 IP（注入 `RESOLVE_PREFERRED`）。
   *
   * 默认 true（内核侧也是 true）。设为 false 可关闭自动解析，
   * 只用手工配置的优选 IP —— 适合不希望产生额外 DoH 请求的场景。
   */
  resolvePreferred?: boolean
  /**
   * 线上版本与本地一致时跳过部署。
   * 默认 true。传 false 可强制重新部署。
   */
  skipSameVersion?: boolean
  /**
   * 明知会覆盖他人 KV 仍然继续。
   *
   * 默认 false。归属校验失败时（该 KV 属于另一个 CFPilot 实例，
   * 或疑似旧版第三方 项目）会中止部署；只有显式传 true 才继续。
   */
  force?: boolean
  /** 本地产物的构建版本（用于版本比对；不传则不做版本跳过） */
  localBuild?: string
  /** 部署完成后的等待与轮询配置 */
  wait?: { timeoutMs: number; intervalMs: number }
  /** 覆盖 API 地址（测试用；生产环境不要传） */
  apiBase?: string
  /**
   * 覆盖内核产物内容（测试用；生产环境不传，从 dist/ 读取）。
   * 键为 control / data，值为对应 JS 源码。
   */
  bundles?: { control?: string; data?: string }
  /**
   * 本次部署所用的**内核版本**（semver）。
   *
   * 不传则由内核解析自动得出（远程内核取 Release 版本号，
   * 内置内核取应用版本）。只在调用方**自己提供**产物时需要显式指定。
   */
  kernelVersion?: string
  log?: (message: string) => void
}

export interface PagesSplitDeployResult {
  control: { name: string; subdomain: string; deploymentId?: string }
  data: { name: string; subdomain: string; deploymentId?: string }
  /** 实际生效的面板路径（更新模式下可能来自清单） */
  panelPath?: string
  /** 实际生效的 UUID */
  uuid?: string
  /** 实际生效的 WS 路径 */
  wsPath?: string
  /**
   * 实际生效的控制面面板密码。
   *
   * 首次部署时是随机生成的，不返回给调用方就只能自己去 KV 里翻 ——
   * GUI 曾因此部署成功后不显示密码。
   */
  panelPassword?: string
  warnings: string[]
}

/**
 * KV 里的部署清单键。
 *
 * 记录本项目上次部署用的是哪些 Pages 项目、什么配置。
 * 更新部署时先读它，就能知道「同源项目」是哪两个，
 * 不需要用户记项目名，也不需要去猜。
 *
 * ⚠️ 一个 KV 命名空间 = 一个部署实例。清单是**单键**，
 * 因此同一个 KV 不能承载两个实例（见 assertKvOwnership）。
 */
export const MANIFEST_KEY = 'CFP_DEPLOY_MANIFEST'

export interface DeployManifest {
  /** 清单格式版本 */
  v: 1
  /** 部署该实例所用的 KV 命名空间 ID（自描述，便于排查） */
  kvNamespaceId?: string
  /** 控制面 Pages 项目名 */
  controlProject: string
  /** 数据面 Pages 项目名（可能因 8000119 换过名） */
  dataProject: string
  /** 控制面域名 */
  controlSubdomain: string
  /** 数据面域名 */
  dataSubdomain: string
  /**
   * 绑定在数据面上的**自定义域名**（如 `cfpilot.example.com`）。
   *
   * 为什么必须记：8000119 换名重建后项目名和 `*.pages.dev` 都会变，
   * 但自定义域名是用户资产、不会跟着变 —— 记下来才能在换名后
   * 自动把它迁到新项目（否则用户订阅里的地址全部失效）。
   */
  dataCustomDomain?: string
  /** 上次部署的构建版本 */
  build: string
  /**
   * 本次部署所用的内核版本（semver）；旧清单没有这个字段 = 未知。
   *
   * ## 为什么 build 指纹不够用
   *
   * build 指纹形如 `a946dfa-1f2e3d4c`（git 短 hash + 源码哈希），
   * 它是**精确**的，但**没有大小顺序** ——
   * 「线上 build ≠ 本地 build」只能说明「不一样」，
   * 说不清「谁更新」。
   *
   * semver 自带大小顺序，因此清单里要**同时**记两份：
   *   - build        → 判断「是不是同一份产物」
   *   - kernelVersion → 判断「谁更新」
   *
   * ⚠️ 读不到就写空串（语义 = 未知），**绝不写 "unknown"** ——
   * 假值会让「检查状态」显示「线上内核 unknown ≠ 本地 xxx」，用户看不懂。
   */
  kernelVersion?: string
  /** 上次部署时间（ISO） */
  at: string
  /** 创建时生成的凭据（更新时沿用，避免客户端订阅地址失效） */
  credentials: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
}

/**
 * 读取部署清单；不存在返回 null。
 *
 * 导出供 CLI / GUI 复用：靠它可以列出账号下有哪些 CFPilot 实例。
 */
export async function readManifest(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string
): Promise<DeployManifest | null> {
  try {
    const raw = await client.getKvValue(accountId, namespaceId, MANIFEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DeployManifest
    return parsed && parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

/**
 * 列出账号下所有「由 CFPilot 部署」的 KV 命名空间。
 *
 * 用于「一个账号跑多个 CFPilot 实例」的场景：每个实例一个 KV，
 * 靠清单键识别归属，而不是靠命名空间标题猜测。
 */
export async function listCfPilotNamespaces(
  client: CloudflareClient,
  accountId: string
): Promise<Array<{ id: string; title: string; manifest: DeployManifest }>> {
  const namespaces = await client.listKvNamespaces(accountId)
  const out: Array<{ id: string; title: string; manifest: DeployManifest }> = []
  for (const ns of namespaces) {
    const manifest = await readManifest(client, accountId, ns.id)
    if (manifest) out.push({ id: ns.id, title: ns.title, manifest })
  }
  return out
}

/** 写入部署清单 */
async function writeManifest(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  manifest: DeployManifest
): Promise<void> {
  try {
    await client.setKvValue(accountId, namespaceId, MANIFEST_KEY, JSON.stringify(manifest))
  } catch {
    /* 清单写失败不影响部署本身，只影响下次更新识别 */
  }
}

/**
 * KV 命名空间的归属判定结果。
 *
 * - `empty`　　完全空的命名空间，可用
 * - `owned`　　含清单且属于目标实例 → 可原地更新
 * - `occupied` 含清单但属于**另一个**实例 → 越界，必须拒绝
 * - `foreign`　含其他项目的 `config` 键 → 已被占用，**必须拒绝**
 * - `stale`　含 CFPilot 的 `CONFIG` 键但没有清单 → 残留配置
 *
 * ## ⚠️ `foreign` 为什么从「只提醒」改成「阻断」
 *
 * CFPilot 早已是**纯自研数据面**（vendor 于 完全移除）。
 * 继续往已被其他项目使用的 KV 里部署会带来三个问题：
 *
 *   1. **共享配额**：对方的用量与本实例互相挤占，两边都可能被限流；
 *   2. **语义污染**：旧版原版会按它自己的 schema 读写部分键，
 *      与本实例的大写 `CONFIG` 并存会让排查变得极其困难；
 *   3. **用户预期**：旧提示是「可以共存」，用户会以为安全，
 *      实际两个项目在同一命名空间上互相影响。
 *
 * 因此现在**一律阻断**，要求为 CFPilot 单独建 KV。
 * 这与「纯自研、不与任何第三方共用命名空间」的项目定位一致。
 */
export type KvOwnership = 'empty' | 'owned' | 'occupied' | 'foreign' | 'stale'

export interface KvOwnershipInfo {
  verdict: KvOwnership
  /** 占用者的清单（occupied / owned 时有值） */
  manifest: DeployManifest | null
  /** 判定依据的人话描述 */
  detail: string
  /** 是否会阻断部署 */
  blocking: boolean
}

/**
 * 探测 KV 命名空间的归属。
 *
 * ## 为什么必须探测而不是靠字段值猜
 *
 * KV 里的键是**全局平铺**的，没有实例前缀。判断「这个 KV 属于谁」
 * 唯一可靠依据是**清单键**（由 CFPilot 自己写入）。
 * 标题、UUID、路径等字段值都不具备唯一性，不能作为归属依据。
 *
 * @param controlProject 本次要部署的控制面项目名；用于判断清单是否属于本次目标
 */
export async function inspectKvOwnership(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  controlProject: string
): Promise<KvOwnershipInfo> {
  const manifest = await readManifest(client, accountId, namespaceId)
  if (manifest) {
    if (manifest.controlProject === controlProject) {
      return {
        verdict: 'owned',
        manifest,
        detail: `已由 CFPilot 部署（控制面 ${manifest.controlProject} / 数据面 ${manifest.dataProject}）`,
        blocking: false,
      }
    }
    return {
      verdict: 'occupied',
      manifest,
      detail: `已被另一个 CFPilot 实例占用（控制面 ${manifest.controlProject} / 数据面 ${manifest.dataProject}，部署于 ${manifest.at}）`,
      blocking: true,
    }
  }

  // 没有清单：看有没有别的产品留下的痕迹
  const legacyConfig = await client.getKvValue(accountId, namespaceId, 'config')
  if (legacyConfig !== null) {
    return {
      verdict: 'foreign',
      manifest: null,
      detail: '含其他项目的 config 键，该命名空间正被别的项目使用',
      // ⚠️ 阻断：
      // CFPilot 已是纯自研数据面，不再与其他项目共存于同一 KV。
      // 理由见上方 KvOwnership 的注释（配额共享 / 语义污染 / 用户预期）。
      blocking: true,
    }
  }
  const cfpilotConfig = await client.getKvValue(accountId, namespaceId, 'CONFIG')
  if (cfpilotConfig !== null) {
    return {
      verdict: 'stale',
      manifest: null,
      detail: '含 CFPilot 的 CONFIG 键但没有部署清单（残留配置，可能是清单被删或手工写入）',
      blocking: true,
    }
  }
  return { verdict: 'empty', manifest: null, detail: '空命名空间', blocking: false }
}

/**
 * 部署前的归属校验：**越界写入一律中止**。
 *
 * ## 为什么不能只警告
 *
 * CFPilot 的内核读取 KV 里的全局键（`CONFIG` / `PANEL_PATH` / `SESSION:*` …）。
 * 往不属于自己的命名空间里写这些键，等于**直接改坏别人的线上项目**：
 * 别人的订阅会指向错误的 UUID、面板路径与密码会被覆盖、会话可跨实例复用。
 * 这类损失事后极难清理，必须在写入前拦住。
 *
 * @param force 明确知晓后果仍然继续（仅对 `occupied` / `stale` 生效）
 */
export async function assertKvOwnership(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  options: {
    controlProject: string
    mode: 'auto' | 'fresh' | 'update'
    force?: boolean
    log?: (m: string) => void
  }
): Promise<KvOwnershipInfo> {
  const log = options.log ?? (() => {})
  const info = await inspectKvOwnership(client, accountId, namespaceId, options.controlProject)

  if (info.verdict === 'owned') {
    log(`· KV 归属校验通过：${info.detail}`)
    return info
  }

  if (info.verdict === 'foreign') {
    // ⚠️ 阻断：CFPilot 是纯自研数据面，不与其他项目共用 KV。
    // 即使加 --force / 勾选「强制」也**不允许**继续 —— 这是硬约束，
    // 因为共存会让两个项目在同一命名空间上互相影响（配额、schema、排查难度），
    // 而用户往往意识不到。要部署就换一个干净的 KV。
    throw new Error(
      `该 KV 命名空间${info.detail}。\n` +
        '  CFPilot 的数据面已完全自研，不再与其他项目共用同一命名空间。\n' +
        '  → 请为 CFPilot 新建一个独立的 KV（GUI：重新部署时会自动建；CLI：--new-kv）。\n' +
        '  → 此判定不可用「强制」绕过。'
    )
  }

  if (info.verdict === 'empty') {
    log(`· KV 归属校验通过：${info.detail}`)
    return info
  }

  const message =
    info.verdict === 'occupied'
      ? `该 KV 命名空间已被另一个 CFPilot 实例占用：${info.detail}。\n` +
        '  一个 KV 命名空间只能承载一个 CFPilot 部署实例（内核的 KV 键全局平铺，无实例前缀）。\n' +
        '  → 请改用其他 KV 命名空间（GUI：全新部署会自动建；CLI：--new-kv）。'
      : `该 KV 命名空间${info.detail}。\n` +
        '  → 继续部署会覆盖其中的既有配置。\n' +
        '  → 如需本次部署独占，请用独立 KV（GUI：全新部署会自动建；CLI：--new-kv）。'

  if (!options.force) {
    throw new Error(message)
  }
  log(`⚠ ${message}\n  ⚠ 已指定强制覆盖，继续执行——原实例的配置将被本次部署改写。`)
  return info
}

/**
 * 把本次部署的凭据写入 KV 的 **大写 `CONFIG` 键**。
 *
 * ## 为什么写 `CONFIG` 而不是小写 `config`
 *
 * 数据面产物 `dist/dataplane.js` 由 `src/entry-data.ts` 构建，
 * 它通过 CFPilot 自己的 `loadConfig()` 读取 **大写 `CONFIG` 键**（UserConfig schema），
 * 并在首次加载时把合并结果回写到同一个键。
 * 控制面读的是同一个键 —— 两端共享同一份配置，
 * 订阅里的 UUID / WS 路径因此必然与数据面实际接受的一致。
 *
 * 旧版的小写 `config` 键（旧版 schema）**只被 旧版原版读取**，
 * CFPilot 的数据面不读它。往那个键里写不仅无效，
 * 还会**整体覆盖**共存项目的配置（旧实现是 `Object.assign` 整体覆盖），
 * 因此这里**绝不写**小写 `config` 键。
 *
 * 保留用户已在面板里改过的设置（优选池、代理池、订阅域名等），
 * 只覆盖本次部署的凭据类字段。
 */
async function writeEffectiveConfig(
  client: CloudflareClient,
  accountId: string,
  namespaceId: string,
  effective: {
    uuid: string
    trojanPassword: string
    wsPath: string
  },
  options: { enableTrojan: boolean; enableXhttp: boolean },
  warnings: string[],
  log: (m: string) => void
): Promise<void> {
  // 读旧值，保留用户手动配置的字段（优选池 / 代理池 / 订阅域名等）
  let existing: Record<string, unknown> = {}
  try {
    const raw = await client.getKvValue(accountId, namespaceId, 'CONFIG')
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      }
    }
  } catch {
    /* 旧值解析失败时按空处理，下面会写全凭据字段 */
  }

  const merged: Record<string, unknown> = {
    ...existing,
    uuid: effective.uuid,
    trojanPassword: effective.trojanPassword,
    wsPath: effective.wsPath,
    enableTrojan: options.enableTrojan,
    enableXhttp: options.enableXhttp,
  }

  try {
    await client.setKvValue(accountId, namespaceId, 'CONFIG', JSON.stringify(merged))
    log(`✅ 部署凭据已写入 KV（uuid / WS 路径 / Trojan 密码已生效）`)
  } catch (err) {
    warnings.push(
      `KV 凭据写入失败：${err instanceof Error ? err.message : String(err)}` +
        '\n  内核会回退到环境变量（UUID / WS 路径 / Trojan 密码来自部署时注入的 env），' +
        '但订阅与面板的配置保存会失效（面板保存依赖 KV）。' +
        '\n  → 通常是网络瞬时故障，重新执行一次同一条部署命令即可（凭据会沿用，不会变）。' +
        '\n  → 若反复失败，请检查网络能否直连 api.cloudflare.com（代理 / VPN 可能中断长连接）。'
    )
  }
}

/**
 * 部署实际要用的内核。
 *
 * ## 优先级
 *
 *   1. `options.bundles` —— 调用方**显式指定**的产物，优先级最高，不覆盖
 *   2. **远程**内核 —— Release 上有比当前应用更新的内核时用远程的
 *   3. **内置**内核 —— 远程查不到 / 下载失败时回退
 *
 * ## 为什么远程优先
 *
 * 内核产物原先内置在 npm 包里，**部署用的代码被应用版本绑死**：
 * 用户没升级 npm 包，就只能部署旧内核。
 * 改成从 Release 拉取后，应用版本与内核版本解耦。
 *
 * @param options 部署选项
 * @param log 日志回调
 * @param warnings 告警收集（产物缺失时往里塞）
 */
async function resolveKernel(
  options: PagesSplitDeployOptions,
  log: (message: string) => void,
  warnings: string[]
): Promise<{ control: string; data: string; version: string; build: string; source: string }> {
  // ---- 1. 调用方显式指定（测试 / 嵌入场景）----
  const explicitControl = options.bundles?.control ?? ''
  const explicitData = options.bundles?.data ?? ''
  if (explicitControl && explicitData) {
    return {
      control: explicitControl,
      data: explicitData,
      version: options.kernelVersion ?? '',
      build: extractBuildVersion(explicitControl),
      source: '调用方指定',
    }
  }

  // ---- 2. 远程优先，内置兜底 ----
  try {
    const bundle = await loadKernelBundle(VERSION, { log })
    log(`· 内核来源：${bundle.source}`)
    const control = explicitControl || bundle.control
    const data = explicitData || bundle.data
    return {
      control,
      data,
      version: options.kernelVersion ?? bundle.version,
      build: extractBuildVersion(control),
      source: bundle.source,
    }
  } catch (err) {
    // 内置产物也读不到 —— 部署无法继续，但**不抛错**，
    // 由 deployWithBlockRetry 报「产物为空，跳过部署」。
    warnings.push(
      `内核产物加载失败：${err instanceof Error ? err.message : String(err)}`
    )
    return {
      control: explicitControl,
      data: explicitData,
      version: options.kernelVersion ?? '',
      build: extractBuildVersion(explicitControl),
      source: '不可用',
    }
  }
}

/**
 * 校验部署参数。
 *
 * 重点是路径类参数：MSYS / Git-Bash 会把以 `/` 开头的命令行参数
 * 转换成 Windows 路径（例如 `--panel-path /p-abc` 变成
 * `C:/Users/.../bash-win32-x64/p-abc`）。这种值一旦写进 Pages 环境变量，
 * 面板路径就永久错乱且难以排查。因此这里显式拒绝。
 */
function validateOptions(options: PagesSplitDeployOptions): string[] {
  const problems: string[] = []

  const checkPath = (label: string, value: string): void => {
    if (!value) return
    // 合法路径：单个前导斜杠 + 小写字母数字连字符，不含空格与冒号
    if (!/^\/[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
      problems.push(
        `${label} 含非法字符：${JSON.stringify(value)}。` +
          '若在 Git-Bash / MSYS 下传参，/ 开头的参数会被转换成 Windows 路径，' +
          '请改用 --panel-path=p-abc 形式，或设置 MSYS_NO_PATHCONV=1。'
      )
    }
  }

  checkPath('PANEL_PATH', options.panelPath)
  checkPath('WS 路径', options.wsPath)

  // UUID 与密码同样不该含路径分隔符
  if (/:/.test(options.uuid)) {
    problems.push(`UUID 含非法字符：${JSON.stringify(options.uuid)}`)
  }
  if (/:/.test(options.trojanPassword)) {
    problems.push(`Trojan 密码含非法字符：${JSON.stringify(options.trojanPassword)}`)
  }

  // 项目名只允许小写字母数字与连字符（Pages 要求）
  //
  // 留空是合法的：更新模式按清单取名，首次部署在 deployPagesSplit 里
  // 生成随机名（GUI 的项目名输入框就是可留空的）。
  for (const [label, name] of [
    ['控制面项目名', options.controlProject],
    ['数据面项目名', options.dataProject],
  ] as const) {
    if (!name) continue
    if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) {
      problems.push(`${label} 含非法字符：${JSON.stringify(name)}（只允许小写字母、数字、连字符）`)
    }
  }

  return problems
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
 *
 * 例外：参数非法时直接抛出。这类错误（尤其是被 MSYS 污染的路径）
 * 会把错误值写进 Pages 环境变量，事后极难清理，必须在写入前拦住。
 *
 * 另一条例外：**KV 归属校验失败时直接抛出**（见 assertKvOwnership）。
 * 越界写入会改坏别人的线上项目，不能靠 warnings 事后提醒。
 */
export async function deployPagesSplit(
  options: PagesSplitDeployOptions
): Promise<PagesSplitDeployResult> {
  const problems = validateOptions(options)
  if (problems.length > 0) {
    throw new Error(`部署参数不合法：\n  - ${problems.join('\n  - ')}`)
  }

  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const client = new CloudflareClient({ token: options.token, apiBase: options.apiBase })
  const wait = options.wait ?? { timeoutMs: 90000, intervalMs: 3000 }

  const mode = options.mode ?? 'auto'
  const keepCredentials = options.keepCredentials ?? true
  const skipSameVersion = options.skipSameVersion ?? true

  const result: PagesSplitDeployResult = {
    control: { name: options.controlProject, subdomain: '' },
    data: { name: options.dataProject, subdomain: '' },
    warnings,
  }

  const kv = { KV: { namespace_id: options.kvNamespaceId } }

  /* ---------------- 0. 解析本次要部署的内核 ---------------- */

  // ⚠️ 必须在「同版本跳过」判断**之前**完成。
  //
  // 跳过的依据是「线上跑的产物」和「本次要部署的产物」是不是同一份。
  // 而「本次要部署的产物」可能是**远程更新的内核**（版本与应用版本无关），
  // 因此必须先解析出内核、拿到它的构建指纹，才能正确判断该不该跳过。
  //
  // 解析失败不抛错：产物为空时由 deployWithBlockRetry 报「产物为空，跳过部署」。
  const kernel = await resolveKernel(options, log, warnings)

  // 本次要部署的产物的构建指纹。
  //
  // 优先用**实际要部署的产物**里提取的指纹（远程内核有自己的指纹），
  // 提取不到时回退到调用方给的 localBuild。
  const effectiveBuild = kernel.build || (options.localBuild ?? '').trim()
  /* ---------------- 0. 读部署清单，判断首次还是更新 ---------------- */

  const manifest = await readManifest(client, options.accountId, options.kvNamespaceId)

  // 生效的配置：更新部署且要求保留凭据时，用 KV 里的旧值；
  // 首次部署时对缺项生成随机值（调用方可以只传部分参数）。
  let effective = {
    panelPath: options.panelPath,
    panelPassword: options.panelPassword,
    uuid: options.uuid,
    trojanPassword: options.trojanPassword,
    wsPath: options.wsPath,
  }

  // 同源项目名：有清单就按清单来，用户不需要记项目名
  let controlName = options.controlProject
  let dataName = options.dataProject

  /**
   * 部署前的旧数据面项目名（更新模式才有）。
   *
   * 用于 8000119 换名重建后的收尾：迁自定义域名 + 删旧项目。
   * 必须在被 manifest 覆盖**之前**捕获，否则两边相等就判断不出「换过名」。
   */
  let previousDataProject = ''

  if (manifest && mode !== 'fresh') {
    log(`· 检测到已有部署（${manifest.at}），进入更新模式`)
    controlName = manifest.controlProject
    dataName = manifest.dataProject
    previousDataProject = manifest.dataProject
    result.control.name = controlName
    result.data.name = dataName
    result.control.subdomain = manifest.controlSubdomain
    result.data.subdomain = manifest.dataSubdomain

    if (keepCredentials) {
      // 沿用旧凭据：UUID / WS 路径不变，客户端订阅地址无需改动
      log('· 沿用已有 UUID / WS 路径 / 面板凭据（客户端订阅地址不变）')
      effective = {
        panelPath: options.panelPath || manifest.credentials.panelPath,
        panelPassword: options.panelPassword || manifest.credentials.panelPassword,
        uuid: options.uuid || manifest.credentials.uuid,
        trojanPassword: options.trojanPassword || manifest.credentials.trojanPassword,
        wsPath: options.wsPath || manifest.credentials.wsPath,
      }
      log(`  · UUID：${effective.uuid}`)
      log(`  · WS 路径：${effective.wsPath}`)
    }

    // 同版本跳过：避免无谓触发平台审核
    //
    // ⚠️ 比对的是**实际要部署的产物**的指纹（effectiveBuild），
    // 不是「本地内置产物」的指纹 —— 因为线上跑的很可能是远程更新的内核。
    // 用本地指纹比对会把「线上已是最新远程内核」误判成「版本不同」，
    // 从而每次都重新部署（白白触发平台审核）。
    const onlineBuild = manifest.build?.trim() ?? ''
    const onlineVersion = manifest.kernelVersion?.trim() ?? ''
    const sameBuild = !!effectiveBuild && onlineBuild === effectiveBuild

    // 降级保护：本次要部署的内核比线上**旧**时不部署。
    //
    // 什么时候会发生：线上跑的是远程更新的内核（如 0.7.6），
    // 而这次远程不可达（离线 / 限流）→ 回退到内置的旧内核。
    // 此时若照常部署，会把用户的线上内核**降级**到旧版本 ——
    // 一次网络抖动不该导致内核回退。
    const wouldDowngrade =
      !!onlineVersion &&
      !!kernel.version &&
      compareSemver(kernel.version, onlineVersion) < 0

    if (skipSameVersion && (sameBuild || wouldDowngrade)) {
      if (wouldDowngrade && !sameBuild) {
        log(
          `✅ 线上内核 ${onlineVersion} 比本次可用内核 ${kernel.version} 更新，跳过部署（避免降级）`
        )
      } else {
        log(`✅ 线上已是最新版本（${effectiveBuild}），跳过部署`)
      }
      result.panelPath = effective.panelPath
      result.uuid = effective.uuid
      result.wsPath = effective.wsPath
      result.panelPassword = effective.panelPassword
      return result
    }
    if (onlineBuild && effectiveBuild && onlineBuild !== effectiveBuild) {
      log(`· 版本变化：${onlineBuild} → ${effectiveBuild}`)
    }
    // 内核的 semver 变化也要说一声 —— 用户能据此判断「线上是不是比我旧」
    if (onlineVersion && kernel.version && onlineVersion !== kernel.version) {
      log(`· 内核版本变化：${onlineVersion} → ${kernel.version}`)
    }
  } else if (manifest && mode === 'fresh') {
    log('· 指定了首次部署模式，忽略已有清单')
  } else {
    log('· 未检测到已有部署，进入首次部署模式')
  }

  // 项目名兜底：更新模式已在上面按清单填好；走到这里仍为空的
  // （首次部署 + 调用方留空，如 GUI 的可选项目名输入框）生成随机名，
  // 策略与 CLI 一致（randomWorkerName：无特征字符，防风控）。
  //
  // 必须在归属校验之前完成 —— assertKvOwnership 用 controlName 与清单比对，
  // 传空串会被误判成「另一个实例占用」。
  if (!controlName) controlName = randomWorkerName()
  if (!dataName) dataName = randomWorkerName()
  result.control.name = controlName
  result.data.name = dataName

  /* ---------------- 0b. 归属校验（写入任何键之前） ---------------- */

  // ⚠️ 必须早于「创建项目 / 写 KV / 部署」全部动作。
  // 越界写入会直接改坏别人的线上项目（订阅指向错误 UUID、面板路径与密码被覆盖、
  // 会话可跨实例复用），事后极难清理。
  //
  // 校验用的是**解析后的** controlName：更新模式下它来自清单，
  // 因此同一个实例的原地更新会被正确识别为 owned 而非误判为越界。
  await assertKvOwnership(client, options.accountId, options.kvNamespaceId, {
    controlProject: controlName,
    mode,
    force: options.force,
    log,
  })

  // 首次部署：缺项的凭据生成随机值
  if (!effective.panelPath) effective.panelPath = randomPanelPath()
  if (!effective.panelPassword) effective.panelPassword = randomPassword()
  if (!effective.uuid) effective.uuid = randomUUID()
  if (!effective.trojanPassword) effective.trojanPassword = randomPassword()
  if (!effective.wsPath) effective.wsPath = randomWsPath()

  result.panelPath = effective.panelPath
  result.uuid = effective.uuid
  result.wsPath = effective.wsPath
  result.panelPassword = effective.panelPassword

  /* ---------------- 1. 创建两个 Pages 项目 ---------------- */
  for (const [label, name] of [
    ['控制面', controlName],
    ['数据面', dataName],
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

  if (result.control.subdomain) {
    await configureProject(client, options.accountId, controlName, '控制面', result, options, log, warnings, effective)
  }

  if (result.data.subdomain) {
    await configureProject(client, options.accountId, dataName, '数据面', result, options, log, warnings, effective)
  }

  /* ---------------- 2b. 把本次凭据写入 KV 的 CONFIG 键 ---------------- */

  // 内核的优先级是 **KV(CONFIG) > 环境变量 > 内置默认值**，
  // 因此本次生成的 UUID / WS 路径 / Trojan 密码必须落到 KV 才真正生效，
  // 否则环境变量会被 KV 里的旧值压过（用户会拿着新密码登不进去）。
  //
  // ⚠️ 写的是大写 `CONFIG` 键（UserConfig schema），不是 旧版的小写 `config` 键：
  // CFPilot 的数据面读的是 `CONFIG`；小写 `config` 只被 旧版原版读取，
  // 往那里写不仅无效，还会整体覆盖共存项目的配置。
  await writeEffectiveConfig(
    client,
    options.accountId,
    options.kvNamespaceId,
    effective,
    { enableTrojan: options.enableTrojan, enableXhttp: options.enableXhttp },
    warnings,
    log
  )

  /* ---------------- 3. 部署（先数据面，控制面的 DATA_HOST 才有效） ---------------- */
  // 内核产物已在第 0 步解析好（远程优先，内置兜底）。
  //
  // ⚠️ `options.bundles` 优先级最高：调用方显式指定的产物不会被覆盖。
  const dataCode = kernel.data
  const controlCode = kernel.control

  /* ---------------- 3. 部署（先数据面，控制面的 DATA_HOST 才有效） ---------------- */

  // ⚠️ 已知平台行为：
  //    Pages 对含代理入站 + 出站拨号的项目，**第二次部署必然返回
  //    HTTP 400 / 8000119 blocked**，与项目名、是否二次打包、
  //    是否改动源码均无关（原版文件 + 全新随机项目名同样 1/3）。
  //    而不含代理内容的极简 Worker 可 4/4 连续部署。
  //
  //    因此「原地更新」对数据面不可用。妥协方案：命中 8000119 时
  //    自动换一个新的随机项目名重新部署，保证上游有更新时仍能上线。
  //
  //    换名后的两件收尾：
  //      1. **自定义域名自动迁移** —— 旧项目上绑的域名迁到新项目，
  //         否则用户订阅里的地址全部失效（以前要用户手动迁移）；
  //      2. **删除旧项目** —— 否则每次更新都留一个孤立项目，
  //         账号下越积越多（以前要用户手动清理）。
  //
  // 读取旧项目的自定义域名。
  //
  // ⚠️ **必须用 `/domains` 子接口，不能用 `project.domains`**（真机实测）：
  // 刚绑定的域名在 `initializing` 期间不会出现在 `project.domains` 里，
  // 只有 `active` 的才列出。若此时恰好触发 8000119 换名，就会漏掉该域名
  // → 新项目没继承它 → 用户订阅地址失效。
  let dataCustomDomain = ''
  if (previousDataProject) {
    const isCustom = (d: string): boolean => typeof d === 'string' && !d.endsWith('.pages.dev')
    try {
      // 1) 优先 `/domains`（含未生效状态）
      const all = await client.listPagesDomains(options.accountId, previousDataProject)
      dataCustomDomain = all.find(isCustom) ?? ''
      // 2) 回落 `project.domains`（旧版 API 或 /domains 不可用时）
      if (!dataCustomDomain) {
        const prev = await client.getPagesProject(options.accountId, previousDataProject)
        const domains: string[] = Array.isArray(prev.domains) ? prev.domains : []
        dataCustomDomain = domains.find(isCustom) ?? ''
      }
      if (dataCustomDomain) log(`· 旧数据面项目 ${previousDataProject} 绑定了自定义域名 ${dataCustomDomain}，将自动迁移`)
    } catch {
      /* 旧项目读不到就不迁移（可能已被删） */
    }
  }

  const dataAttempt = await deployWithBlockRetry({
    client,
    accountId: options.accountId,
    preferredName: dataName,
    code: dataCode,
    label: '数据面',
    result,
    options,
    effective,
    wait,
    log,
    warnings,
    oldProject: previousDataProject,
    customDomain: dataCustomDomain,
  })
  if (dataAttempt) {
    result.data.name = dataAttempt.project ?? options.dataProject
    result.data.subdomain = dataAttempt.subdomain
  }

  // ⚠️ **数据面换名后必须重配控制面**
  //
  // 流程上控制面的环境变量是**部署前**配好的（Pages 要求先配变量再部署），
  // 那时 `result.data.subdomain` 还是**旧值**（来自部署清单或空）。
  //
  // 而数据面部署可能因 8000119 **换名重建** → 域名变了 →
  // 控制面的 `DATA_HOST` 仍指向**已删除的旧域名** →
  // 订阅里的 sni / host 全部指向不存在的域名 → **所有节点失效**。
  //
  // 真机实测：数据面 `ck12akov-tw5u-r993-vmsg`，控制面 `DATA_HOST` 却是
  // `ck12akov-tw5u-r993`（已删除）→ 订阅 90 个节点全部连不上。
  //
  // 因此这里比对一次，域名变了就重配控制面（环境变量可以随时改，无需重新部署）。
  if (result.data.subdomain && result.control.name) {
    const expected = result.data.subdomain
    try {
      const controlProject = await client.getPagesProject(options.accountId, result.control.name)
      const currentHost = controlProject.deployment_configs?.production?.env_vars?.DATA_HOST?.value ?? ''
      if (currentHost && currentHost !== expected) {
        log(`⚠ 控制面 DATA_HOST 仍指向旧域名 ${currentHost}，正在同步为 ${expected}`)
        await configureProject(
          client,
          options.accountId,
          result.control.name,
          '控制面',
          result,
          options,
          log,
          warnings,
          effective
        )
        log(`✅ 控制面 DATA_HOST 已同步为 ${expected}`)
      }
    } catch (err) {
      warnings.push(`同步控制面 DATA_HOST 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const controlAttempt = await deployWithBlockRetry({
    client,
    accountId: options.accountId,
    preferredName: controlName,
    code: controlCode,
    label: '控制面',
    result,
    options,
    effective,
    wait,
    log,
    warnings,
  })
  if (controlAttempt) {
    result.control.name = controlAttempt.project ?? controlName
    result.control.subdomain = controlAttempt.subdomain
  }

  /* ---------------- 4. 写回部署清单（下次更新靠它识别同源项目） ---------------- */

  if (result.control.subdomain && result.data.subdomain) {
    // ⚠️ 不要写 `'unknown'` 这种假版本号。
    //
    // 早年这里写 `options.localBuild ?? 'unknown'`，于是清单里留下真正的字符串
    // `"build": "unknown"`。而读清单的一方（GUI 的「检查状态」）无法区分
    // 「真的叫 unknown」和「当时没读到」—— 只能显示「线上内核 unknown ≠ 本地 xxx」，
    // 用户完全看不懂。
    //
    // 正确做法：**读不到就写空串**（语义 = 未知），由读取方按「无版本号」处理。
    //
    // ⚠️ 记的是**实际部署的产物**的指纹（可能是远程更新的内核），
    // 不是本地内置产物的指纹 —— 否则清单会谎报线上跑的是哪份代码。
    const build = effectiveBuild

    // 内核的语义化版本（semver）：远程的填远程版本，内置的填应用版本。
    //
    // 与 build 的分工：
    //   - build        → 判断「是不是同一份产物」（精确，但比不出新旧）
    //   - kernelVersion → 判断「谁更新」（有大小顺序）
    //
    // 同样读不到就写空串，绝不写 "unknown"。
    const kernelVersion = kernel.version.trim()

    await writeManifest(client, options.accountId, options.kvNamespaceId, {
      v: 1,
      kvNamespaceId: options.kvNamespaceId,
      controlProject: result.control.name,
      dataProject: result.data.name,
      controlSubdomain: result.control.subdomain,
      dataSubdomain: result.data.subdomain,
      // 自定义域名：本次迁过来的，或旧项目上原有的（下次更新还要靠它迁移）
      dataCustomDomain: dataCustomDomain || manifest?.dataCustomDomain || '',
      build,
      kernelVersion,
      at: new Date().toISOString(),
      credentials: {
        panelPath: effective.panelPath,
        panelPassword: effective.panelPassword,
        uuid: effective.uuid,
        trojanPassword: effective.trojanPassword,
        wsPath: effective.wsPath,
      },
    })
    log('· 已记录部署清单，下次更新会自动识别同源项目')
  }

  return result
}

/** 生成随机后缀（换名重试用） */
function randomSuffix(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/** 部署结果（用于回写实际使用的项目名） */
interface DeployAttemptResult {
  /** 最终成功的项目名；失败时为 null */
  project: string | null
  subdomain: string
  deploymentId?: string
}

/**
 * 配置一个 Pages 项目的 KV 绑定与环境变量。
 *
 * 抽成独立函数的原因：命中 8000119 换名重试时，新项目也要配一遍。
 *
 * KV 绑定两个名字：
 *   - `KV`：CFPilot 内核读的名字（store.ts 用 env.KV）
 *   - `K` ：旧版风格的名字（vendor 源码里 `t.K`）
 * 少绑一个就会有一侧读不到配置。
 */
async function configureProject(
  client: CloudflareClient,
  accountId: string,
  project: string,
  label: string,
  result: PagesSplitDeployResult,
  options: PagesSplitDeployOptions,
  log: (m: string) => void,
  warnings: string[],
  effective: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
): Promise<void> {
  const kvBindings = {
    KV: { namespace_id: options.kvNamespaceId },
    K: { namespace_id: options.kvNamespaceId },
  }

  const envVars: Record<string, { value: string }> =
    label === '控制面'
      ? {
          PANEL_PATH: { value: effective.panelPath },
          PANEL_PASSWORD: { value: effective.panelPassword },
          // 拆分部署：控制面用 DATA_HOST 指定节点域名
          DATA_HOST: { value: result.data.subdomain },
          ...(options.scannerToken ? { SCANNER_TOKEN: { value: options.scannerToken } } : {}),
        }
      : {
          UUID: { value: effective.uuid },
          TROJAN_PASSWORD: { value: effective.trojanPassword },
          // WS 路径：内核读 WS_PATH 或 PATH，这里两个都注入
          WS_PATH: { value: effective.wsPath },
          PATH: { value: effective.wsPath },
          ENABLE_TROJAN: { value: options.enableTrojan ? 'true' : 'false' },
          ENABLE_XHTTP: { value: options.enableXhttp ? 'true' : 'false' },
          // 出站前自动 DoH 解析优选 IP（自研数据面用；默认开启）
          ...(options.resolvePreferred === undefined
            ? {}
            : { RESOLVE_PREFERRED: { value: options.resolvePreferred ? 'true' : 'false' } }),
        }

  try {
    await client.updatePagesDeploymentConfig(accountId, project, {
      kv_namespaces: kvBindings,
      env_vars: envVars,
    })
    log(`✅ ${label}已配置 KV 与环境变量`)
  } catch (err) {
    warnings.push(
      `${label}配置失败：${err instanceof Error ? err.message : String(err)}（会导致部署后变量不生效）`
    )
  }
}

/**
 * 部署一个 Pages 项目；命中 8000119 时自动换随机项目名重试。
 *
 * 为什么必须换名：平台对代理类项目的封禁是**按项目**生效的，
 * 同一个项目第二次部署必被拒，原地更新不可用。
 */
async function deployWithBlockRetry(params: {
  client: CloudflareClient
  accountId: string
  preferredName: string
  code: string
  label: string
  result: PagesSplitDeployResult
  options: PagesSplitDeployOptions
  effective: {
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
  }
  wait: { timeoutMs: number; intervalMs: number }
  log: (m: string) => void
  warnings: string[]
  /**
   * 被替换掉的旧项目名（更新部署时才有）。
   *
   * 用于两件收尾工作：
   *   1. 把旧项目上的自定义域名迁到新项目（否则用户订阅地址全失效）；
   *   2. 迁移成功后删除旧项目（否则每次更新都留一个孤立项目）。
   */
  oldProject?: string
  /** 需要迁移的自定义域名（旧项目上绑定的） */
  customDomain?: string
}): Promise<DeployAttemptResult | null> {
  const { client, accountId, preferredName, code, label, result, options, effective, wait, log, warnings } = params
  if (!code) {
    warnings.push(`${label}产物为空，跳过部署`)
    return null
  }

  const slot = label === '数据面' ? result.data : result.control

  /**
   * 收尾：迁移自定义域名 + 删除旧项目。
   *
   * 只在**确实换了项目**（新名 ≠ 旧名）时执行。
   *
   * ## 顺序（真机实测得出，不能改）
   *
   * ```
   * 1. 旧项目解绑域名   ← 必须！Pages 的同一域名同时只能挂一个项目
   * 2. 新项目绑定域名
   * 3. 删除旧项目
   * ```
   *
   * 跳过第 1 步会报 `You have already added this custom domain`
   * ；第 3 步必须在第 2 步之后，
   * 否则域名会在一段时间内指向不存在的项目。
   */
  const migrateAndCleanup = async (newName: string): Promise<void> => {
    const oldName = params.oldProject
    if (!oldName || oldName === newName) return

    // 1) 迁移自定义域名：先解绑旧的，再绑新的
    const domain = params.customDomain
    if (domain) {
      // 1a) 旧项目解绑（失败不阻断：可能本来就没绑在这上面）
      try {
        await client.removePagesDomain(accountId, oldName, domain)
        log(`· 已从旧项目 ${oldName} 解绑域名 ${domain}`)
      } catch {
        /* 解绑失败继续尝试绑定，让真正的错误在下一步暴露 */
      }

      // 1b) 新项目绑定
      try {
        await client.addPagesDomain(accountId, newName, domain)
        log(`✅ ${label}自定义域名已迁移到新项目：${domain}`)
      } catch (err) {
        warnings.push(
          `自定义域名迁移失败（${domain} → ${newName}）：${err instanceof Error ? err.message : String(err)}\n` +
            `  → 请手动到 Cloudflare 控制台把该域名改绑到 ${newName}，否则订阅地址会失效。`
        )
        // 迁移失败就别删旧项目 —— 旧项目还挂着用户唯一的访问入口
        return
      }
    }

    // 2) 删除旧项目（域名已迁走或本来就没有）
    try {
      await client.deletePagesProject(accountId, oldName)
      log(`✅ 已删除被替换的旧${label}项目：${oldName}`)
    } catch (err) {
      warnings.push(`删除旧${label}项目失败（${oldName}）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 候选项目名：首选原名，失败后再换随机名。
  const candidates = [preferredName]
  for (let i = 0; i < 2; i++) candidates.push(`${preferredName}-${randomSuffix(4)}`)

  /**
   * 同一个项目重试的次数。
   *
   * `8000119` 的风控判定分两种形态：
   *   1. **新项目/未承载流量的项目**：间歇性，原样重试即可成功
   *      （同配置连做 6 次全部成功；最初失败的新项目原样重试也成功）
   *   2. **已服务真实代理流量的数据面项目**：持久性，重试无意义
   *      （`ck12akov-…-g3un` 原地重部署连试 4 次全部被拒）
   *
   * 因此换名之前必须先原样重试：对新项目这是成功率最高的路径；
   * 对已承载流量的旧项目，3 次原样重试只是「确认持久封禁」的成本，
   * 之后换名重建即可（换名会留下一个用不上的旧项目，属预期代价）。
   */
  const SAME_PROJECT_ATTEMPTS = 3

  for (const [index, name] of candidates.entries()) {
    for (let attempt = 1; attempt <= SAME_PROJECT_ATTEMPTS; attempt++) {
      try {
        const deployment = await client.deployPagesWorker(accountId, name, { code })
        slot.name = name
        slot.deploymentId = deployment.id
        log(`✅ ${label}已触发部署：${name}（${deployment.id}）`)

        const final = await waitForDeployment(client, accountId, name, wait, log)
        if (final?.latest_stage?.status === 'success') {
          log(`✅ ${label}部署完成：${name}`)
          // 成功后同步 subdomain
          try {
            const project = await client.getPagesProject(accountId, name)
            slot.subdomain = project.subdomain
          } catch {
            /* subdomain 取不到不影响主流程 */
          }
          // 换名成功：迁域名、删旧项目
          await migrateAndCleanup(name)
          return { project: name, subdomain: slot.subdomain, deploymentId: deployment.id }
        }
        warnings.push(`${label}部署未确认成功（项目 ${name}，状态：${final?.latest_stage?.status ?? '未知'}）`)
        return { project: name, subdomain: slot.subdomain, deploymentId: deployment.id }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const blocked = /8000119|has been blocked/i.test(message)
        const isLastAttempt = attempt === SAME_PROJECT_ATTEMPTS

        // 同名重试耗尽：换名再试
        if (isLastAttempt && index < candidates.length - 1) {
          log(`⚠ ${label}项目 ${name} 连续 ${SAME_PROJECT_ATTEMPTS} 次被平台拒绝部署（8000119）`)
          log(`  → 改用品名 ${candidates[index + 1]} 重新部署`)
          // 换名重试前要先建项目、配变量
          try {
            await client.createPagesProject(accountId, { name: candidates[index + 1]!, productionBranch: 'main' })
            await configureProject(client, accountId, candidates[index + 1]!, label, result, options, log, warnings, effective)
            log(`  → 已创建并配置 ${candidates[index + 1]}`)
          } catch (setupErr) {
            warnings.push(`创建备用${label}项目失败：${setupErr instanceof Error ? setupErr.message : String(setupErr)}`)
            return null
          }
          break
        }

        if (!isLastAttempt) {
          log(`⚠ ${label}项目 ${name} 部署被拒（8000119），${SAME_PROJECT_ATTEMPTS - attempt} 次后重试同一项目`)
          log('  → 该判定是间歇性的，同名重试通常就能成功')
          continue
        }

        warnings.push(
          `${label}部署失败：${message}` +
            (blocked
              ? '（平台已拒绝该项目；已重试并尝试更换项目名，可在 Cloudflare 控制台查看详情）'
              : '')
        )
        return null
      }
    }
  }
  return null
}
