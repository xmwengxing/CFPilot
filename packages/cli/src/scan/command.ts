/**
 * cfpilot scan —— 本地真连接优选（子命令实现）
 *
 * 与原 cfpilot-scanner 的命令行行为完全一致。
 */

import {
  parseArgs,
  flagString,
  flagNumber,
  flagBool,
  flagList,
  type ParsedArgs,
} from '../shared/args'
import {
  COARSE_SPEED_DEFAULTS,
  formatCopyable,
  formatHost,
  runScan,
  type ScanEntry,
  type ScanEvent,
  type ScanObservation,
} from './scan'
import { coloCity, normalizeCountryFilter } from './countries'
import { formatEntries } from './scan'
import { postResults, fetchScannerToken, type PushMode } from './callback'
import { resolveCandidatePlan, type CandidatePlan, type FamilyChoice } from './candidates'
import {
  loadNetworkProfile,
  mergeProfileStores,
  desktopProfileStorePath,
  normalizeNetworkProfile,
  normalizeRegion,
  saveNetworkProfile,
  updateNetworkProfile,
  type ProfileStoreDocument,
} from './network-profile'
import { configDirPath } from '../menu/store'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectProxyInterference, isMsysPollutedPath } from './net-env'
import { NAME, VERSION } from '../shared/version'
import { SCAN_HELP } from './help'
import {
  DEFAULT_SPEED_URL,
  SPEED_URL_PRESETS,
  pickAvailableSpeedUrl,
} from './speed-url'
import { BUILTIN_IPV4_CIDRS, BUILTIN_IPV6_CIDRS, readIpFile, readIpUrl } from './ip-ranges'
import { parsePool, readPoolRaw } from '../sources/pool'
import {
  POOL_SAMPLE_LIMIT,
  applyFullTestResults,
  sampleFromPool,
} from '../sources/sample'

/** 校验并归一化 WS 路径（导出供 `scan compare` 复用，避免两处实现漂移）。 */
export function normalizeWsPath(raw: string | undefined, fallback: string): string {
  const value = (raw ?? fallback).trim()
  if (!value) return fallback

  if (isMsysPollutedPath(value)) {
    process.stderr.write(
      '\n✗ --path 被 MSYS（Git-Bash）转换成了 Windows 路径：\n' +
        `   收到的是：${value}\n` +
        '\n' +
        '  这是 Git-Bash 的自动路径转换行为，不是本工具的问题。\n' +
        '  三种绕开方式，任选其一：\n' +
        '    1. 用等号写法：      --path=/vless\n' +
        '    2. 加环境变量：      MSYS_NO_PATHCONV=1 cfpilot scan ...\n' +
        '    3. 换用 PowerShell / CMD 执行\n'
    )
    process.exit(1)
  }

  if (!value.startsWith('/')) {
    process.stderr.write(
      `\n✗ --path 必须以 / 开头，收到的是：「${value}」\n` +
        '  例如：--path /vless 或 --path /（目标项目用根路径时）\n'
    )
    process.exit(1)
  }

  return value
}

/**
 * 采样种子。
 *
 * 不传 = 每次随机（默认）；显式给了 `--seed` 才固定。
 * 固定后**同样的参数会得到同样的候选列表**，这是「可复现报告」的基础。
 */
function seedFromArgs(args: ParsedArgs): number | undefined {
  return args.flags['seed'] !== undefined ? flagNumber(args, 'seed', 24301) : undefined
}

/**
 * 网络档案（实验性）。
 *
 * ## 为什么要有「档案」
 *
 * Cloudflare 网段的可用性**因网络而异**：在福建电信测得几乎不可用的网段，
 * 在广东联通可能完全正常。用一份全局静态权重去采样，
 * 等于把某个运营商的结论套到所有用户身上。
 *
 * 档案由「运营商 + 地区 + 接入方式」组成，**不同档案的历史互不混用**。
 *
 * ## 默认关闭
 *
 * 不传 `--adaptive` 时，采样行为与历史完全一致（走 expandCidrs）。
 */
interface AdaptiveContext {
  file: string
  store: ProfileStoreDocument
  /**
   * 按地址族分的档案 ID。
   *
   * 档案 ID = hash(运营商, 地区, 接入方式, **地址族**)，两族天然不同 ——
   * 采样时按族查各自的观测，写入时也按 IP 族归档，
   * 否则 v6 的历史要么查不到、要么错查成 v4 的。
   */
  profileIds: { v4: string; v6: string }
}

/** 运营商归一化：只接受已知枚举，其它一律记为 other。 */
function normalizeIsp(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase()
  return ['ct', 'cu', 'cm', 'other'].includes(value) ? value : 'other'
}

/** 接入类型归一化。 */
function normalizeAccess(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'mobile' ? 'mobile' : 'fixed'
}

/** 加载（或建立）本机网络档案。 */
async function loadAdaptiveContext(args: ParsedArgs): Promise<AdaptiveContext> {
  const file = join(configDirPath(), 'network-profiles.json')
  const isp = normalizeIsp(flagString(args, 'isp'))
  const region = normalizeRegion(flagString(args, 'region') ?? '').slice(0, 32)
  const access = normalizeAccess(flagString(args, 'access'))
  let store = await loadNetworkProfile(file, `${isp}-${region}-${access}`)
  // 桌面版的档案库也读进来：两端档案 ID 算法一致，样本应当互通。
  const desktopFile = desktopProfileStorePath()
  if (desktopFile) {
    try {
      const desktopStore = await loadNetworkProfile(desktopFile, '')
      if (Object.keys(desktopStore.observations).length > 0) {
        store = mergeProfileStores(store, desktopStore)
      }
    } catch {
      /* 桌面版档案读不到就只用 CLI 自己的 */
    }
  }
  const base = { isp, region, access, source: 'manual' as const }
  const v4 = normalizeNetworkProfile({ ...base, family: 'ipv4' })
  const v6 = normalizeNetworkProfile({ ...base, family: 'ipv6' })
  const updatedAt = Date.now()
  // 两族档案都建出来：采样按族查观测、写入按 IP 族归档，
  // 少建任何一个都会让那一族的历史无处可放。
  store.profiles[v4.id] = { ...v4, updatedAt }
  store.profiles[v6.id] = { ...v6, updatedAt }
  return { file, store, profileIds: { v4: v4.id, v6: v6.id } }
}

/**
 * 回填模式。
 *
 *   `overwrite`（默认）—— 清空面板优选池后写入（历史行为）
 *   `incremental`      —— 保留池里已有的 IP，只补新的（「增量回填」）
 *
 * 也接受 `append` / `replace`（面板接口的字段名），方便脚本两边一致。
 */
function pushModeFromArgs(args: ParsedArgs): PushMode {
  const raw = (flagString(args, 'push-mode') || 'overwrite').trim().toLowerCase()
  switch (raw) {
    case 'incremental':
    case 'append':
      return 'append'
    case 'overwrite':
    case 'replace':
      return 'replace'
    default:
      process.stderr.write(`✗ --push-mode 只接受 incremental / overwrite，收到的是：「${raw}」\n`)
      process.exit(1)
  }
}

/**
 * `--family` 参数：`auto`（默认）/ `v4` / `v6` / `both`。
 *
 * 默认 `auto` 的含义是「先做 IPv6 环境预检，通了才让 v6 参与」——
 * 本机没有可用 IPv6 时自动退回纯 v4，不会让用户撞见
 * 「一半候选全超时」才明白怎么回事。
 */
function familyFromArgs(args: ParsedArgs): FamilyChoice {
  // ⚠️ 必须用 `||` 而不是 `??`：flagString 在参数缺席时返回**空串**（fallback 默认 ''），
  // 用 `??` 兜不住，会走到报错分支 —— 实测默认调用直接退出。
  const raw = (flagString(args, 'family') || 'auto').trim().toLowerCase()
  if (raw === 'auto' || raw === 'v4' || raw === 'v6' || raw === 'both') return raw
  process.stderr.write(`✗ --family 只接受 auto / v4 / v6 / both，收到的是：「${raw}」\n`)
  process.exit(1)
}

/**
 * 解析候选并给出完整结论（预检 / 分族 / 计数）。
 *
 * @param extraHosts 用于发现活跃 IPv6 前缀的域名（数据面 + 控制面）
 */
async function resolveCandidatesFromArgs(
  args: ParsedArgs,
  extraHosts: readonly string[] = [],
  port = 443
): Promise<CandidatePlan> {
  // Phase 4：--from-pool 从本地候选池分层取样。默认关闭，不传时下面所有
  // 分支都不进入，候选生成与改动前逐字节一致。
  if (flagBool(args, 'from-pool')) {
    const limit = flagNumber(args, 'pool-sample', POOL_SAMPLE_LIMIT)
    const sample = sampleFromPool(parsePool(readPoolRaw()), { limit, port })
    poolSamples.set(args, { keys: sample.keys, port })
    return {
      candidates: sample.candidates,
      family: sample.family === 'both' ? 'both' : sample.family,
      ipv6Env: null,
      v6Prefixes: [],
      v6Discovered: [],
      counts: sample.counts,
      note: sample.note,
    }
  }
  const ipFile = flagString(args, 'ip-file')
  const ipUrl = flagString(args, 'ip-url')
  if (ipFile || ipUrl) {
    // 文件与链接只差「文本从哪来」：解析、清洗、计数全部走同一条路径
    const candidates = ipFile ? readIpFile(readFileSync(ipFile, 'utf8')) : await readIpUrl(ipUrl)
    return {
      candidates,
      family: 'both',
      ipv6Env: null,
      v6Prefixes: [],
      v6Discovered: [],
      counts: {
        v4: candidates.filter((ip) => !ip.includes(':')).length,
        v6: candidates.filter((ip) => ip.includes(':')).length,
      },
      note: ipFile
        ? `候选来自文件 ${ipFile}（未做网段采样，也未做 IPv6 预检）`
        : `候选来自链接 ${ipUrl}（未做网段采样，也未做 IPv6 预检）`,
    }
  }

  const base = {
    // 选国家时**自动中性采样**：采样发生在阶段一之前、那时还不知道机房，
    // 若某国家的 IP 集中在低权重网段，候选会被压少 → 可能「扫了几千个还是找不到 HKG/NRT」。
    neutral: args.flags['neutral-sampling'] !== undefined || flagList(args, 'countries').length > 0,
    sample: flagNumber(args, 'sample', 6556),
    cidr: flagList(args, 'cidr'),
    // ⚠️ 不传 seed = 每次随机（默认）。只有用户显式给了 --seed 才固定，
    // 否则「每次跑都测同一批 IP」——那批落在劣质路由段上时永远测不出好 IP。
    seed: seedFromArgs(args),
    family: familyFromArgs(args),
    extraHosts,
  }

  // 实验性：自适应采样（默认关闭）。
  if (!flagBool(args, 'adaptive')) return resolveCandidatePlan(base)

  const context = await loadAdaptiveContext(args)
  const exploreRate = flagNumber(args, 'explore-rate', 20) / 100
  const plan = await resolveCandidatePlan({
    ...base,
    profile: context.store,
    adaptiveSampling: {
      explorationRate: Math.min(1, Math.max(0.05, exploreRate)),
      includeZeroWeight: flagBool(args, 'explore-zero'),
      profileIds: context.profileIds,
    },
  })
  // 把档案留在内存里，扫描结束后回写观测。
  adaptiveContexts.set(args, context)
  return plan
}

/** 本次命令使用的自适应上下文（扫描结束后回写观测用）。 */
const adaptiveContexts = new WeakMap<ParsedArgs, AdaptiveContext>()

/**
 * 本次 `--from-pool` 取样到的池 key，扫描结束后用于回写 `fullTest` / `status`。
 * 只有开启 --from-pool 才有值 —— 关闭时完全不碰本地池。
 */
const poolSamples = new WeakMap<ParsedArgs, { keys: string[]; port: number }>()

/** 把本轮观测写回网络档案（仅在开启自适应时执行）。 */
async function saveAdaptiveObservations(args: ParsedArgs, observations: ScanObservation[]): Promise<void> {
  const context = adaptiveContexts.get(args)
  if (!context || observations.length === 0) return
  const now = Date.now()
  const next = updateNetworkProfile(
    context.store,
    observations.map((observation) => ({
      ip: observation.ip,
      ok: observation.ok,
      stage: observation.stage ?? 'ws',
      latencyMs: observation.latencyMs,
      speedMBps: observation.speedMBps,
      at: now,
      // 按 IP 族归档到对应档案：档案 ID 含地址族，两族历史互不污染
      profileId: observation.ip.includes(':') ? context.profileIds.v6 : context.profileIds.v4,
    })),
    now,
  )
  await saveNetworkProfile(context.file, next)
}

/**
 * 扫描进度输出。
 *
 * ⚠️ `--json` 时**必须走 stderr**：stdout 是给机器读的，
 * 混进横幅/进度行会让 `JSON.parse` 直接失败（早前 `--json > file`
 * 拿到的文件开头就是横幅，解析必然报错）。
 */
function printProgress(event: ScanEvent, quiet: boolean, asJson = false): void {
  if (quiet) return
  const out = asJson ? process.stderr : process.stdout
  switch (event.type) {
    case 'stage':
      out.write(`\n▶ 阶段 ${event.stage}：${event.name}（共 ${event.total} 个候选）\n`)
      break
    case 'progress':
      if (event.message) out.write(`\r  ${event.message}`.padEnd(78))
      break
    case 'done':
      out.write(`\n✓ 优选完成，共 ${event.count} 条\n`)
      break
    case 'error':
      out.write(`\n✗ ${event.message}\n`)
      break
    default:
      break
  }
}

function printTable(entries: ScanEntry[]): void {
  if (entries.length === 0) {
    process.stdout.write('\n没有通过全部校验的节点。\n')
    return
  }
  // TLS 握手耗时放在最前：它决定导入客户端后会不会 -1
  // （真机实测 TCP 延迟 8~40ms 无区分度，TLS 握手 768ms~3531ms 相差 4.6 倍）
  process.stdout.write('\n排名  地址                     机房   TLS(ms)  TCP(ms)  下行(MB/s)\n')
  process.stdout.write('─'.repeat(66) + '\n')
  entries.forEach((entry, index) => {
    const rank = String(index + 1).padStart(2, ' ')
    const address = `${formatHost(entry.ip)}:${entry.port}`.padEnd(24, ' ')
    const colo = (entry.colo || 'UNK').padEnd(6, ' ')
    const tls = String(entry.tlsMs).padStart(7, ' ')
    const latency = String(entry.latency).padStart(7, ' ')
    const speed = entry.speed.toFixed(1).padStart(9, ' ')
    process.stdout.write(`${rank}   ${address} ${colo} ${tls} ${latency}  ${speed}\n`)
  })

  // 机房对照：三字码对普通用户没有意义，给一份「HKG=香港」的说明。
  // 表里不直接写中文是为了保住列对齐（中文宽度与 ASCII 不一致）。
  const seen: string[] = []
  for (const entry of entries) {
    const colo = entry.colo || 'UNK'
    if (!seen.includes(colo)) seen.push(colo)
  }
  const named = seen.filter((c) => coloCity(c))
  if (named.length > 0) {
    process.stdout.write(
      '\n机房对照：' + named.map((c) => `${c}=${coloCity(c)}`).join('  ') + '\n'
    )
  }
}

/**
 * 输出一段可直接复制粘贴的列表。
 *
 * 格式 `IP:端口#机房`，一行一个，正好能贴进同类项目的
 * 「自定义 IP / 优选 IP」输入框（它们普遍支持 `IP:Port#备注` 语法）。
 */
function printCopyable(entries: ScanEntry[]): void {
  if (entries.length === 0) return
  process.stdout.write('\n── 可直接复制（粘贴到「自定义 IP / 优选 IP」输入框）──\n')
  process.stdout.write(formatCopyable(entries) + '\n')
}

export async function runScanCommand(args: ParsedArgs): Promise<void> {
  // 二级子命令：compare / relay / ips / serve（通过第一个 positional 判断）
  const sub = args.positionals[0]

  // compare 排在帮助判断**之前**：它有自己的 `scan compare --help`
  if (sub === 'compare') {
    const { runCompareCommand } = await import('./compare')
    await runCompareCommand(args)
    return
  }
  if (sub === 'relay') {
    const { runRelayCommand } = await import('./relay')
    await runRelayCommand(args)
    return
  }

  // scan 专属帮助
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(SCAN_HELP)
    return
  }

  if (sub === 'ips') {
    const includeIpv6 = !flagBool(args, 'no-ipv6')
    const cidrs = [...BUILTIN_IPV4_CIDRS, ...(includeIpv6 ? BUILTIN_IPV6_CIDRS : [])]
    process.stdout.write(cidrs.join('\n') + '\n')
    return
  }
  if (sub === 'serve') {
    const { startBridge, DEFAULT_BRIDGE_PORT, BRIDGE_VERSION } = await import('./server')
    const port = flagNumber(args, 'port', DEFAULT_BRIDGE_PORT)
    const host = flagString(args, 'host', '127.0.0.1')
    const handle = await startBridge({ port, host })
    process.stdout.write(
      [
        '',
        `  ${NAME} 本地桥接服务已启动`,
        `  监听地址：http://${host}:${handle.port}`,
        `  版本：v${BRIDGE_VERSION}`,
        '  可用 HTTP 接口：GET /status、POST /start-scan、GET /events、GET /results',
        '  按 Ctrl+C 退出。',
        '',
      ].join('\n')
    )
    const shutdown = (): void => {
      void handle.close().then(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  const host = flagString(args, 'host')
  const quiet = flagBool(args, 'quiet')
  const asJson = flagBool(args, 'json')

  if (!host) {
    process.stderr.write('缺少 --host 参数（你的 Worker 自定义域名）\n')
    process.stderr.write('提示：cfpilot scan --host "你的域名" --panel "控制面域名" --panel-password "密码"\n')
    process.exit(1)
  }

  const port = flagNumber(args, 'port', 443)
  const top = flagNumber(args, 'top', 8)
  let token = flagString(args, 'token')
  const noCallback = flagBool(args, 'no-callback')
  // --ask-callback：扫描结束后交互询问是否回填（菜单模式用）
  const askCallback = flagBool(args, 'ask-callback')
  const wsPath = normalizeWsPath(flagString(args, 'path'), '/__edge_probe')
  const probePath = normalizeWsPath(flagString(args, 'probe-path'), '/__edge_probe')
  const probeTransportRaw = (flagString(args, 'probe-transport') || 'ws').trim().toLowerCase()
  const probeTransport: 'ws' | 'xhttp' | 'both' =
    probeTransportRaw === 'xhttp' || probeTransportRaw === 'both' ? probeTransportRaw : 'ws'
  const xhttpPath = normalizeWsPath(
    flagString(args, 'xhttp-path') || '/xhttp',
    '/xhttp'
  ).replace(/\/+$/, '') || '/xhttp'
  const noSpeed = flagBool(args, 'no-speed')
  // 国家过滤：不选 = 全量。无效代码在 normalizeCountryFilter 里被丢弃
  const countries = normalizeCountryFilter(flagList(args, 'countries'))
  /**
   * 回填地址与令牌
   *
   * ## 两个改动
   *
   * 1. **回填地址必须指向控制面**，不能用 --host（那是数据面）
   *
   *    真机实测：
   *      控制面 /api/v1/login → {"ok":true} + 令牌     ✅
   *      数据面 /api/v1/*     → Pages 的 Welcome HTML  ❌
   *
   *    拆分部署时面板只在控制面。早期默认用 `https://${host}/...`
   *    （host 是数据面），回填必然失败。
   *
   *    现在用 --panel 指定控制面；不给则回落到 --host（兼容单项目部署）。
   *
   * 2. **自动获取临时令牌**：给 --panel + --panel-password 即可，
   *    用户不必自己去签发令牌。
   *
   *    令牌 10 分钟有效，而这里是**扫描结束后**才获取，
   *    所以不存在「扫描太久令牌过期」的问题 —— 与图形版同一思路。
   */
  const panelHost = flagString(args, 'panel')
  const panelPassword = flagString(args, 'panel-password')
  const callbackBase = panelHost || host

  let autoTokenUsed = false
  if (!token && !noCallback && panelHost && panelPassword) {
    if (!quiet) {
      process.stdout.write(`正在向 ${panelHost} 申请临时令牌…\n`)
    }
    const tk = await fetchScannerToken(panelHost, panelPassword)
    if (tk.ok && tk.token) {
      token = tk.token
      autoTokenUsed = true
      if (!quiet) {
        process.stdout.write('✓ 已获取临时令牌（10 分钟有效）\n')
      }
    } else if (!quiet) {
      process.stderr.write(`⚠ 自动获取令牌失败：${tk.error}\n`)
      process.stderr.write('  可改用 --token <令牌> 手动指定\n')
    }
  }

  const callback = noCallback
    ? ''
    : flagString(
        args,
        'callback',
        token || autoTokenUsed ? `https://${callbackBase}/api/v1/preferred-ips` : ''
      )

  // `--json` 时不打横幅：stdout 必须是纯 JSON
  if (!quiet && !asJson) {
    process.stdout.write(`\n${NAME} v${VERSION}\n`)
    process.stdout.write(`目标域名：${host}:${port}（将作为 TLS SNI 与 HTTP Host）\n`)
    process.stdout.write(`WS 路径：${wsPath}\n`)
    process.stdout.write(`探测传输：${probeTransport}${probeTransport !== 'ws' ? `（XHTTP 路径：${xhttpPath}）` : ''}\n`)
    if (countries.length > 0) {
      process.stdout.write(`国家筛选：${countries.join(' / ')}（不填则全量）\n`)
    }
  }

  // 代理干扰检测：流量被代理接管时，测出来的是到代理的延迟而不是到目标 IP 的，
  // 结果会「看起来正常」但导入客户端后大量 -1，因此必须提前提醒。
  // 只提醒不阻断 —— 用户可能确实需要走代理（例如域名在本地被污染）。
  // quiet 时不打印，但 --json 报告里要带上 —— 排查时最需要的信息恰恰是这个
  let envResult: Awaited<ReturnType<typeof detectProxyInterference>> | null = null
  if (!quiet || asJson) {
    const env = await detectProxyInterference(host)
    envResult = env
    if (!quiet && !asJson && !env.clean) {
      process.stdout.write('\n⚠️  检测到可能干扰优选的因素：\n')
      for (const f of env.findings) {
        process.stdout.write(`   ${f.message}\n`)
        process.stdout.write(`   → ${f.advice}\n`)
      }
      process.stdout.write('\n   优选测的是「本机直连该 IP」的真实质量。\n')
      process.stdout.write('   流量被代理接管时，结果看起来正常，但所有 IP 成绩趋于一致，\n')
      process.stdout.write('   导入客户端后大量 -1（因为从未真正直连验证过）。\n')
      process.stdout.write('   → 建议关闭代理工具（含 TUN 模式与系统代理）后重跑。\n')
      process.stdout.write('   → 或把本程序与待测 IP 段设为直连。\n\n')
    }
  }

  if (!quiet && !asJson) process.stdout.write('正在准备 Cloudflare 网段…\n')

  const candidatePlan = await resolveCandidatesFromArgs(args, [host, panelHost], port)
  const candidates = candidatePlan.candidates
  if (candidates.length === 0) {
    process.stderr.write(
      flagBool(args, 'from-pool')
        ? '本地候选池没有可取样条目，请先跑 `cfpilot source sync`（或去掉 --from-pool 用官方网段）\n'
        : '候选 IP 为空，请检查 --ip-file / --cidr 参数\n'
    )
    if (candidatePlan.ipv6Env && candidatePlan.ipv6Env.status !== 'ok') {
      process.stderr.write(`  ${candidatePlan.ipv6Env.message}\n`)
      for (const line of candidatePlan.ipv6Env.advice) process.stderr.write(`   · ${line}\n`)
    }
    process.exit(1)
  }
  if (!quiet && !asJson) {
    process.stdout.write(`候选 IP：${candidates.length} 个（IPv4 ${candidatePlan.counts.v4} / IPv6 ${candidatePlan.counts.v6}）\n`)
    process.stdout.write(`${candidatePlan.note}\n`)
    // 预检没过时把排查建议一并给出：用户看到「只扫了 IPv4」需要知道为什么
    if (candidatePlan.ipv6Env && candidatePlan.ipv6Env.status !== 'ok') {
      for (const line of candidatePlan.ipv6Env.advice) process.stdout.write(`   · ${line}\n`)
    }
  }

  /**
   * v6 结果**默认参与回填与可复制列表**（与桌面版一致）。
   *
   * 备注里带 `IPv4_` / `IPv6_` 族标记，订阅节点名因此自动分成
   * `优选IPv4_…` / `优选IPv6_…`，Clash 侧再按族分组 ——
   * 客户端没开 IPv6 时选 IPv4 组即可，不需要在优选器这层拦。
   * 只要「仅 IPv4」就用 `--family v4`。
   */
  const pushMode = pushModeFromArgs(args)

  // ---- 决定测速方式 ----
  //
  // 优先用目标项目自己的探针端点（最忠实），它不存在时**自动改用公开测速地址**，
  // 而不是直接跳过测速 —— 后者会让第三方项目的速度永远是 0。
  // 无论哪种方式，测速都只作用于已通过 101 校验的 IP，因此不会出现 -1 节点。
  let skipSpeed = noSpeed
  let speedMode: 'probe' | 'url' = 'probe'
  let speedUrl = flagString(args, 'speed-url', DEFAULT_SPEED_URL)
  /**
   * 阶段二是否做响应体内容校验。
   *
   * 初始值由 `--no-verify` 决定，但**预检发现目标没有探针端点时会自动关闭**：
   * 内容校验依赖探针端点的 PING/PONG 机制，第三方项目没有这个机制，
   * 硬发 PING 会一直等不到响应 → 阶段二全军覆没。
   *
   * 预检已经知道「没有探针」，此时再坚持严格校验毫无意义。
   */
  let verifyPayload = !flagBool(args, 'no-verify')
  /** 预检结论：目标是否有 CFPilot 风格的探针端点（null = 未预检） */
  let hasProbeEndpoint: boolean | null = null

  /**
   * 探测目标有没有 CFPilot 风格的探针端点。
   *
   * 结论被两处使用：
   *   1. 决定测速方式（探针端点 vs 公开测速地址）
   *   2. 决定要不要做响应体内容校验（没有探针端点就必然失败）
   *
   * 所以必须**无条件预检**（哪怕 --no-speed 也要做），
   * 否则「没有探针端点 + 内容校验开着」会得到 0 条结果。
   */
  const detectProbeEndpoint = async (): Promise<boolean | null> => {
    // 返回值语义：
    //   true  = 确认是 CFPilot 探针端点
    //   false = 确认不是（请求成功，但响应里没有 x-probe-bytes 头）
    //   null  = **不知道**（网络错误 / 超时）—— 此时不能降级！
    //
    // ⚠️ 区分 false 与 null 很重要：网络抖动导致的失败不代表「目标没有探针」，
    // 若据此关闭内容校验，阶段二会从「严格校验」退化成「只看 101」，
    // 反而放进来一批「101 通但不响应」的 IP。
    try {
      const probe = await fetch(`https://${host}${probePath}?bytes=1024`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      })
      return Boolean(probe.headers.get('x-probe-bytes'))
    } catch {
      return null
    }
  }

  // 显式 --no-verify 时不必预检（用户已经表态不要内容校验了）
  if (verifyPayload) {
    hasProbeEndpoint = await detectProbeEndpoint()
  }

  if (!skipSpeed) {
    const forcedMode = flagString(args, 'speed-mode') // 'probe' | 'url' | ''

    if (forcedMode === 'url') {
      speedMode = 'url'
      if (!quiet) process.stdout.write(`测速方式：公开测速地址（${speedUrl}）\n`)
    } else if (forcedMode === 'probe') {
      speedMode = 'probe'
    } else {
      // 自动：探测目标是否有 CFPilot 风格的探针端点
      if (hasProbeEndpoint === null) {
        hasProbeEndpoint = await detectProbeEndpoint()
      }
      const hasProbe = hasProbeEndpoint

      if (hasProbe) {
        speedMode = 'probe'
        if (!quiet) process.stdout.write('测速方式：项目探针端点（最忠实）\n')
      } else {
        speedMode = 'url'
        if (!quiet) {
          process.stdout.write(`\n提示：${probePath} 不是 CFPilot 探针端点，改用公开测速地址测速\n`)
          process.stdout.write('      （仍会先做 101 校验，因此不会选出连不上的 IP）\n')
        }
        speedUrl = await pickAvailableSpeedUrl(
          [speedUrl, ...SPEED_URL_PRESETS.map((p) => p.url)],
          quiet ? undefined : (m) => process.stdout.write(`      ${m}\n`)
        )
      }
    }
  }

  // ---- 内容校验自动降级 ----
  //
  // 预检已确认目标**没有**探针端点 → 内容校验（PING→PONG）必然失败，
  // 阶段二会全军覆没。此时退回纯 101 校验（--no-verify 的语义）。
  if (hasProbeEndpoint === false && verifyPayload) {
    verifyPayload = false
    if (!quiet) {
      process.stdout.write('\n提示：目标无探针端点，已自动关闭响应体校验（退回纯 101 校验）\n')
    }
  }

  const summary = await runScan({
    host,
    port,
    candidates,
    countries,
    probeTransport,
    xhttpPath,
    wsPath,
    probePath,
    skipSpeed,
    verifyPayload,
    concurrency: flagNumber(args, 'concurrency', 300),
    retries: flagNumber(args, 'retries', 2),
    tcpTimeoutMs: flagNumber(args, 'timeout', 1200),
    tlsConcurrency: flagNumber(args, 'tls-concurrency', 64),
    tlsTimeoutMs: flagNumber(args, 'tls-timeout', 2000),
    maxLatencyMs: flagNumber(args, 'max-latency', 0),
    probeLimit: flagNumber(args, 'probe-limit', 120),
    probeTimeoutMs: flagNumber(args, 'probe-timeout', 3000),
    speedLimit: flagNumber(args, 'speed-limit', 30),
    // 两轮测速：默认关闭（脚本行为不变），--two-stage-speed 开启。
    // 桌面版界面默认开启，两边语义一致：true = 全量短测粗排 + 前 N 精测。
    twoStageSpeed: flagBool(args, 'two-stage-speed'),
    coarseSpeedLimit: flagNumber(args, 'coarse-speed-limit', COARSE_SPEED_DEFAULTS.limit),
    coarseDurationMs: flagNumber(args, 'coarse-duration', COARSE_SPEED_DEFAULTS.durationMs),
    coarseConnections: flagNumber(args, 'coarse-conns', COARSE_SPEED_DEFAULTS.connections),
    coarseTimeoutMs: flagNumber(args, 'coarse-timeout', COARSE_SPEED_DEFAULTS.timeoutMs),
    coarseBudgetMs: flagNumber(args, 'coarse-budget', COARSE_SPEED_DEFAULTS.budgetMs),
    speedTimeoutMs: flagNumber(args, 'speed-timeout', 12000),
    speedBytes: flagNumber(args, 'speed-bytes', 5 * 1024 * 1024),
    speedMode,
    speedUrl,
    // 默认串行：带宽是共享资源，并行测多个候选会互相抢带宽（见 scan.ts 的 speedConcurrency 注释）
    speedConcurrency: flagNumber(args, 'speed-concurrency', 1),
    // 并发连接数：跨境链路上单条 TCP 受丢包 / 拥塞窗口限制。
    // 2026-10-28 直连实测同一个 IP：1 条 0.12 MB/s、3 条 0.47、8 条 1.15、16 条 2.22 ——
    // 用 3 条会系统性低估 2~4 倍。默认 8 条，贴近浏览器/客户端的真实多连接行为。
    //
    // ⚠️ 上限收窄到 8：实测（2026-11-02）并发 32 条、每条 5MiB 保持 6 秒也零失败，
    // 说明并发本身不会被平台卸载；但连接数越多，单轮流量越大（30 候选 × 8 连接 ≈ 1.2GB/轮），
    // 所以按「够用且不过量」封顶。与桌面版一致（maxMeasureConnections = 8）。
    speedConnections: Math.min(8, Math.max(1, flagNumber(args, 'speed-conns', 8))),
    // 测速时长：默认 6 秒，上限 10 秒（同样按流量收窄）。
    speedDurationMs: Math.min(10000, Math.max(2000, flagNumber(args, 'speed-duration', 6000))),
    // 真实隧道校验（可选）：给了凭据才会跑
    uuid: flagString(args, 'uuid'),
    trojanPassword: flagString(args, 'trojan-password'),
    verifyTargetHost: flagString(args, 'verify-target'),
    verifyTargetPort: flagNumber(args, 'verify-target-port', 80),
    speedRepeat: flagNumber(args, 'speed-repeat', 1),
    // 出口体检（可选）：需要 --uuid 做端点鉴权，按机房去重调用
    unlock: flagBool(args, 'unlock'),
    verifyWsPath: args.flags['no-verify-ws-path'] === undefined,
    top,
    onProgress: (event) => printProgress(event, quiet, asJson),
  })

  // 实验性：把本轮观测写回网络档案（仅在开启 --adaptive 时有档案）。
  await saveAdaptiveObservations(args, summary.observations)

  // ---- Phase 4：把完整优选结果回写本地池（只在 --from-pool 时）----
  // 池是本地历史，与 KV 回填解耦：即使没给 token、回填失败，历史也照记。
  const sampled = poolSamples.get(args)
  if (sampled && sampled.keys.length > 0) {
    const applied = await applyFullTestResults(sampled.keys, sampled.port, summary)
    if (!quiet && !asJson) {
      process.stdout.write(
        `本地池已回写：active ${applied.active} 条 / failed ${applied.failed} 条\n`
      )
    }
  }

  // 本次用于「可复制列表 + 回填」的条目（v4 与 v6 都进，族标记在备注里）
  const fillable = summary.entries

  if (asJson) {
    // 可复现报告：参数 + 种子 + 环境 + 失败分布 + 结果
    //
    // 只有「结果」没有「怎么跑出来的」，用户提问题时还是得靠截图和口头描述。
    // 这里把决定结果的全部输入都带上：同一个种子 + 同一组参数 = 同一份候选列表。
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tool: 'cfpilot',
          version: VERSION,
          seed: seedFromArgs(args) ?? null,
          params: {
            host,
            port,
            wsPath,
            probePath,
            probeTransport,
            xhttpPath,
            sample: flagNumber(args, 'sample', 6556),
            top,
            countries: summary.stats.countries,
            speedMode,
            speedLimit: flagNumber(args, 'speed-limit', 30),
            speedBytes: flagNumber(args, 'speed-bytes', 5 * 1024 * 1024),
            skipSpeed,
            verifyPayload,
            tunnelVerified: Boolean(flagString(args, 'uuid') || flagString(args, 'trojan-password')),
            // 地址族：请求值 / 解析后的实际值 / IPv6 环境预检结论 / 分族候选数
            familyRequested: familyFromArgs(args),
            familyResolved: candidatePlan.family,
            pushMode,
            candidatesByFamily: candidatePlan.counts,
            v6PrefixCount: candidatePlan.v6Prefixes.length,
            v6DiscoveredByAAAA: candidatePlan.v6Discovered,
            ipv6Env: candidatePlan.ipv6Env,
            candidateNote: candidatePlan.note,
            // 实验性：自适应采样的开关与档案（未开启时为 null，便于复现报告区分模式）
            adaptive: flagBool(args, 'adaptive')
              ? {
                  isp: normalizeIsp(flagString(args, 'isp')),
                  region: (flagString(args, 'region') ?? '').trim().slice(0, 32),
                  access: normalizeAccess(flagString(args, 'access')),
                  exploreRate: flagNumber(args, 'explore-rate', 20) / 100,
                }
              : null,
          },
          env: envResult,
          stats: summary.stats,
          entries: summary.entries,
        },
        null,
        2
      )}\n`
    )
  } else {
    printTable(summary.entries)
    printCopyable(fillable)
  }

  // ---- 回填 ----
  if (callback && token) {
    // 已明确给了 token：直接回填
    const result = await postResults(callback, token, formatEntries(fillable), pushMode)
    if (result.ok) {
      process.stdout.write(
        `\n✓ 已${pushMode === 'append' ? '增量回填' : '回填'} ${fillable.length} 条到面板\n`
      )
      if (pushMode === 'append') {
        process.stdout.write('  （面板里原有的优选 IP 已保留，只补入了新的）\n')
      }
    } else {
      process.stderr.write(`\n✗ 回填失败：${result.error}\n`)
      process.exitCode = 1
    }
  } else if (askCallback && !quiet && fillable.length > 0) {
    // 交互询问是否回填
    await promptCallback(fillable, host, panelHost, panelPassword, pushMode)
  } else if (!quiet && !asJson) {
    process.stdout.write('\n（未提供 --token，跳过回填）\n')
  }
}

/**
 * 扫描结束后询问是否回填，选 Y 则自动取令牌并回填。
 *
 * 令牌在**扫描结束后**才申请，10 分钟有效，不会因扫描耗时而过期。
 */
async function promptCallback(
  entries: ScanEntry[],
  dataHost: string,
  panelHost: string,
  panelPassword: string,
  mode: PushMode
): Promise<void> {
  const { createInterface } = await import('node:readline/promises')
  const { stdin, stdout } = await import('node:process')

  process.stdout.write('\n' + '─'.repeat(50) + '\n')

  if (!panelHost) {
    process.stdout.write('未配置控制面域名，无法回填。\n')
    process.stdout.write('→ 可手动复制上面的 IP 列表，粘贴到面板「手动优选 IP」\n')
    return
  }

  const rl = createInterface({ input: stdin, output: stdout })
  let answer = ''
  try {
    answer = (await rl.question(`是否回填这 ${entries.length} 条到面板？(y/N): `))
      .trim()
      .toLowerCase()
  } finally {
    rl.close()
  }

  if (answer !== 'y' && answer !== 'yes') {
    process.stdout.write('\n已跳过回填。\n')
    process.stdout.write('→ 上面的 IP 列表可直接复制，粘贴到面板「手动优选 IP」框\n')
    return
  }

  // 需要密码才能申请令牌
  let password = panelPassword
  if (!password) {
    const rl2 = createInterface({ input: stdin, output: stdout })
    try {
      password = (await rl2.question('面板密码（用于申请临时令牌）: ')).trim()
    } finally {
      rl2.close()
    }
  }
  if (!password) {
    process.stdout.write('\n未提供面板密码，已跳过回填。\n')
    process.stdout.write('→ 可手动复制上面的 IP 列表粘贴到面板\n')
    return
  }

  process.stdout.write('\n正在申请临时令牌…\n')
  const tk = await fetchScannerToken(panelHost, password)
  if (!tk.ok || !tk.token) {
    process.stdout.write(`✗ 获取令牌失败：${tk.error ?? '未知错误'}\n`)
    process.stdout.write('→ 可手动复制上面的 IP 列表粘贴到面板\n')
    return
  }
  process.stdout.write('✓ 已获取临时令牌（10 分钟有效）\n')

  const url = `https://${panelHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/v1/preferred-ips`
  process.stdout.write(`正在回填到 ${url} …\n`)
  const result = await postResults(url, tk.token, formatEntries(entries), mode)
  if (result.ok) {
    process.stdout.write(`\n✓ 已回填 ${entries.length} 条到面板「手动优选 IP」\n`)
    process.stdout.write('→ 打开面板「节点来源 → 手动优选 IP」点「查看」即可看到\n')
  } else {
    process.stdout.write(`\n✗ 回填失败：${result.error}\n`)
    process.stdout.write('→ 可手动复制上面的 IP 列表粘贴到面板\n')
  }
}
