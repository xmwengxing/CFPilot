/**
 * cfpilot-deploy —— CFPilot 全中文部署向导
 *
 * 注意：不要在这里手写 shebang。
 * 构建脚本（scripts/build.mjs）会通过 esbuild banner 注入，
 * 两处都写会导致产物出现两行 #!，Node 只认第一行，直接语法报错。
 */
import { flagBool, flagString, parseArgs } from './args'
import { CloudflareClient } from './cf-api'
import { checkTokenPermissions, renderTokenCheck } from './token-check'
import { deploy, printResult } from './wizard'
import { deployPagesSplit, listCfPilotNamespaces } from './pages-deploy'
import { deployWorkerSplit, listCfPilotWorkerNamespaces } from './worker-deploy'
import { randomPanelPath, randomPassword, randomWorkerName, randomWsPath } from './utils'
import { randomUUID } from 'node:crypto'
import { NAME, VERSION } from './version'

const TOKEN_HELP = `
${NAME} token —— 校验 Cloudflare API Token

用法:
  ${NAME} token [选项]          列出 Token 可访问的账号与有效期
  ${NAME} token --check [选项]  逐项探测权限，输出「权限项 / 状态 / 缺失后果」

选项:
  --token <token>     Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>      只检查指定账号（默认第一个可见账号）
  --zone <domain>     指定主域名；与 --domain 一起会把自定义域名相关权限视为必需
  --domain <hostname> 计划绑定的完整自定义域名
  --check             执行权限预检
  --help              显示本帮助

示例:
  npx -y cfpilot-deploy token --check --token "$CLOUDFLARE_API_TOKEN"
  npx -y cfpilot-deploy token --check --zone example.com
`

const HELP = `
${NAME} v${VERSION}
CFPilot 全中文部署向导 —— 自动创建 KV、部署 Worker 内核、绑定自定义域名。

用法:
  ${NAME} init [选项]          执行 Worker 部署（单项目）
  ${NAME} pages-split [选项]   Pages 双项目部署（控制面 + 数据面，**默认推荐**）
  ${NAME} worker-split [选项]  Workers 双脚本部署（实验性，更新更稳定但数据面有已知限制）
  ${NAME} token [选项]        仅校验 API Token
  ${NAME} token --check       逐项探测 Token 权限并输出修复建议
  ${NAME} --help              显示帮助
  ${NAME} --version           显示版本

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID（跳过选择）
  --worker <name>        Worker 名称（默认纯随机，不带项目特征）
  --zone <domain>        绑定的主域名，如 example.com
  --domain <hostname>    完整自定义域名，如 cfpilot.example.com
  --kv-title <title>     KV 命名空间标题
  --workers-dev          不绑定自定义域名，直接使用 workers.dev
  --yes                  非交互模式
  --dry-run              只演示流程，不实际上传

部署流程（v${VERSION}）:
  1. 校验 Token → 选择账号 → 生成纯随机 Worker 名
  2. 创建 KV → 生成面板路径 / 密码 / 扫描令牌 → 上传内核
  3. 自动开启 workers.dev 子域路由（否则会显示 "There is nothing here yet"）
  4. 自动开启 Workers Logs（observability）
  5. 绑定自定义域名，并主动 GET 校验真实可访问性；
     接口成功但访问 522 时自动降级 Route + CNAME，仍失败则降级 workers.dev

   pages-split（Pages 双项目，**默认推荐**）
   真机复现：合并包部署到 Pages，第一次成功、第二次 HTTP 400 / 8000119 blocked；
   拆成控制面与数据面两个项目后，两边都能原地更新。
   1. 创建两个 Pages 项目（控制面无 sockets，数据面用 CFNext 实现）
   2. 配置 KV 绑定与环境变量（Pages 的绑定只对之后的部署生效）
   3. 先部署数据面，再部署控制面（控制面需要数据面域名生成订阅）

   ⚠️ 双项目是「当前唯一实测可用的安排」，不是 Cloudflare 的硬性要求。
      平台未说明 8000119 的具体触发原因，详见 docs/cloudflare-deployment-diagnosis.md。

   worker-split（Workers 双脚本，**实验性**）
   两个 Worker 脚本（控制面 + 数据面）共用同一个 KV。
   优势：**原地重复更新真机实测 5/5 全部成功**，从未出现 8000119，
         不需要 Pages 那套「新建项目 + 切 DATA_HOST + 重发控制面」的迁移流程。
   限制：同一份数据面产物在 Workers 上会返回 522（isolate 启动即失败），
         在 Pages 上 5/5 正常。触发点是 websocket-self 的 dial 出站调用块。
         控制面（面板 / 订阅 / 探针）不受影响。
         → 需要稳定数据面时请用 pages-split。

Token 所需权限（Cloudflare 新版按「Developer Platform / Zone」分类）:
   Account / Account Settings / Read
       读取账号列表（部署第一步）
   Developer Platform / Workers KV Storage / Edit
       创建并绑定 KV 命名空间（优选池、配置、会话都存这里）
   Developer Platform / Workers Scripts / Edit
       上传内核、开启 workers.dev 子域路由、开启 Workers Logs
   Developer Platform / Pages / Edit
       pages-split 创建项目、配置变量、触发部署

   仅绑定自定义域名时才需要（Zone 分类）:
   Zone / Zone / Read            列出账号下的域名
   Zone / DNS / Edit             检测冲突 DNS、创建 CNAME
   Zone / Workers Routes / Edit  创建 Route（自定义域名 522 时的回退路径）

   以下权限本项目完全用不到，可以不勾:
     DNA & Zone / Account DNS Settings（账号级 DNS 默认设置，向导不调用）
     DNA & Zone / DNS Firewall（DNS 防火墙规则）
     DNA & Zone / DNS View（内部 DNS 视图）
     Registrar Domains / Registrar Sandbox Domains（域名注册）

Token 有效期说明:
  account-owned Token（cfat_ 前缀）无需 /user/tokens/verify，
  向导会自动改用账号维度校验，不影响部署。

建议先跑一次权限预检：
  npx -y cfpilot-deploy token --check --zone example.com
`

const PAGES_HELP = `
${NAME} pages-split —— Pages 双项目部署（控制面 + 数据面）

⚠️ 这是**当前唯一实测可用的部署形态**，不是 Cloudflare 的硬性要求。
   2026-10-22 真机复现：合并包部署到 Pages，第一次成功、第二次
   HTTP 400 / 8000119 blocked。拆成两个项目后两边都能原地更新。
   Cloudflare 未说明具体触发原因，详见 docs/cloudflare-deployment-diagnosis.md。

用法:
  ${NAME} pages-split [选项]

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID
  --kv <id>              KV 命名空间 ID（两个项目共用）
  --kv-title <title>     新建 KV 时使用的标题
  --new-kv               强制新建一个 KV 命名空间（用于部署第 2、3… 个实例）
  --list-kv              列出该账号下的 KV 与其中的 CFPilot 实例，不执行部署
  --control <name>       控制面 Pages 项目名（默认随机）
  --data <name>          数据面 Pages 项目名（默认随机）
  --panel-path <path>    面板访问路径（默认随机）
  --mode <mode>          部署模式：auto（默认，自动判断）/ fresh（强制首次）/ update（强制更新）
  --force                忽略版本检查，强制重新部署
  --force-kv             跳过 KV 归属校验（明知该 KV 属于别的实例仍然继续）
  --dataplane <impl>     数据面实现：self（默认，自研）/ vendor（CFNext 原版）
  --resolve-preferred=false
                          关闭出站前自动 DoH 解析优选 IP（默认开启）
  --new-credentials      更新部署时也重新生成 UUID / WS 路径 / 面板凭据
                          （默认沿用旧凭据，客户端订阅地址不变）
  --yes                  非交互模式

首次还是更新？
  向导把部署清单写在 KV 的 CFP_DEPLOY_MANIFEST 键里，记录上次用的两个
  Pages 项目名与凭据。因此：
    · 首次部署：KV 里没有清单 → 创建新项目、生成随机凭据
    · 更新部署：KV 里有清单 → 自动找到同源项目、沿用 UUID 与 WS 路径
  你不需要记项目名，也不需要判断是不是首次。

  ⚠️ **一个 KV 命名空间只能承载一个 CFPilot 部署实例**。
     内核在 KV 里用的是全局平铺的键（CONFIG / PANEL_PATH / SESSION:* …），
     没有实例前缀；两个实例共用一个 KV 会互相覆盖凭据与面板密码。
     要在同一账号下跑多个实例，请给每个实例一个独立 KV（--new-kv）。

  未指定 --kv 时，向导会：
    1. 列出账号下所有 KV，逐个探测清单
    2. 恰好一个含清单 → 复用它（进入更新模式，沿用 UUID 与 WS 路径）
    3. 一个都没有     → 新建一个（首次部署）
    4. 有多个         → 列出候选，请用 --kv <id> 明确指定
  用 --list-kv 可随时查看账号下已有哪些实例。

版本跳过:
  每次构建会生成 git短hash-时间戳 的版本号并写入产物。
  线上版本与本地一致时跳过部署，避免无谓触发平台审核。
  加 --force 可强制重新部署。

产物来源:
  packages/worker-core/dist/control.js  控制面（面板 + 订阅 + 探针，无 sockets）
  packages/worker-core/dist/dataplane.js 数据面（VLESS/Trojan-WS，CFNext 实现）

部署顺序（不可调换）:
  1. 创建两个 Pages 项目
  2. 配置 KV 绑定与环境变量（Pages 的绑定只对之后的部署生效）
  3. 先部署数据面，再部署控制面（控制面需要数据面域名生成订阅）

Token 所需权限:
  Account / Pages / Edit              创建项目、配置变量、触发部署
  Account / Workers KV Storage / Edit 创建 KV（若未提供 --kv）
`

const WORKER_HELP = `
${NAME} worker-split —— Workers 双脚本部署（控制面 + 数据面）

🟡 **实验性通道**。日常请优先用 pages-split（默认推荐）。

## 为什么会有这个通道

真机对照（2026-10-23/24，两个账号）确认的关键事实：

| 通道            | 原地重复更新                                  |
|-----------------|-----------------------------------------------|
| Pages 项目      | 数据面承载流量后**持久性拒绝**（8000119）      |
| Workers 脚本    | **连续 5 次原地更新全部成功**，从未出现 8000119 |

也就是说：**Workers 的更新链路明显比 Pages 稳定**，
不需要「新建项目 + 切 DATA_HOST + 重发控制面」那套迁移流程。

## ⚠️ 已知限制（务必先读）

同一份字节内容（含自研数据面 websocket-self + dial 出站代码）：

| 通道                        | 结果                              |
|-----------------------------|-----------------------------------|
| Pages \`_worker.js\`          | 5/5 全部 200 ✅                    |
| Workers 脚本 + 自定义域名    | 5/5 全部 522 ❌（isolate 启动失败）|

已排除：体积 / 静态与动态 \`cloudflare:sockets\` 导入 / \`compatibility_date\` /
minify / 账号差异（备用干净账号同样失败）/ KV 绑定 / 模块级 API。
精确触发点是 websocket-self 里的 \`dial()\` 出站调用块 —— 去掉它立即恢复 200。

→ **控制面（面板 / 订阅 / 探针）完全可用**；
→ **数据面在部分环境下无法启动**，需要稳定数据面时请用 pages-split。

用法:
  ${NAME} worker-split [选项]

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID
  --kv <id>              KV 命名空间 ID（两个脚本共用）
  --kv-title <title>     新建 KV 时使用的标题
  --new-kv               强制新建一个 KV 命名空间（用于部署第 2、3… 个实例）
  --list-kv              列出该账号下的 KV 与其中的 CFPilot 实例（含两种通道）
  --control <name>       控制面 Worker 脚本名（默认随机）
  --data <name>          数据面 Worker 脚本名（默认随机）
  --panel-path <path>    面板访问路径（默认随机）
  --control-host <host>  控制面自定义域名（可选；需要同时给 --zone-id）
  --data-host <host>     数据面自定义域名（可选；需要同时给 --zone-id）
  --zone-id <id>         绑定自定义域名所需的 zone ID
  --mode <mode>          部署模式：auto（默认）/ fresh（强制首次）/ update（强制更新）
  --force                忽略版本检查，强制重新部署
  --force-kv             跳过 KV 归属校验（明知该 KV 属于别的实例仍然继续）
  --dataplane <impl>     数据面实现：self（默认，自研）/ vendor（CFNext 原版）
  --resolve-preferred=false
                          关闭出站前自动 DoH 解析优选 IP（默认开启）
  --new-credentials      更新部署时也重新生成 UUID / WS 路径 / 面板凭据
  --yes                  非交互模式

首次还是更新？
  清单写在 KV 的 CFP_DEPLOY_MANIFEST_WORKERS 键里（与 Pages 清单分开存），
  记录上次用的两个脚本名与凭据：
    · 首次部署：KV 里没有该清单 → 上传新脚本、生成随机凭据
    · 更新部署：KV 里有清单 → 自动找到同源脚本、沿用 UUID 与 WS 路径
  你不需要记脚本名，也不需要判断是不是首次。

  ⚠️ 一个 KV 命名空间只能承载一个 CFPilot 实例。
     且 **Pages 与 Workers 两种形态不能共用同一个 KV**（内核的 KV 键全局平铺）。
     向导会检测并拒绝（--force-kv 可强推）。

部署顺序（不可调换）:
  1. 上传数据面脚本（含 KV 绑定与 UUID / WS 路径变量）
  2. 上传控制面脚本（DATA_HOST 指向已确定的数据面域名）
  3. 开启 workers.dev 子域路由 / 绑定自定义域名
  4. 探测数据面 /__diag，明确告知 522 风险

Token 所需权限:
  Account / Workers Scripts / Edit    上传脚本、开启 workers.dev 子域路由
  Account / Workers KV Storage / Edit 创建 KV（若未提供 --kv）
  Account / Workers Routes / Edit     仅绑定自定义域名时需要
`

/**
 * 列出账号下的 KV 与其中的 CFPilot 实例。
 *
 * 一个 KV 命名空间只能承载一个 CFPilot 实例，
 * 因此「账号下有几个实例」等价于「账号下有几个含清单的 KV」。
 *
 * 两种部署形态的清单键不同（Pages：CFP_DEPLOY_MANIFEST；
 * Workers：CFP_DEPLOY_MANIFEST_WORKERS），这里同时展示。
 */
async function listKvInstances(client: CloudflareClient, accountId: string): Promise<void> {
  const namespaces = await client.listKvNamespaces(accountId)
  process.stdout.write(`账号下共 ${namespaces.length} 个 KV 命名空间：\n`)
  const instances = await listCfPilotNamespaces(client, accountId)
  const workerInstances = await listCfPilotWorkerNamespaces(client, accountId)
  const instanceIds = new Set(instances.map((i) => i.id))
  const workerIds = new Set(workerInstances.map((i) => i.id))

  for (const ns of namespaces) {
    const instance = instances.find((i) => i.id === ns.id)
    const workerInstance = workerInstances.find((i) => i.id === ns.id)
    if (instance) {
      process.stdout.write(
        `  ● ${ns.id}  ${ns.title}  [Pages]\n` +
          `      实例：控制面 ${instance.manifest.controlProject} / 数据面 ${instance.manifest.dataProject}\n` +
          `      域名：${instance.manifest.controlSubdomain} / ${instance.manifest.dataSubdomain}\n` +
          `      部署于 ${instance.manifest.at}，版本 ${instance.manifest.build}\n`
      )
    } else if (workerInstance) {
      process.stdout.write(
        `  ● ${ns.id}  ${ns.title}  [Workers]\n` +
          `      实例：控制面 ${workerInstance.manifest.controlScript} / 数据面 ${workerInstance.manifest.dataScript}\n` +
          `      域名：${workerInstance.manifest.controlHost} / ${workerInstance.manifest.dataHost}\n` +
          `      部署于 ${workerInstance.manifest.at}，版本 ${workerInstance.manifest.build}\n`
      )
    } else {
      process.stdout.write(`  ○ ${ns.id}  ${ns.title}  （不含 CFPilot 实例）\n`)
    }
  }

  const total = instances.length + workerInstances.length
  process.stdout.write(
    `\n共 ${total} 个 CFPilot 实例` +
      `（Pages ${instances.length} 个 / Workers ${workerInstances.length} 个）。\n` +
      (instanceIds.size > 0
        ? '更新某个 Pages 实例：cfpilot-deploy pages-split --kv <id>\n'
        : '') +
      (workerIds.size > 0
        ? '更新某个 Workers 实例：cfpilot-deploy worker-split --kv <id>\n'
        : '') +
      '部署新实例：cfpilot-deploy pages-split --new-kv（默认）\n'
  )
}

async function runPagesSplit(args: ReturnType<typeof parseArgs>): Promise<void> {  const token = flagString(args, 'token') || process.env.CLOUDFLARE_API_TOKEN || ''
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
    dataPlane: (flagString(args, 'dataplane') || 'self') as 'vendor' | 'self',
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

  if (result.warnings.length > 0) {
    process.stdout.write(`\n告警（${result.warnings.length} 条）：\n`)
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`)
  }
}

/**
 * Workers 双脚本部署（实验性通道）。
 *
 * 与 `runPagesSplit` 的差别：
 *   - 产物上传到 Worker 脚本（而非 Pages 项目），因此可以**原地重复更新**；
 *   - 域名可以是 workers.dev 或自定义域名（需要 zoneId）；
 *   - 部署结束后会探测数据面 `/__diag`，明确告知 522 风险。
 */
async function runWorkerSplit(args: ReturnType<typeof parseArgs>): Promise<void> {
  const token = flagString(args, 'token') || process.env.CLOUDFLARE_API_TOKEN || ''
  if (!token) {
    process.stderr.write('缺少 --token 参数（或设置 CLOUDFLARE_API_TOKEN）\n')
    process.exitCode = 1
    return
  }

  const client = new CloudflareClient({ token })
  let resolvedAccount = flagString(args, 'account') || ''
  let kvId = flagString(args, 'kv') || ''

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

  // --list-kv：只列出实例，不部署
  if (flagBool(args, 'list-kv')) {
    await listKvInstances(client, resolvedAccount)
    return
  }

  /* ---------------- KV 解析 ---------------- */

  const forceNewKv = flagBool(args, 'new-kv')
  const existingWorkers = await listCfPilotWorkerNamespaces(client, resolvedAccount)

  if (!kvId && !forceNewKv) {
    if (existingWorkers.length === 0) {
      const title = flagString(args, 'kv-title') || `cfpilot-kv-${Date.now().toString(36)}`
      process.stdout.write(`创建 KV 命名空间：${title}\n`)
      const ns = await client.createKvNamespace(resolvedAccount, title)
      kvId = ns.id
      process.stdout.write(`✓ KV 已创建：${ns.id}\n`)
    } else if (existingWorkers.length === 1) {
      const only = existingWorkers[0]!
      kvId = only.id
      process.stdout.write(
        `✓ 复用已有 Workers 实例的 KV：${only.title}（${only.id}）\n` +
          `  控制面 ${only.manifest.controlScript} / 数据面 ${only.manifest.dataScript}\n` +
          `  部署于 ${only.manifest.at}\n`
      )
    } else {
      process.stderr.write('✗ 该账号下有多个 Workers 实例，请用 --kv <id> 指定要部署哪一个：\n')
      for (const item of existingWorkers) {
        process.stderr.write(
          `    ${item.id}  ${item.title}  ` +
            `控制面 ${item.manifest.controlScript} / 数据面 ${item.manifest.dataScript}  ` +
            `（${item.manifest.at}）\n`
        )
      }
      process.stderr.write('  部署第 N 个新实例请加 --new-kv\n')
      process.exitCode = 1
      return
    }
  } else if (!kvId && forceNewKv) {
    const title = flagString(args, 'kv-title') || `cfpilot-kv-${Date.now().toString(36)}`
    process.stdout.write(`创建新的 KV 命名空间（--new-kv）：${title}\n`)
    const ns = await client.createKvNamespace(resolvedAccount, title)
    kvId = ns.id
    process.stdout.write(`✓ KV 已创建：${ns.id}\n`)
  }

  const mode = (flagString(args, 'mode') || 'auto') as 'auto' | 'fresh' | 'update'
  if (!['auto', 'fresh', 'update'].includes(mode)) {
    process.stderr.write(`✗ --mode 只接受 auto / fresh / update，收到：${mode}\n`)
    process.exitCode = 1
    return
  }

  const keepCredentials = !flagBool(args, 'new-credentials')
  const skipSameVersion = !flagBool(args, 'force')
  const localBuild = await readLocalBuild()

  process.stdout.write(
    '\n⚠ Workers 通道为实验性：控制面完全可用，数据面在部分环境会返回 522。\n' +
      '  需要稳定数据面时请用 pages-split（默认推荐）。\n\n'
  )

  const result = await deployWorkerSplit({
    token,
    accountId: resolvedAccount,
    kvNamespaceId: kvId,
    controlScript: flagString(args, 'control') || randomWorkerName(),
    dataScript: flagString(args, 'data') || randomWorkerName(),
    panelPath: flagString(args, 'panel-path') || '',
    panelPassword: flagString(args, 'panel-password') || '',
    uuid: flagString(args, 'uuid') || '',
    trojanPassword: flagString(args, 'trojan-password') || '',
    wsPath: flagString(args, 'ws-path') || '',
    enableTrojan: true,
    enableXhttp: false,
    mode,
    keepCredentials,
    skipSameVersion,
    force: flagBool(args, 'force-kv'),
    dataPlane: (flagString(args, 'dataplane') || 'self') as 'vendor' | 'self',
    // 默认开启；`--resolve-preferred=false` 可关闭
    resolvePreferred: args.flags['resolve-preferred'] === undefined
      ? true
      : flagBool(args, 'resolve-preferred'),
    localBuild,
    controlHostname: flagString(args, 'control-host') || undefined,
    dataHostname: flagString(args, 'data-host') || undefined,
    zoneId: flagString(args, 'zone-id') || undefined,
    log: (m) => process.stdout.write(`${m}\n`),
  })

  process.stdout.write(`\n${'─'.repeat(52)}\n`)
  process.stdout.write(`控制面：https://${result.control.host}${result.panelPath ?? ''}\n`)
  process.stdout.write(`数据面：https://${result.data.host}\n`)
  if (result.control.devHost) process.stdout.write(`控制面 workers.dev：https://${result.control.devHost}\n`)
  if (result.data.devHost) process.stdout.write(`数据面 workers.dev：https://${result.data.devHost}\n`)
  if (result.uuid) process.stdout.write(`UUID：${result.uuid}\n`)
  if (result.wsPath) process.stdout.write(`WS 路径：${result.wsPath}\n`)
  if (result.dataProbeOk === false) {
    process.stdout.write('\n⚠ 数据面探测未通过（见下方告警）。控制面不受影响。\n')
  }

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.command && !args.command.startsWith('-') ? args.command : ''
  const wantsHelp = flagBool(args, 'h') || flagBool(args, 'help')

  if (command === 'token' && wantsHelp) {
    process.stdout.write(TOKEN_HELP)
    return
  }
  if (command === 'pages-split' && wantsHelp) {
    process.stdout.write(PAGES_HELP)
    return
  }
  if (command === 'worker-split' && wantsHelp) {
    process.stdout.write(WORKER_HELP)
    return
  }
  if (wantsHelp || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (flagBool(args, 'v') || flagBool(args, 'version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  if (command === 'token') {
    const token = flagString(args, 'token') || process.env.CLOUDFLARE_API_TOKEN || ''
    if (!token) {
      process.stderr.write('缺少 --token 参数（或设置 CLOUDFLARE_API_TOKEN）\n')
      process.exitCode = 1
      return
    }

    // 权限预检：逐项探测并输出人话表格
    if (flagBool(args, 'check')) {
      const zoneName = flagString(args, 'zone') || undefined
      const domain = flagString(args, 'domain') || undefined
      const result = await checkTokenPermissions({
        token,
        accountId: flagString(args, 'account') || undefined,
        zoneName,
        expectCustomDomain: Boolean(zoneName || domain),
      })
      process.stdout.write(renderTokenCheck(result))
      if (!result.ok) process.exitCode = 1
      return
    }

    // 传统模式：只列账号与 Token 有效期
    const client = new CloudflareClient({ token })
    const accounts = await client.listAccounts()
    if (accounts.length === 0) {
      process.stderr.write('✗ 该 Token 没有可访问的账号\n')
      process.exitCode = 1
      return
    }
    for (const account of accounts) {
      process.stdout.write(`✓ 账号：${account.name}（${account.id}）\n`)
      try {
        const verify = await client.verifyToken(account.id)
        const expiry = verify.expiresOn ? `，到期 ${verify.expiresOn}` : ''
        process.stdout.write(`  Token 状态：${verify.status}${expiry}\n`)
      } catch (err) {
        process.stdout.write(
          `  Token 元信息不可读（${err instanceof Error ? err.message : String(err)}），但账号读取正常\n`
        )
      }
    }
    process.stdout.write('\n提示：加上 --check 可逐项探测 Token 权限并给出缺失后果。\n')
    return
  }

  if (command === 'pages-split') {
    if (flagBool(args, 'dry-run')) {
      process.stdout.write('（dry-run）将执行 Pages 双项目部署，未实际调用 API\n')
      return
    }
    await runPagesSplit(args)
    return
  }

  if (command === 'worker-split') {
    if (flagBool(args, 'dry-run')) {
      process.stdout.write('（dry-run）将执行 Workers 双脚本部署，未实际调用 API\n')
      return
    }
    await runWorkerSplit(args)
    return
  }

  const result = await deploy({
    token: flagString(args, 'token') || undefined,
    accountId: flagString(args, 'account') || undefined,
    workerName: flagString(args, 'worker') || undefined,
    zoneName: flagString(args, 'zone') || undefined,
    hostname: flagString(args, 'domain') || undefined,
    kvTitle: flagString(args, 'kv-title') || undefined,
    workersDev: flagBool(args, 'workers-dev'),
    yes: flagBool(args, 'yes'),
    dryRun: flagBool(args, 'dry-run'),
  })
  printResult(result)
}

main().catch((err) => {
  process.stderr.write(`\n执行失败：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
