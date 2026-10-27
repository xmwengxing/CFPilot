/**
 * 帮助菜单
 */

import { c, box, rule } from './ui'
import { NAME, VERSION } from '../shared/version'

export async function menuHelp(): Promise<void> {
  box(`${NAME} 帮助`, [`v${VERSION}`])
  process.stdout.write('\n')

  const sections: Array<[string, string[]]> = [
    [
      '常用子命令',
      [
        `${c.cyan('cfpilot')}                       进菜单`,
        `${c.cyan('cfpilot deploy')}                部署 Pages 双项目`,
        `${c.cyan('cfpilot scan')}                  本地优选`,
        `${c.cyan('cfpilot status')}                查看实例状态`,
        `${c.cyan('cfpilot token --check')}         检查 Token 权限`,
        `${c.cyan('cfpilot config')}                查看/修改配置`,
      ],
    ],
    [
      '优选常用参数',
      [
        `${c.gray('--host')} <数据面域名>           必填`,
        `${c.gray('--panel')} <控制面域名>          回填时需要`,
        `${c.gray('--panel-password')} <密码>       自动申请回填令牌`,
        `${c.gray('--sample')} <n>                  采样数，默认 6556`,
        `${c.gray('--no-speed')}                    跳过测速（快）`,
        `${c.gray('--top')} <n>                     返回条数，默认 15`,
        `${c.gray('--no-callback')}                 只输出不回填`,
      ],
    ],
    [
      '部署常用参数',
      [
        `${c.gray('--token')} <TOKEN>               API Token`,
        `${c.gray('--new-kv')}                      强制新建 KV（第 2+ 个实例）`,
        `${c.gray('--kv')} <id>                     指定 KV`,
        `${c.gray('--panel-password')} <密码>       设置面板密码`,
        `${c.gray('--dry-run')}                     只演示，不实际部署`,
        `${c.gray('--yes')}                         非交互模式`,
      ],
    ],
    [
      '配置文件',
      [`${c.gray('~/.cfpilot/config.json')}        保存 Token / 账号 / KV`],
    ],
  ]

  for (const [title, lines] of sections) {
    process.stdout.write(c.bold(title) + '\n')
    for (const line of lines) process.stdout.write(`  ${line}\n`)
    process.stdout.write('\n')
  }

  rule()
  process.stdout.write(`${c.gray('文档')} https://github.com/xmwengxing/CFPilot\n`)
}
