/** 显式实验命令；凭据只从环境变量读取，避免进入命令行历史。 */
import { flagBool, flagNumber, flagString, type ParsedArgs } from '../shared/args'
import { identifyEgress } from './egress-identity'

const HELP = `
实验性出口识别（不参与默认 scan 或候选排序）

用法：cfpilot egress-identify --url https://自有服务/identify [--proxy socks5://127.0.0.1:10808]

选项：
  --url <URL>          用户自有 HTTPS 识别服务（必填）
  --proxy <URL>        显式指定 SOCKS5 路径；省略时只测本机直连基线
  --timeout <ms>       总超时，可缩短但不超过 8000ms
  --help              显示帮助

可选环境变量：
  CFPILOT_EGRESS_TOKEN             服务端签发的专用短期 Bearer token
  CFPILOT_EGRESS_TOKEN_EXPIRES_AT  RFC3339 过期时间，剩余有效期须在五分钟以内
  CFPILOT_EGRESS_PROXY            SOCKS5 地址（含凭据时应优先用此项）

仅识别指定传输路径，不绑定扫描候选 IP，不证明逐候选入口或 Worker 出口差异。
不上传 UUID、面板密码或 Cloudflare Token；识别服务会看到该路径的源 IP。
`

export async function runEgressIdentityCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'help') || flagBool(args, 'h')) { process.stdout.write(HELP); return }
  const url = flagString(args, 'url')
  if (!url || (args.flags.timeout !== undefined && typeof args.flags.timeout !== 'string')) {
    process.stderr.write('需要 --url，并使用有效的 --timeout 数值；运行 egress-identify --help 查看协议。\n')
    process.exitCode = 1
    return
  }
  const result = await identifyEgress({
    url,
    proxy: flagString(args, 'proxy') || process.env.CFPILOT_EGRESS_PROXY,
    token: process.env.CFPILOT_EGRESS_TOKEN,
    tokenExpiresAt: process.env.CFPILOT_EGRESS_TOKEN_EXPIRES_AT,
    timeoutMs: args.flags.timeout === undefined ? undefined : flagNumber(args, 'timeout', Number.NaN),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}
