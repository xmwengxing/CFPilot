/**
 * 数据面实现选择测试。
 *
 * 覆盖 `DATAPLANE` 环境变量在 vendor（默认）与自研之间的切换。
 */
import { describe, expect, it } from 'vitest'
import { resolveDataPlaneImpl } from '../src/protocols/dataplane'

describe('数据面实现选择', () => {
  it('默认走自研（2026-10-23 起）', () => {
    // 同环境对照实验已确认两者可用性持平，自研另有诊断 / 代理池 / DoH 优选等能力
    expect(resolveDataPlaneImpl()).toBe('self')
    expect(resolveDataPlaneImpl('')).toBe('self')
    expect(resolveDataPlaneImpl('   ')).toBe('self')
  })

  it('DATAPLANE=vendor 切回 CFNext 原版', () => {
    expect(resolveDataPlaneImpl('vendor')).toBe('vendor')
    expect(resolveDataPlaneImpl('VENDOR')).toBe('vendor')
    expect(resolveDataPlaneImpl(' cfnext ')).toBe('vendor')
    expect(resolveDataPlaneImpl('next')).toBe('vendor')
  })

  it('DATAPLANE=self 显式指定自研', () => {
    expect(resolveDataPlaneImpl('self')).toBe('self')
    expect(resolveDataPlaneImpl('SELF')).toBe('self')
    expect(resolveDataPlaneImpl(' self-developed ')).toBe('self')
    expect(resolveDataPlaneImpl('custom')).toBe('self')
  })

  it('未知取值回落到默认（自研），不猜成 vendor', () => {
    expect(resolveDataPlaneImpl('unknown')).toBe('self')
    expect(resolveDataPlaneImpl('vendor')).toBe('vendor')
  })
})
