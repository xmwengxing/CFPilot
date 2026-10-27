/**
 * cfpilot scan 子命令入口
 */

import type { ParsedArgs } from '../shared/args'
import { runScanCommand } from './command'

export async function runScan(args: ParsedArgs): Promise<void> {
  await runScanCommand(args)
}
