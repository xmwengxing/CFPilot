import { describe, expect, it } from 'vitest'
import { meshInviteFormValues, meshProfileFormValues } from '../src/mesh-form'

describe('恢复组网档案', () => {
  it('打洞开关与反向存储的 disablePunch 一致', () => {
    expect(meshProfileFormValues({ disablePunch: false }).meshEnablePunch).toBe(true)
    expect(meshProfileFormValues({ disablePunch: true }).meshEnablePunch).toBe(false)
    expect(meshProfileFormValues({}).meshEnablePunch).toBe(true)
    expect(meshProfileFormValues({ enableDegrade: false }).meshEnableDegrade).toBe(false)
  })

  it('切换到缺少可选项的旧档案时清空上一档案的表单值', () => {
    expect(meshProfileFormValues({ networkName: 'home' })).toMatchObject({
      meshNetwork: 'home',
      meshRelayDomain: '',
      meshRelayRoom: '',
      meshRelayConnectIp: '',
      meshRelayServerAddr: '',
      meshMonitorToken: '',
      meshInviteInput: '',
    })
  })
})

describe('应用组网邀请', () => {
  it('使用同一盲中继房间，在邀请省略可选字段时清除旧值', () => {
    expect(meshInviteFormValues({
      network: 'office',
      psk: 'test-key',
      suggestedIp: '10.97.0.2',
      relayDomain: 'relay.example.test',
      relayRoom: 'ab12cd34',
    })).toEqual({
      meshNetwork: 'office',
      meshPsk: 'test-key',
      meshVirtualIp: '10.97.0.2',
      meshRelayDomain: 'relay.example.test',
      meshRelayRoom: 'ab12cd34',
      meshRelayConnectIp: '',
      meshMonitorEndpoint: '',
      meshMonitorToken: '',
      meshMonitorInterval: '',
    })
  })

  it('恢复上报间隔且保留加入方自己设置的设备名与打洞开关', () => {
    const values = meshInviteFormValues({ monitoringIntervalMs: 15000, monitorAlias: '对端设备' })
    expect(values.meshMonitorInterval).toBe('15')
    expect(values).not.toHaveProperty('meshMonitorAlias')
    expect(values).not.toHaveProperty('meshEnablePunch')
  })
})
