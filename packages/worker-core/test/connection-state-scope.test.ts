/**
 * 连接级状态的作用域护栏。
 *
 * 2026-11-08 的外部审计报告把混淆产物里提升为顶层 `var` 的模块级常量，
 * 误读成「上行缓存 / 下行字节计数是全局共享」并据此提出 P0 重构。
 * 回源码核对后确认是误报，但这类「重构时顺手把局部变量提到模块级」
 * 的事故完全可能真的发生，而且真机上表现为跨连接串线 —— 用测试钉住边界。
 *
 * 唯一的模块级可变 let 是 `retainedTotalBytes`：AGENTS §37 规定的
 * isolate 级 32 MiB 留存配额，retain()/clearRetained() 必须配平。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  fileURLToPath(new URL('../src/protocols/websocket-self.ts', import.meta.url)),
  'utf8'
)
const MARKER = 'export async function handleWebSocket('
const start = source.indexOf(MARKER)
const head = source.slice(0, start)
const body = source.slice(start)

describe('连接级状态的作用域护栏', () => {
  it('handleWebSocket 存在', () => {
    expect(start).toBeGreaterThan(0)
  })

  it('模块级可变 let 只有 isolate 配额计数器', () => {
    const moduleLets = [...head.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
    expect(moduleLets).toEqual(['retainedTotalBytes'])
  })

  it('连接级状态全部声明在函数体内，模块级一个都没有', () => {
    const names = ['retained', 'retainedBytes', 'downlinkBytes', 'relayRedialCount']
    for (const name of names) {
      const decl = new RegExp(`\\b(?:let|const)\\s+${name}\\b`)
      expect(body).toMatch(decl)
      expect(head).not.toMatch(decl)
    }
  })

  it('isolate 配额的增减配平同时存在', () => {
    expect(source).toMatch(/retainedTotalBytes\s*\+=/)
    expect(source).toMatch(/retainedTotalBytes\s*=\s*Math\.max\(0,\s*retainedTotalBytes\s*-/)
  })
})
