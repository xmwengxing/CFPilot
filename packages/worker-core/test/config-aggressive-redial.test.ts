/**
 * `aggressiveRedial` 的三层优先级与布尔归一化 —— 回归测试。
 *
 * 新增布尔配置项最容易踩的坑：`mergeConfig` 的布尔白名单漏登记时，
 * KV 里的 `true` 会落到 `String(value)` 分支变成字符串 `"true"`，
 * 而 `"true"` 在 `=== true` 判断里恒为 false —— 开关静默失效。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, configFromEnv, mergeConfig } from '../src/config'
import type { Env } from '../src/types'

describe('aggressiveRedial 配置优先级', () => {
  it('默认关闭（保守：只修直连假活）', () => {
    expect(DEFAULT_CONFIG.aggressiveRedial).toBe(false)
    expect(configFromEnv({} as Env).aggressiveRedial).toBe(false)
  })

  it('环境变量可开启', () => {
    expect(
      configFromEnv({ AGGRESSIVE_REDIAL: 'true' } as unknown as Env).aggressiveRedial
    ).toBe(true)
    expect(
      configFromEnv({ AGGRESSIVE_REDIAL: '1' } as unknown as Env).aggressiveRedial
    ).toBe(true)
    expect(
      configFromEnv({ AGGRESSIVE_REDIAL: 'off' } as unknown as Env).aggressiveRedial
    ).toBe(false)
  })

  it('KV 覆盖环境变量，且合并后仍是布尔而不是字符串', () => {
    const fromEnv = configFromEnv({ AGGRESSIVE_REDIAL: 'true' } as unknown as Env)
    const merged = mergeConfig(fromEnv, { aggressiveRedial: false })
    expect(merged.aggressiveRedial).toBe(false)
    expect(typeof merged.aggressiveRedial).toBe('boolean')

    const enabled = mergeConfig(configFromEnv({} as Env), { aggressiveRedial: true })
    expect(enabled.aggressiveRedial).toBe(true)
    expect(typeof enabled.aggressiveRedial).toBe('boolean')
  })
})
