/**
 * `cfpilot test` —— 只测一个 IP 的完整链路
 *
 * 与 `cfpilot scan` 的区别：scan 是「从几千个候选里挑最好的」，
 * test 是「这一个到底行不行」。日常排障用后者。
 */
import { flagBool, flagNumber, flagString, type ParsedArgs } from '../shared/args'
import { NAME } from '../shared/version'
import { runSingleTest, summarizeStages, type StageResult } from './single'

const HELP = `
${NAME} test —— 测试单个 IP 的完整链路

用法:
  ${NAME} test --host <数据面域名> --ip <IP> [选项]

必填:
  --host <domain>        数据面域名（作为 TLS SNI 与 HTTP Host）
  --ip <address>         要测试的 IP（IPv6 直接写，不加方括号）

选项:
  --port <port>          端口，默认 443
  --path <path>          WebSocket 校验路径，默认 /__edge_probe
  --timeout <ms>         单阶段超时，默认 4000
  --speed                额外做下行测速（会消耗流量，默认关闭）
  --speed-bytes <n>      测速请求字节数，默认 5242880（5 MiB）
  --uuid <uuid>          真实隧道校验用的 VLESS UUID
  --trojan-password <pw> 真实隧道校验用的 Trojan 口令（与 --uuid 二选一）
  --verify-target <host> 隧道校验访问的目标，默认 baidu.com
  --json                 以 JSON 输出（便于脚本处理）
  -h, --help             显示本帮助

示例:
  ${NAME} test --host cf.example.com --ip 104.16.1.1
  ${NAME} test --host cf.example.com --ip 104.16.1.1 --speed --uuid <UUID>

说明:
  阶段顺序与客户端真实建连一致：TCP → TLS → WS 101 → PONG → 测速 → 隧道。
  前一阶段失败即停止（后面的阶段依赖它，继续跑只会得到一串「也失败」）。
`

function mark(ok: boolean): string {
  return ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
}

function printStage(result: StageResult): void {
  const parts = [`  ${mark(result.ok)} ${result.stage}`]
  if (result.ms !== undefined) parts.push(`${result.ms} ms`)
  if (result.detail) parts.push(result.detail)
  if (result.error) parts.push(`\x1b[31m${result.error}\x1b[0m`)
  process.stdout.write(parts.join('  ') + '\n')
}

export async function runTestCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(HELP)
    return
  }

  const host = flagString(args, 'host').trim()
  const ip = flagString(args, 'ip').trim()
  if (!host || !ip) {
    process.stderr.write('缺少参数：--host 与 --ip 都是必填\n\n' + HELP)
    process.exitCode = 1
    return
  }

  const port = flagNumber(args, 'port', 443)
  if (port < 1 || port > 65535) {
    process.stderr.write(`端口 ${port} 超出范围（1-65535）\n`)
    process.exitCode = 1
    return
  }

  const asJson = flagBool(args, 'json')
  const options = {
    ip,
    port,
    host,
    path: flagString(args, 'path', '/__edge_probe'),
    timeoutMs: flagNumber(args, 'timeout', 4000),
    speed: flagBool(args, 'speed'),
    speedBytes: flagNumber(args, 'speed-bytes', 5 * 1024 * 1024),
    uuid: flagString(args, 'uuid').trim() || undefined,
    trojanPassword: flagString(args, 'trojan-password').trim() || undefined,
    verifyTargetHost: flagString(args, 'verify-target', 'baidu.com'),
    verifyTargetPort: flagNumber(args, 'verify-target-port', 80),
  }

  if (!asJson) {
    process.stdout.write(`\n测试 ${ip}:${port} → ${host}${options.path}\n\n`)
  }

  const results = await runSingleTest({
    ...options,
    onStage: asJson ? undefined : printStage,
  })

  const summary = summarizeStages(results)

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ip, port, host, path: options.path, results, summary }, null, 2)}\n`
    )
  } else {
    process.stdout.write(`\n结论：${summary}\n`)
  }

  if (results.some((r) => !r.ok)) process.exitCode = 1
}
