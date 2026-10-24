/**
 * cfpilot-scanner —— CFPilot 本地真连接优选器
 *
 * 注意：不要在这里手写 shebang。
 * 构建脚本（scripts/build.mjs）会通过 esbuild banner 注入，
 * 两处都写会导致产物出现两行 #!，Node 只认第一行，直接语法报错。
 *
 * 用法：
 *   cfpilot-scanner scan --host <你的Worker域名> [--token <令牌>] [--callback <回填地址>]
 *   cfpilot-scanner serve [--port 19527]
 *   cfpilot-scanner ips
 */
import { readFileSync } from 'node:fs'
import { flagBool, flagList, flagNumber, flagString, parseArgs } from './args'
import { BUILTIN_IPV4_CIDRS, BUILTIN_IPV6_CIDRS, readIpFile } from './ip-ranges'
import { resolveCandidates } from './candidates'
import { detectProxyInterference, isMsysPollutedPath } from './net-env'
import {
  DEFAULT_SPEED_URL,
  SPEED_URL_PRESETS,
  pickAvailableSpeedUrl,
} from './speed-url'
import { formatEntries, runScan, type ScanEvent, type ScanEntry, formatCopyable } from './scan'
import { normalizeCountryFilter } from './countries'
import { postResults } from './callback'
import { BRIDGE_VERSION, DEFAULT_BRIDGE_PORT, startBridge } from './server'
import { NAME, VERSION } from './version'

const HELP = `
${NAME} v${VERSION}
CFPilot 本地真连接优选器 —— 用你自己的 Worker 域名做 SNI/Host，
完成 WebSocket 101 真连接校验，只保留真正可用的 IP。

用法:
  ${NAME} scan [选项]        执行三阶优选扫描（默认命令）
  ${NAME} serve [选项]       启动本地桥接服务（供面板一键唤醒）
  ${NAME} ips [选项]         打印 Cloudflare 官方网段
  ${NAME} --help             显示帮助
  ${NAME} --version          显示版本

scan 选项:
  --host <domain>        必填：你的 Worker 自定义域名（作为 TLS SNI 与 HTTP Host）
  --port <port>          端口，默认 443
  --token <token>        回填令牌（面板生成的一次性令牌或 SCANNER_TOKEN）
  --callback <url>       回填地址，默认 https://<host>/api/v1/preferred-ips
  --no-callback          只打印结果，不回填
  --path <path>          阶段二校验的 WebSocket 路径，默认 /__edge_probe
                         （对接其它项目时填它自己的 WS 路径，例如 /vless 或 /<uuid>）
  --probe-path <path>    probe 模式的测速路径，默认 /__edge_probe
  --speed-mode <mode>    测速方式：auto（默认）/ probe / url
                         auto  = 目标有探针端点就用它，否则自动改用公开测速地址
                         probe = 只用目标项目的探针端点（最忠实，要求对方有该端点）
                         url   = 只用公开测速地址（任何项目都能测）
  --speed-url <url>      公开测速地址，默认 ${DEFAULT_SPEED_URL}
                         可换成任意返回大文件的地址
  --speed-conns <n>      测速并发连接数，默认 3
                         单条 TCP 连接受拥塞窗口限制，多连接更接近真实带宽
  --speed-duration <ms>  测速时长，默认 6000
  --no-speed             跳过测速，只按延迟排序
  --top <n>              返回条数，默认 15
  --concurrency <n>      阶段一 TCP 并发，默认 300
  --tls-concurrency <n>  阶段一 TLS 握手并发，默认 64
                          TLS 握手是 CPU 密集型操作，过高会让本机成为瓶颈
  --sample <n>           候选 IP 采样数，默认 20000
                          建议 3000 起：阶段一按 TLS 握手耗时筛选，而握手快慢
                          与 TCP 延迟几乎无关（实测 TCP 9ms 的 IP 可能要 3.5 秒），
                          采样小了根本碰不到握手快的 IP
  --countries <a,b>      国家 / 地区过滤（可多选，逗号分隔，如 HK,JP,SG）
                         不选 = 全量。机房来自 101 握手响应；筛完为空会自动忽略
  --cidr <a,b>           自定义网段（可重复，用逗号分隔）
  --ip-file <path>       使用本地 IP 列表文件
  --max-latency <ms>     阶段一 TCP 延迟上限，默认 0（不限）
  --tls-timeout <ms>     阶段一 TLS 握手超时，默认 4000
  --probe-limit <n>      进入 101 校验的候选数，默认 120
  --speed-limit <n>      进入测速的候选数，默认 30
  --speed-bytes <n>      测速字节数，默认 5242880
  --timeout <ms>         阶段一超时，默认 1200
  --seed <n>             采样随机种子，默认 24301
  --json                 以 JSON 输出结果
  --quiet                仅输出结果

serve 选项:
  --port <port>          监听端口，默认 ${DEFAULT_BRIDGE_PORT}
  --host <addr>          监听地址，默认 127.0.0.1

示例:
  ${NAME} scan --host cfpilot.example.com --token abc123
  ${NAME} serve
`

/**
 * 校验并归一化 WS 路径。
 *
 * ## 为什么必须校验
 *
 * 在 Git-Bash / MSYS 下执行 `--path /vless` 时，MSYS 会把「看起来像 Unix 绝对
 * 路径」的参数自动转换成 Windows 路径，实际传入的是：
 *   `C:/Users/<用户名>/.../node_modules/@dsh-ops/bash-win32-x64/vless`
 * 结果就是：扫描跑完，一个 IP 都选不出来，而且**完全没有报错**，
 * 用户只会以为「这个工具不好用」。
 *
 * 因此这里直接拦住，并告诉用户怎么绕开（MSYS_NO_PATHCONV=1，或用 = 写法）。
 */
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.command && !args.command.startsWith('-') ? args.command : ''

  if (flagBool(args, 'h') || flagBool(args, 'help') || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (flagBool(args, 'v') || flagBool(args, 'version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  switch (command) {
    case 'serve':
      await commandServe(args)
      return
    case 'ips':
      commandIps(args)
      return
    case 'scan':
      await commandScan(args)
      return
    default:
      await commandScan(args)
  }
}

function commandIps(args: ReturnType<typeof parseArgs>): void {
  const includeIpv6 = !flagBool(args, 'no-ipv6')
  const cidrs = [...BUILTIN_IPV4_CIDRS, ...(includeIpv6 ? BUILTIN_IPV6_CIDRS : [])]
  process.stdout.write(`${cidrs.join('\n')}\n`)
}

async function commandServe(args: ReturnType<typeof parseArgs>): Promise<void> {
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
}

/**
 * 组装候选 IP 列表（CLI 参数 → 共享候选模块）
 *
 * --ip-file 的本地文件读取留在 CLI 侧，网段展开与官方列表拉取复用 candidates.ts，
 * 保证命令行扫描与面板一键优选走同一套生成逻辑。
 */
async function resolveCandidatesFromArgs(args: ReturnType<typeof parseArgs>): Promise<string[]> {
  const ipFile = flagString(args, 'ip-file')
  if (ipFile) {
    const text = readFileSync(ipFile, 'utf8')
    return readIpFile(text)
  }

  return resolveCandidates({
    sample: flagNumber(args, 'sample', 20000),
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
    const address = `${entry.ip}:${entry.port}`.padEnd(24, ' ')
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

async function commandScan(args: ReturnType<typeof parseArgs>): Promise<void> {
  const host = flagString(args, 'host')
  const quiet = flagBool(args, 'quiet')
  const asJson = flagBool(args, 'json')

  if (!host) {
    process.stderr.write('缺少 --host 参数（你的 Worker 自定义域名）\n')
    process.stderr.write('提示：npx -y cfpilot-scanner@latest --host "你的域名" --token "令牌"\n')
    process.exit(1)
  }

  const port = flagNumber(args, 'port', 443)
  const top = flagNumber(args, 'top', 15)
  const token = flagString(args, 'token')
  const noCallback = flagBool(args, 'no-callback')
  const wsPath = normalizeWsPath(flagString(args, 'path'), '/__edge_probe')
  const probePath = normalizeWsPath(flagString(args, 'probe-path'), '/__edge_probe')
  const noSpeed = flagBool(args, 'no-speed')
  // 国家过滤：不选 = 全量。无效代码在 normalizeCountryFilter 里被丢弃
  const countries = normalizeCountryFilter(flagList(args, 'countries'))
  const callback = noCallback
    ? ''
    : flagString(args, 'callback', token ? `https://${host}/api/v1/preferred-ips` : '')

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

  if (!skipSpeed) {
    const forcedMode = flagString(args, 'speed-mode') // 'probe' | 'url' | ''

    if (forcedMode === 'url') {
      speedMode = 'url'
      if (!quiet) process.stdout.write(`测速方式：公开测速地址（${speedUrl}）\n`)
    } else if (forcedMode === 'probe') {
      speedMode = 'probe'
    } else {
      // 自动：探测目标是否有 CFPilot 风格的探针端点
      let hasProbe = false
      try {
        const probe = await fetch(`https://${host}${probePath}?bytes=1024`, {
          method: 'GET',
          signal: AbortSignal.timeout(8000),
        })
        hasProbe = Boolean(probe.headers.get('x-probe-bytes'))
      } catch {
        hasProbe = false
      }

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

  const summary = await runScan({
    host,
    port,
    candidates,
    countries,
    wsPath,
    probePath,
    skipSpeed,
    concurrency: flagNumber(args, 'concurrency', 300),
    tcpTimeoutMs: flagNumber(args, 'timeout', 1200),
    tlsConcurrency: flagNumber(args, 'tls-concurrency', 64),
    tlsTimeoutMs: flagNumber(args, 'tls-timeout', 4000),
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

  if (callback && token) {
    const result = await postResults(callback, token, formatEntries(summary.entries))
    if (result.ok) {
      process.stdout.write(`\n✓ 已回填 ${summary.entries.length} 条到面板\n`)
    } else {
      process.stderr.write(`\n✗ 回填失败：${result.error}\n`)
      process.exitCode = 1
    }
  } else if (!quiet) {
    process.stdout.write('\n（未提供 --token，跳过回填）\n')
  }
}

main().catch((err) => {
  process.stderr.write(`执行失败：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
