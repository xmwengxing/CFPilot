/**
 * CFPilot CLI 入口
 *
 * 两种使用方式：
 *   cfpilot               → 交互菜单
 *   cfpilot <子命令> ...   → 直接执行（供自动化脚本）
 */

import { parseArgs, flagBool } from './shared/args'
import { NAME, VERSION } from './shared/version'

const HELP = `
${NAME} v${VERSION}
Cloudflare Pages 代理部署与优选工具

用法:
  ${NAME}                     交互菜单（推荐首次使用）
  ${NAME} deploy [选项]       部署 Pages 双项目
  ${NAME} scan [选项]         本地真连接优选
  ${NAME} status              查看当前实例状态
  ${NAME} token [选项]        检查 API Token 权限
  ${NAME} config [选项]       查看/修改本地配置
  ${NAME} --help              显示帮助
  ${NAME} --version           显示版本

示例:
  ${NAME}                                  # 进菜单，按提示操作
  ${NAME} deploy --token <TOKEN>           # 直接部署
  ${NAME} scan --host <数据面域名>          # 直接优选
  ${NAME} scan --host x --panel y --panel-password z   # 优选并回填

文档: https://github.com/xmwengxing/CFPilot
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.command

  // 全局标志
  if (flagBool(args, 'v') || flagBool(args, 'version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  // 全局帮助只在无子命令时显示；有子命令时交给子命令（各有专属帮助）
  if (!command && (flagBool(args, 'h') || flagBool(args, 'help'))) {
    process.stdout.write(HELP)
    return
  }
  if (command === 'help') {
    process.stdout.write(HELP)
    return
  }

  // 子命令分发
  switch (command) {
    case '':
    case 'menu': {
      const { runMenu } = await import('./menu/main')
      await runMenu()
      return
    }
    case 'deploy': {
      const { runDeployCommand } = await import('./deploy/command')
      await runDeployCommand(args)
      return
    }
    case 'scan': {
      const { runScanCommand } = await import('./scan/command')
      await runScanCommand(args)
      return
    }
    case 'status': {
      const { runStatus } = await import('./menu/status')
      await runStatus()
      return
    }
    case 'token': {
      const { runTokenCheck } = await import('./deploy/token-command')
      await runTokenCheck(args)
      return
    }
    case 'config': {
      const { runConfig } = await import('./menu/config')
      await runConfig(args)
      return
    }
    default: {
      process.stderr.write(`未知命令：${command}\n\n`)
      process.stderr.write(HELP)
      process.exitCode = 1
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\n出错：${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
