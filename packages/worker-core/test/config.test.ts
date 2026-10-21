import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, configFromEnv, loadConfig, mergeConfig, saveConfig } from '../src/config'
import { MemoryStore } from '../src/store'
import type { Env } from '../src/types'

describe('configFromEnv', () => {
  it('环境变量覆盖默认值', () => {
    const env = { UUID: 'env-uuid', DLS: '25', TCP_CONCURRENT_DIAL: 'false' } as unknown as Env
    const config = configFromEnv(env)
    expect(config.uuid).toBe('env-uuid')
    expect(config.dls).toBe(25)
    expect(config.concurrentDial).toBe(false)
  })

  it('未提供的项回落到默认值', () => {
    const config = configFromEnv({} as Env)
    expect(config.wsPath).toBe(DEFAULT_CONFIG.wsPath)
    expect(config.concurrentDial).toBe(true)
  })
})

describe('mergeConfig', () => {
  it('KV 覆盖环境变量', () => {
    const merged = mergeConfig(configFromEnv({ UUID: 'env' } as Env), { uuid: 'kv' })
    expect(merged.uuid).toBe('kv')
  })

  it('忽略 undefined 值', () => {
    const merged = mergeConfig(configFromEnv({ UUID: 'env' } as Env), { uuid: undefined })
    expect(merged.uuid).toBe('env')
  })

  it('非法数值回落到 0', () => {
    const merged = mergeConfig(configFromEnv({} as Env), { dls: 'abc' as unknown as number })
    expect(merged.dls).toBe(0)
  })

  it('校验订阅协议枚举', () => {
    expect(mergeConfig(configFromEnv({} as Env), { subProtocol: 'vless' }).subProtocol).toBe('vless')
    expect(mergeConfig(configFromEnv({} as Env), { subProtocol: 'nope' as never }).subProtocol).toBe('both')
  })
})

describe('loadConfig', () => {
  it('首次加载自动生成 UUID 与 Trojan 密码并写回', async () => {
    const store = new MemoryStore()
    const config = await loadConfig(store, {} as Env)
    expect(config.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(config.trojanPassword.length).toBeGreaterThan(8)

    const second = await loadConfig(store, {} as Env)
    expect(second.uuid).toBe(config.uuid)
  })

  it('已保存的配置优先于自动生成', async () => {
    const store = new MemoryStore()
    const base = await loadConfig(store, {} as Env)
    await saveConfig(store, { ...base, uuid: 'saved-uuid' })
    const loaded = await loadConfig(store, {} as Env)
    expect(loaded.uuid).toBe('saved-uuid')
  })
})
