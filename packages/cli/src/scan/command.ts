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
  formatCopyable,
  formatHost,
  runScan,
  type ScanEntry,
  type ScanEvent,
} from './scan'
import { normalizeCountryFilter } from './countries'
import { formatEntries } from './scan'
import { postResults, fetchScannerToken } from './callback'
import { resolveCandidates } from './candidates'
import { readFileSync } from 'node:fs'
import { detectProxyInterference, isMsysPollutedPath } from './net-env'
import { NAME, VERSION } from '../shared/version'
import { SCAN_HELP } from './help'
import {
  DEFAULT_SPEED_URL,
  SPEED_URL_PRESETS,
  pickAvailableSpeedUrl,
} from './speed-url'
import { BUILTIN_IPV4_CIDRS, BUILTIN_IPV6_CIDRS, readIpFile } from './ip-ranges'

function normalizeWsPath(raw: string | undefined, fallback: string): string {
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
        '    2. 加环境变量：      MSYS_NO_PATHCONV=1 cfpilot-scanner scan ...\n' +
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

async function resolveCandidatesFromArgs(args: ParsedArgs): Promise<string[]> {
  const ipFile = flagString(args, 'ip-file')
  if (ipFile) {
    const text = readFileSync(ipFile, 'utf8')
    return readIpFile(text)
  }

  return resolveCandidates({
    sample: flagNumber(args, 'sample', 6556),
    cidr: flagList(args, 'cidr'),
    seed: flagNumber(args, 'seed', 24301),
  })
}

function printProgress(event: ScanEvent, quiet: boolean): void {
  if (quiet) return
  switch (event.type) {
    case 'stage':
      process.stdout.write(`\n▶ 阶段 ${event.stage}：${event.name}（共 ${event.total} 个候选）\n`)
      break
    case 'progress':
      if (event.message) process.stdout.write(`\r  ${event.message}`.padEnd(78))
      break
    case 'done':
      process.stdout.write(`\n✓ 优选完成，共 ${event.count} 条\n`)
      break
    case 'error':
      process.stdout.write(`\n✗ ${event.message}\n`)
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
  // scan 专属帮助
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(SCAN_HELP)
    return
  }

  // 二级子命令：ips / serve（通过第一个 positional 判断）
  const sub = args.positionals[0]
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
        '  现在可以在 CFPilot 面板点击「一键本地真连接优选」。',
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
   *    不必手动去面板点「生成令牌」。
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

  if (!quiet) {
    process.stdout.write(`\n${NAME} v${VERSION}\n`)
    process.stdout.write(`目标域名：${host}:${port}（将作为 TLS SNI 与 HTTP Host）\n`)
    process.stdout.write(`WS 路径：${wsPath}\n`)
    if (countries.length > 0) {
      process.stdout.write(`国家筛选：${countries.join(' / ')}（不填则全量）\n`)
    }
  }

  // 代理干扰检测：流量被代理接管时，测出来的是到代理的延迟而不是到目标 IP 的，
  // 结果会「看起来正常」但导入客户端后大量 -1，因此必须提前提醒。
  // 只提醒不阻断 —— 用户可能确实需要走代理（例如域名在本地被污染）。
  if (!quiet) {
    const env = await detectProxyInterference(host)
    if (!env.clean) {
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

  if (!quiet) process.stdout.write('正在准备 Cloudflare 网段…\n')

  const candidates = await resolveCandidatesFromArgs(args)
  if (candidates.length === 0) {
    process.stderr.write('候选 IP 为空，请检查 --ip-file / --cidr 参数\n')
    process.exit(1)
  }
  if (!quiet) process.stdout.write(`候选 IP：${candidates.length} 个\n`)

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
    speedTimeoutMs: flagNumber(args, 'speed-timeout', 12000),
    speedBytes: flagNumber(args, 'speed-bytes', 5 * 1024 * 1024),
    speedMode,
    speedUrl,
    speedConnections: flagNumber(args, 'speed-conns', 3),
    speedDurationMs: flagNumber(args, 'speed-duration', 6000),
    top,
    onProgress: (event) => printProgress(event, quiet),
  })

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ entries: summary.entries, stats: summary.stats }, null, 2)}\n`
    )
  } else {
    printTable(summary.entries)
    printCopyable(summary.entries)
  }

  // ---- 回填 ----
  if (callback && token) {
    // 已明确给了 token：直接回填
    const result = await postResults(callback, token, formatEntries(summary.entries))
    if (result.ok) {
      process.stdout.write(`\n✓ 已回填 ${summary.entries.length} 条到面板\n`)
    } else {
      process.stderr.write(`\n✗ 回填失败：${result.error}\n`)
      process.exitCode = 1
    }
  } else if (askCallback && !quiet && summary.entries.length > 0) {
    // 交互询问是否回填
    await promptCallback(summary.entries, host, panelHost, panelPassword)
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
  panelPassword: string
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
  const result = await postResults(url, tk.token, formatEntries(entries))
  if (result.ok) {
    process.stdout.write(`\n✓ 已回填 ${entries.length} 条到面板「手动优选 IP」\n`)
    process.stdout.write('→ 打开面板「节点来源 → 手动优选 IP」点「查看」即可看到\n')
  } else {
    process.stdout.write(`\n✗ 回填失败：${result.error}\n`)
    process.stdout.write('→ 可手动复制上面的 IP 列表粘贴到面板\n')
  }
}
