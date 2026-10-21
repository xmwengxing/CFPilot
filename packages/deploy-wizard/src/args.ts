/**
 * 轻量命令行参数解析（零依赖）
 */

export interface ParsedArgs {
  command: string
  flags: Record<string, string | boolean>
  positionals: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let command = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[arg.slice(1)] = next
        i++
      } else {
        flags[arg.slice(1)] = true
      }
      continue
    }
    if (!command) {
      command = arg
    } else {
      positionals.push(arg)
    }
  }

  return { command, flags, positionals }
}

export function flagString(args: ParsedArgs, key: string, fallback = ''): string {
  const value = args.flags[key]
  return typeof value === 'string' ? value : fallback
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  const value = args.flags[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
  return false
}
