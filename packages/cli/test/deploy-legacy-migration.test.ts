/**
 * 旧默认资源值迁移 —— 回归测试。
 *
 * 背景：配置优先级是 KV > 环境变量 > 默认值。老部署的 KV 里显式存着
 * `dataBudgetMB: 0` / `relayRedialMax: 4`（旧版本默认），所以把默认值改成
 * 512 / 2 之后，**老用户读到的仍是旧值**，新默认等于没生效。
 *
 * 迁移只在部署时做（部署本来就会读写一次 CONFIG），不额外消耗 KV 写配额；
 * 绝不放进内核读路径（AGENTS §2.2.F：陈旧读会反复触发写）。
 */
import { describe, expect, it } from 'vitest'

import { migrateLegacyResourceDefaults } from '../src/deploy/pages-deploy'

describe('旧默认资源值迁移', () => {
  it('恰好等于旧默认值时升级为新默认值', () => {
    const { config, applied } = migrateLegacyResourceDefaults({
      uuid: 'keep-me',
      dataBudgetMB: 0,
      relayRedialMax: 4,
    })
    expect(config.dataBudgetMB).toBe(512)
    expect(config.relayRedialMax).toBe(2)
    // 其余字段原样保留（部署只覆盖凭据，这里也只动资源项）
    expect(config.uuid).toBe('keep-me')
    expect(applied).toEqual([
      { field: 'dataBudgetMB', from: 0, to: 512 },
      { field: 'relayRedialMax', from: 4, to: 2 },
    ])
  })

  it('键不存在时不动（让内核新默认生效，写进去反而把默认钉死）', () => {
    const { config, applied } = migrateLegacyResourceDefaults({ uuid: 'x' })
    expect('dataBudgetMB' in config).toBe(false)
    expect('relayRedialMax' in config).toBe(false)
    expect(applied).toEqual([])
  })

  it('用户改成别的值时一律尊重，不覆盖', () => {
    const { config, applied } = migrateLegacyResourceDefaults({
      dataBudgetMB: 1024,
      relayRedialMax: 3,
    })
    expect(config.dataBudgetMB).toBe(1024)
    expect(config.relayRedialMax).toBe(3)
    expect(applied).toEqual([])
  })

  it('只迁移一项时不误伤另一项', () => {
    const { config, applied } = migrateLegacyResourceDefaults({
      dataBudgetMB: 2048,
      relayRedialMax: 4,
    })
    expect(config.dataBudgetMB).toBe(2048)
    expect(config.relayRedialMax).toBe(2)
    expect(applied).toEqual([{ field: 'relayRedialMax', from: 4, to: 2 }])
  })

  it('KV 里存成字符串数字时同样识别（JSON 手改过的情况）', () => {
    const { config, applied } = migrateLegacyResourceDefaults({
      dataBudgetMB: '0',
      relayRedialMax: '4',
    })
    expect(config.dataBudgetMB).toBe(512)
    expect(config.relayRedialMax).toBe(2)
    expect(applied).toHaveLength(2)
  })

  it('非法值不迁移（写坏的数据交给内核的归一化兜底）', () => {
    const { config, applied } = migrateLegacyResourceDefaults({
      dataBudgetMB: 'abc',
      relayRedialMax: null,
    })
    expect(config.dataBudgetMB).toBe('abc')
    expect(applied).toEqual([])
  })

  it('不修改传入的对象（纯函数，避免部署侧读到被改过的旧值）', () => {
    const existing = { dataBudgetMB: 0, relayRedialMax: 4 }
    migrateLegacyResourceDefaults(existing)
    expect(existing.dataBudgetMB).toBe(0)
    expect(existing.relayRedialMax).toBe(4)
  })
})
