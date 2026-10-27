/**
 * 终端 UI 渲染（零依赖）
 *
 * 颜色与光标控制。非 TTY 或 NO_COLOR 时自动降级为纯文本。
 */

/** 是否启用颜色（非 TTY / NO_COLOR / TERM=dumb 时关闭）。 */
export const useColor: boolean = (() => {
  if (process.env.NO_COLOR) return false
  if (process.env.TERM === 'dumb') return false
  if (!process.stdout.isTTY) return false
  // Windows 旧版 ConHost 也支持 ANSI（Win10+）
  return true
})()

function wrap(open: string, close: string) {
  return (s: string): string => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s)
}

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  inverse: wrap('7', '27'),
}

/** 清屏并回到左上角。 */
export function clearScreen(): void {
  if (!process.stdout.isTTY) return
  process.stdout.write('\x1b[2J\x1b[H')
}

/** 隐藏光标（菜单期间避免闪烁）。 */
export function hideCursor(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25l')
}

/** 恢复光标。 */
export function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h')
}

/** 上移 n 行并清空（用于原地重绘）。 */
export function moveUp(n: number): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(`\x1b[${n}A`)
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[2K')
    if (i < n - 1) process.stdout.write('\x1b[1B')
  }
  if (n > 1) process.stdout.write(`\x1b[${n - 1}A`)
}

/** 清空当前行。 */
export function clearLine(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2K\r')
}

/** 可视宽度（中文/全角按 2 计）。 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    // CJK / 全角标点 / emoji 按 2 宽
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

/** 按可视宽度右填充空格。 */
export function padEnd(s: string, width: number): string {
  const gap = width - displayWidth(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

/** 画一个标题框。 */
export function box(title: string, lines: string[] = [], width = 52): void {
  const inner = width - 2
  process.stdout.write('┌' + '─'.repeat(inner) + '┐\n')
  process.stdout.write('│ ' + padEnd(c.bold(title), inner - 2) + ' │\n')
  if (lines.length > 0) {
    process.stdout.write('├' + '─'.repeat(inner) + '┤\n')
    for (const line of lines) {
      process.stdout.write('│ ' + padEnd(line, inner - 2) + ' │\n')
    }
  }
  process.stdout.write('└' + '─'.repeat(inner) + '┘\n')
}

/** 分隔线。 */
export function rule(width = 52): void {
  process.stdout.write(c.gray('─'.repeat(width)) + '\n')
}

/** 状态图标。 */
export const icon = {
  ok: () => c.green('✓'),
  fail: () => c.red('✗'),
  warn: () => c.yellow('!'),
  info: () => c.cyan('·'),
  arrow: () => c.cyan('›'),
}

/** 打印一行状态。 */
export function status(kind: 'ok' | 'fail' | 'warn' | 'info', text: string): void {
  process.stdout.write(`${icon[kind]()} ${text}\n`)
}
