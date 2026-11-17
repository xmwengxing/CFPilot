/**
 * cfpilot mesh —— MobiHop 组网模块（+mesh 变体）的命令骨架。
 *
 * ⚠️ Phase 3a 骨架：本文件只实现命令分发 / help / 参数校验 / 留桩，
 *    **不含任何协议字节级实现**（帧编解码 / Noise / AEAD / 打洞 / 选路 / TUN）。
 *    协议实现在 Phase 3b，依赖 MobiHop 审计后的协议契约报告定稿。
 *    详见 docs/mesh-integration-plan.md §8。
 *
 * 与桌面版 +mesh 变体的关系：
 *   - 桌面版（`go build -tags=mesh`）内嵌 Go mesh 包，提供托盘/图形操作；
 *   - CLI 侧提供 `cfpilot mesh` 子命令，TUN 操作需管理员/root，以桌面版为主。
 */
import { flagBool, type ParsedArgs } from '../shared/args'

const MESH_HELP = `
cfpilot mesh —— MobiHop 组网（CFPilot +mesh 变体，骨架阶段）

⚠️ 当前版本为工程骨架：命令框架已就位，组网协议实现待 Phase 3b 完成。
   届时本命令将与 MobiHop 节点字节级互通（32B 帧 / Noise IKpsk2 / AEAD / 打洞 / 选路）。

用法:
  cfpilot mesh help                显示本帮助
  cfpilot mesh status              查看组网状态（待 3b）
  cfpilot mesh peers               查看对等节点（待 3b）
  cfpilot mesh up                  启动组网（需管理员/root；待 3b）
  cfpilot mesh down                停止组网（待 3b）
  cfpilot mesh invite              生成入网邀请（待 3b）
  cfpilot mesh join <uri>          加入网络（待 3b）

TUN 虚拟网卡需要管理员/root 权限；日常使用建议桌面版 +mesh 变体（图形引导提权）。
协议权威：E:\\Projects\\MobiHop（docs/MESH_INTEGRATION_CONTRACT.md）。
`

const SUBCOMMANDS = ['help', 'status', 'peers', 'up', 'down', 'invite', 'join'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

const PHASE_3B_NOTICE =
  'mesh 命令处于 Phase 3a 骨架阶段：协议实现（含与 MobiHop 节点互通）待 Phase 3b 完成。' +
  '当前仅验证命令分发与参数校验。'

export async function runMeshCommand(args: ParsedArgs): Promise<void> {
  const raw = (args.positionals[0] ?? 'help').toLowerCase()
  if (flagBool(args, 'h') || flagBool(args, 'help') || raw === 'help') {
    process.stdout.write(MESH_HELP)
    return
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(raw)) {
    process.stderr.write(`未知 mesh 动作：${raw}\n\n${MESH_HELP}`)
    process.exitCode = 1
    return
  }

  const sub = raw as Subcommand
  // join 需要额外参数，提前校验（骨架阶段也保证参数契约正确）
  if (sub === 'join' && !(args.positionals[1] ?? '').trim()) {
    process.stderr.write('mesh join 需要 <uri> 参数（mobihop://join/v1/...）\n')
    process.exitCode = 1
    return
  }

  // Phase 3b 之前：所有子命令只打印提示，不做真实组网。
  // 这样 CLI 的命令契约（分发 / 参数 / help）可提前验证，且不会误导用户以为已可用。
  process.stdout.write(`[mesh:${sub}] ${PHASE_3B_NOTICE}\n`)
}
