/**
 * 交互输入（零依赖，基于 node:readline + ANSI）
 *
 * 支持：方向键选择 / 多选 / 文本输入 / 密码（无回显）/ 确认
 * 非 TTY 环境自动降级为数字选择。
 */

import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { c, clearLine, displayWidth, hideCursor, showCursor, padEnd } from './ui'

export interface Choice<T = string> {
  label: string
  value: T
  hint?: string
  disabled?: boolean
}

/* ------------------------------------------------------------------ */
/* 文本输入                                                            */
/* ------------------------------------------------------------------ */

export interface AskOptions {
  /** 默认值（直接回车采用） */
  fallback?: string
  /** 是否允许为空 */
  allowEmpty?: boolean
  /** 密码模式：不回显 */
  password?: boolean
}

/** 读取一行输入。 */
export async function ask(question: string, options: AskOptions = {}): Promise<string> {
  const { fallback = '', allowEmpty = false, password = false } = options

  // 非 TTY：退化为同步读一行
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout })
    try {
      const answer = (await rl.question(`${question}: `)).trim()
      return answer || fallback
    } finally {
      rl.close()
    }
  }

  const suffix = fallback ? c.gray(` [${fallback}]`) : ''
  stdout.write(`${c.cyan('?')} ${question}${suffix}${c.gray(': ')}`)

  return await new Promise<string>((resolve) => {
    let buf = ''
    const wasRaw = stdin.isRaw

    const finish = (value: string): void => {
      stdin.removeListener('keypress', onKey)
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      stdout.write('\n')
      resolve(value)
    }

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (key?.ctrl && key.name === 'c') {
        showCursor()
        stdout.write('\n')
        process.exit(130)
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        const value = buf.trim()
        if (!value && !fallback && !allowEmpty) {
          // 必填项为空：提示后继续
          stdout.write(`\r${c.yellow('!')} 不能为空，请重新输入${c.gray(': ')}${password ? '' : buf}`)
          return
        }
        finish(value || fallback)
        return
      }
      if (key?.name === 'backspace') {
        buf = buf.slice(0, -1)
        if (!password) {
          stdout.write('\b \b')
        }
        return
      }
      if (key?.name === 'escape') {
        finish('')
        return
      }
      if (key?.ctrl && key.name === 'd') {
        finish('')
        return
      }
      if (str && !key?.ctrl && str >= ' ') {
        buf += str
        if (!password) stdout.write(str)
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    emitKeypressEvents(stdin)
    stdin.on('keypress', onKey)
  })
}

/* ------------------------------------------------------------------ */
/* 单选（方向键）                                                      */
/* ------------------------------------------------------------------ */

export interface SelectOptions<T> {
  /** 初始选中索引 */
  initial?: number
  /** 是否显示返回项（Esc 返回） */
  allowCancel?: boolean
}

/**
 * 方向键单选。
 *
 * 非 TTY 时降级为「输入序号」。
 */
export async function select<T>(
  question: string,
  choices: Choice<T>[],
  options: SelectOptions<T> = {}
): Promise<T | null> {
  if (choices.length === 0) return null

  // 非 TTY：数字选择
  if (!stdin.isTTY) {
    stdout.write(`${question}\n`)
    choices.forEach((ch, i) => {
      stdout.write(`  ${i + 1}) ${ch.label}${ch.hint ? `  ${ch.hint}` : ''}\n`)
    })
    const answer = await ask(`请输入序号 [1-${choices.length}]`, { fallback: '1' })
    const idx = Number(answer) - 1
    if (Number.isInteger(idx) && idx >= 0 && idx < choices.length) {
      return choices[idx]!.value
    }
    return choices[0]!.value
  }

  let cursor = options.initial ?? choices.findIndex((ch) => !ch.disabled)
  if (cursor < 0) cursor = 0

  const render = (first: boolean): void => {
    if (!first) {
      // 回到题目行并清空已绘制的选项
      stdout.write(`\x1b[${choices.length}A`)
    }
    for (let i = 0; i < choices.length; i++) {
      const ch = choices[i]!
      clearLine()
      if (ch.disabled) {
        stdout.write(`  ${c.gray('×')} ${c.gray(ch.label)}\n`)
        continue
      }
      if (i === cursor) {
        stdout.write(`  ${c.cyan('❯')} ${c.inverse(' ' + padEnd(ch.label, displayWidth(ch.label)) + ' ')}`)
        if (ch.hint) stdout.write(`  ${c.gray(ch.hint)}`)
        stdout.write('\n')
      } else {
        stdout.write(`    ${ch.label}`)
        if (ch.hint) stdout.write(`  ${c.gray(ch.hint)}`)
        stdout.write('\n')
      }
    }
  }

  stdout.write(`${c.cyan('?')} ${question} ${c.gray('(↑↓ 选择, Enter 确认, q 返回)')}\n`)
  hideCursor()
  render(true)

  return await new Promise<T | null>((resolve) => {
    const wasRaw = stdin.isRaw

    const finish = (value: T | null): void => {
      stdin.removeListener('keypress', onKey)
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      showCursor()
      resolve(value)
    }

    const move = (delta: number): void => {
      let next = cursor
      for (let i = 0; i < choices.length; i++) {
        next = (next + delta + choices.length) % choices.length
        if (!choices[next]!.disabled) break
      }
      cursor = next
      render(false)
    }

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (key?.ctrl && key.name === 'c') {
        showCursor()
        stdout.write('\n')
        process.exit(130)
      }
      if (key?.name === 'up' || key?.name === 'k') {
        move(-1)
        return
      }
      if (key?.name === 'down' || key?.name === 'j') {
        move(1)
        return
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        const picked = choices[cursor]
        if (picked && !picked.disabled) finish(picked.value)
        return
      }
      // Esc 或 q 返回（Esc 在部分终端需转义序列超时才触发，q 更可靠）
      if ((key?.name === 'escape' || str === 'q') && options.allowCancel !== false) {
        finish(null)
        return
      }
      // 数字快捷键：直接选第 N 项
      if (str && /^[1-9]$/.test(str)) {
        const idx = Number(str) - 1
        if (idx < choices.length && !choices[idx]!.disabled) {
          cursor = idx
          render(false)
          finish(choices[idx]!.value)
        }
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    emitKeypressEvents(stdin)
    stdin.on('keypress', onKey)
  })
}

/* ------------------------------------------------------------------ */
/* 多选（空格切换）                                                    */
/* ------------------------------------------------------------------ */

/** 方向键多选，空格切换，Enter 确认。 */
export async function multiSelect<T>(
  question: string,
  choices: Choice<T>[],
  options: { initial?: T[] } = {}
): Promise<T[]> {
  if (choices.length === 0) return []

  const selected = new Set<number>()
  if (options.initial) {
    for (const v of options.initial) {
      const idx = choices.findIndex((ch) => ch.value === v)
      if (idx >= 0) selected.add(idx)
    }
  }

  // 非 TTY：逗号分隔序号
  if (!stdin.isTTY) {
    stdout.write(`${question}\n`)
    choices.forEach((ch, i) => {
      stdout.write(`  ${i + 1}) ${ch.label}\n`)
    })
    const answer = await ask('请输入序号（逗号分隔，留空=全不选）', { allowEmpty: true })
    if (!answer.trim()) return []
    return answer
      .split(',')
      .map((s) => Number(s.trim()) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < choices.length)
      .map((i) => choices[i]!.value)
  }

  let cursor = 0

  const render = (first: boolean): void => {
    if (!first) stdout.write(`\x1b[${choices.length}A`)
    for (let i = 0; i < choices.length; i++) {
      const ch = choices[i]!
      const mark = selected.has(i) ? c.green('[x]') : c.gray('[ ]')
      clearLine()
      if (i === cursor) {
        stdout.write(`  ${c.cyan('❯')} ${mark} ${c.inverse(' ' + ch.label + ' ')}`)
        if (ch.hint) stdout.write(`  ${c.gray(ch.hint)}`)
        stdout.write('\n')
      } else {
        stdout.write(`    ${mark} ${ch.label}`)
        if (ch.hint) stdout.write(`  ${c.gray(ch.hint)}`)
        stdout.write('\n')
      }
    }
  }

  stdout.write(`${c.cyan('?')} ${question} ${c.gray('(↑↓ 移动, 空格选择, Enter 确认)')}\n`)
  hideCursor()
  render(true)

  return await new Promise<T[]>((resolve) => {
    const wasRaw = stdin.isRaw

    const finish = (): void => {
      stdin.removeListener('keypress', onKey)
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      showCursor()
      resolve([...selected].sort((a, b) => a - b).map((i) => choices[i]!.value))
    }

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (key?.ctrl && key.name === 'c') {
        showCursor()
        stdout.write('\n')
        process.exit(130)
      }
      if (key?.name === 'up' || key?.name === 'k') {
        cursor = (cursor - 1 + choices.length) % choices.length
        render(false)
        return
      }
      if (key?.name === 'down' || key?.name === 'j') {
        cursor = (cursor + 1) % choices.length
        render(false)
        return
      }
      if (str === ' ') {
        if (selected.has(cursor)) selected.delete(cursor)
        else selected.add(cursor)
        render(false)
        return
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        finish()
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    emitKeypressEvents(stdin)
    stdin.on('keypress', onKey)
  })
}

/* ------------------------------------------------------------------ */
/* 确认框                                                              */
/* ------------------------------------------------------------------ */

/** y/n 确认。 */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  const hint = fallback ? '[Y/n]' : '[y/N]'
  const answer = await ask(`${question} ${c.gray(hint)}`, { allowEmpty: true })
  const t = answer.trim().toLowerCase()
  if (!t) return fallback
  return t === 'y' || t === 'yes' || t === '是'
}

/** 等待用户按任意键。 */
export async function pause(text = '按 Enter 继续'): Promise<void> {
  await ask(c.gray(text), { allowEmpty: true })
}
