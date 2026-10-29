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

  it('未设置环境变量时，优选数量必须是默认值而不是 0', () => {
    // 回归测试：早期 num() 用 Number('') 得到 0，使 officialCount/domainCount 变 0，
    // 订阅里一个节点都不生成（线上事故：三个订阅地址全部"不可用"）。
    const config = configFromEnv({} as Env)
    expect(config.officialCount).toBe(DEFAULT_CONFIG.officialCount)
    expect(config.domainCount).toBe(DEFAULT_CONFIG.domainCount)
    expect(config.poolOfficial).toBe(true)
    expect(config.poolDomain).toBe(true)
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
  it('非持久存储不自动生成凭据：保持空值 fail-closed（多实例行为一致）', async () => {
    // 回归背景（2026-10-27 实测核实）：
    // 生产上未绑定 KV 时 createStore 每个请求都 new MemoryStore()，
    // 「生成并写回」等于每个请求一个不同的随机 UUID —— 客户端按面板
    // 显示的 UUID 连接会随机失败。现只在持久化（KV）存储上自动生成；
    // 内存存储保持空值 → 所有实例一致地拒绝认证（fail-closed）。
    const store = new MemoryStore()
    const config = await loadConfig(store, {} as Env)
    expect(config.uuid).toBe('')
    expect(config.trojanPassword).toBe('')

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

  it('自愈：KV 里 0 的优选数量会被修正回默认值', async () => {
    const store = new MemoryStore()
    const base = await loadConfig(store, {} as Env)
    await saveConfig(store, { ...base, officialCount: 0, domainCount: 0 })
    const loaded = await loadConfig(store, {} as Env)
    expect(loaded.officialCount).toBe(DEFAULT_CONFIG.officialCount)
    expect(loaded.domainCount).toBe(DEFAULT_CONFIG.domainCount)
  })
})
