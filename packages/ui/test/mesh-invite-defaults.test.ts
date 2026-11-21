import { describe, expect, it } from 'vitest'
import { createMeshInviteDefaults } from '../src/mesh-invite-defaults'

function sequentialRandom(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) bytes[i] = i + 1
}

describe('createMeshInviteDefaults', () => {
  it('creates network credentials and both IPv4 addresses when fields are empty', () => {
    const result = createMeshInviteDefaults({ networkName: '', psk: '', virtualIp: '' }, sequentialRandom)

    expect(result.networkName).toBe('mesh-010203040506')
    expect(result.psk).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20')
    expect(result.virtualIp).toBe('10.97.0.1')
    expect(result.suggestedIp).toBe('10.97.0.2')
  })

  it('preserves entered values and suggests the next address in the same subnet', () => {
    expect(createMeshInviteDefaults({ networkName: 'home', psk: 'secret', virtualIp: '192.168.40.254' }, sequentialRandom)).toEqual({
      networkName: 'home',
      psk: 'secret',
      virtualIp: '192.168.40.254',
      suggestedIp: '192.168.40.2',
    })
  })

  it('rejects an invalid existing virtual IP instead of creating a broken invite', () => {
    expect(() => createMeshInviteDefaults({ networkName: 'home', psk: 'secret', virtualIp: '10.1.2.256' })).toThrow(
      '虚拟 IP 必须是有效的 IPv4 地址'
    )
  })
})
