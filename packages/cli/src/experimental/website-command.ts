/** 显式实验命令；独立 JSON 输出供质量报告使用，不读写扫描历史。 */
import { flagBool, flagNumber, flagString, type ParsedArgs } from '../shared/args'
import { probeWebsites } from './website-compatibility'

const HELP = `
实验性网站兼容性检测（不参与默认 scan 或排序）

用法：cfpilot website-check --url https://用户指定网站/ [--proxy socks5://127.0.0.1:10808]

选项：
  --url <URL>           必填 HTTPS 目标，只请求这一地址
  --label <文本>        目标标签，默认 target
  --expected-text <文>  可选 UTF-8 正文标记，纯文本匹配
  --proxy <URL>         显式 SOCKS5 路径；省略时是本机直连基线
  --timeout <ms>        总超时，不超过 8000ms
  --help                显示帮助

代理凭据优先通过 CFPILOT_EGRESS_PROXY 环境变量提供，不读取识别 token 或账号凭据。
不会跟随重定向，不执行页面脚本、不登录、不解压、不宣称账号权限或完整解锁。
每次只识别指定传输路径，不绑定候选 IP；单响应最多 16 KiB。
`
export async function runWebsiteCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'help') || flagBool(args, 'h')) { process.stdout.write(HELP); return }
  if (!flagString(args, 'url') || args.flags['expected-text'] !== undefined && typeof args.flags['expected-text'] !== 'string' || args.flags.timeout !== undefined && typeof args.flags.timeout !== 'string') {
    process.stderr.write('需要 --url 和有效检测参数；运行 website-check --help 查看说明。\n')
    process.exitCode = 1
    return
  }
  const targets = await probeWebsites({
    targets: [{ label: flagString(args, 'label', 'target'), url: flagString(args, 'url'), expectedText: typeof args.flags['expected-text'] === 'string' ? args.flags['expected-text'] : undefined }],
    proxy: flagString(args, 'proxy') || process.env.CFPILOT_EGRESS_PROXY,
    timeoutMs: args.flags.timeout === undefined ? undefined : flagNumber(args, 'timeout', Number.NaN),
  })
  process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`)
  if (targets.some((result) => result.status !== 'ok')) process.exitCode = 1
}
