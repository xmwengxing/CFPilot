/**
 * cfpilot deploy 子命令入口
 */

import type { ParsedArgs } from '../shared/args'
import { runDeployCommand } from './command'

export async function runDeploy(args: ParsedArgs): Promise<void> {
  await runDeployCommand(args)
}
