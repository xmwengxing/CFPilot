/**
 * `cfpilot vps` —— 在自己的 VPS 上一键部署 SOCKS5 落地代理
 *
 * ## 为什么需要它
 *
 * Cloudflare Worker 的出口是数据中心 IP，Netflix / 银行 / Google 登录页
 * 对这类 IP 的风控是结构性的 —— 任何「检测类」功能都只能告诉你不行，
 * 只有换出口才能让它行。
 *
 * ## 为什么不内置 SSH 实现
 *
 * 铁律 8：CLI 零运行时依赖。SSH 客户端交给系统自带的 `ssh`
 * （Windows 10+ / macOS / 主流 Linux 都有），我们只负责把脚本喂过去。
 *
 * ## 三种用法
 *
 *   cfpilot vps                      生成脚本 + 打印手动执行命令（最保险）
 *   cfpilot vps --ssh root@1.2.3.4   直接 ssh 过去执行（需要本机能免密或手输密码）
 *   cfpilot vps --print              只把脚本打到标准输出，便于自己审计
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flagBool, flagNumber, flagString, type ParsedArgs } from '../shared/args'
import { NAME } from '../shared/version'

const HELP = `
${NAME} vps —— 在自己的 VPS 上部署 SOCKS5 落地代理

用法:
  ${NAME} vps [选项]

选项:
  --ssh <user@host>   直接通过系统 ssh 远程执行（需本机有 ssh 客户端）
  --port <端口>       SOCKS5 监听端口，默认 1080
  --out <路径>        脚本落地路径，默认 ./cfpilot-vps-socks5.sh
  --print             只把脚本输出到标准输出（自己审计 / 手工执行）
  -h, --help          显示本帮助

说明:
  部署完成后会打印一行 socks5://用户名:口令@IP:端口，
  粘进 CFPilot 面板「出站与高级」的 SOCKS5 输入框即可。

  脚本做的事：装 sing-box → 生成随机用户名/口令 → 起带认证的 SOCKS5
  → 注册 systemd 服务 → 打印连接串。仅支持 Debian/Ubuntu/CentOS 系。

  为什么需要它：Worker 的出口是机房 IP，流媒体与部分站点对机房 IP
  有结构性风控；换一个自己的出口比任何「解锁检测」都有效。

示例:
  ${NAME} vps --ssh root@203.0.113.10
  ${NAME} vps --print > deploy.sh
`

/** 读取随包发布的脚本（构建期由 sync-asset.mjs 复制进 assets/） */
function loadScript(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // 产物结构：dist/cli.js + assets/vps-socks5.sh
  const candidates = [
    resolve(here, '../assets/vps-socks5.sh'),
    resolve(here, '../../assets/vps-socks5.sh'),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  throw new Error('内置脚本缺失（assets/vps-socks5.sh），请重新安装或升级 cfpilot')
}

/** 把 `--port` 注入脚本默认值（脚本自己也支持 --port 参数） */
function withPort(script: string, port: number | undefined): string {
  if (!port || !Number.isInteger(port) || port <= 0 || port > 65535) return script
  return script.replace(/^PORT=1080$/m, `PORT=${port}`)
}

function runSsh(host: string, script: string): Promise<number> {
  return new Promise((resolvePromise) => {
    // `bash -s` 从 stdin 读脚本；`-t` 分配终端，让脚本里的 sudo 能提示密码
    const child = spawn('ssh', ['-t', '-o', 'StrictHostKeyChecking=accept-new', host, 'bash -s'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          '\n本机没有找到 ssh 客户端。\n' +
            '· Windows：设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」\n' +
            '· 或者改用：cfpilot vps（生成脚本后手动 scp 到 VPS 执行）\n\n'
        )
      } else {
        process.stderr.write(`\nssh 启动失败：${err.message}\n`)
      }
      resolvePromise(1)
    })
    child.on('close', (code) => resolvePromise(code ?? 1))
    child.stdin.write(script)
    child.stdin.end()
  })
}

export async function runVpsCommand(args: ParsedArgs): Promise<void> {
  if (flagBool(args, 'h') || flagBool(args, 'help')) {
    process.stdout.write(HELP)
    return
  }

  const port = flagNumber(args, 'port', 0)
  const script = withPort(loadScript(), port > 0 ? port : undefined)

  if (flagBool(args, 'print')) {
    process.stdout.write(script)
    return
  }

  const sshHost = flagString(args, 'ssh').trim()
  if (sshHost) {
    process.stdout.write(`\n正在通过 ssh 在 ${sshHost} 上执行部署脚本…\n`)
    process.stdout.write('（首次连接会提示确认主机指纹；脚本需要 root，必要时会要求输入 sudo 密码）\n\n')
    const code = await runSsh(sshHost, script)
    if (code !== 0) {
      process.stderr.write(`\n远程执行失败（退出码 ${code}）。可改用 cfpilot vps 生成脚本后手动执行。\n`)
      process.exitCode = code
    }
    return
  }

  const out = resolve(process.cwd(), flagString(args, 'out') ?? 'cfpilot-vps-socks5.sh')
  writeFileSync(out, script, { mode: 0o755 })

  process.stdout.write(
    `\n已生成脚本：${out}\n\n` +
      '接下来二选一：\n\n' +
      '  ① 有 ssh 客户端（推荐）\n' +
      '     scp cfpilot-vps-socks5.sh root@你的VPS_IP:/tmp/\n' +
      '     ssh -t root@你的VPS_IP "bash /tmp/cfpilot-vps-socks5.sh"\n\n' +
      '  ② 在 VPS 上手动执行\n' +
      '     把脚本传上去，然后：sudo bash /tmp/cfpilot-vps-socks5.sh\n\n' +
      '跑完会打印一行 socks5://用户名:口令@IP:端口，\n' +
      '粘进 CFPilot 面板「出站与高级」→ SOCKS5 即可。\n\n' +
      `提示：也可以直接 ${NAME} vps --ssh root@你的VPS_IP，由本工具代跑。\n\n`
  )
}
