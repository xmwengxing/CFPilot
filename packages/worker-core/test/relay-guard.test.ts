/**
 * 无下行自动重拨护栏 —— 回归测试。
 *
 * 守护的缺陷：静默重拨原先不判断出口类型与端口，
 * 配了 SOCKS5 落地代理时也会切到内置反代入口 —— 用户指定的出口被静默绕过；
 * 对非 443/80 目标同样会切，而反代并不转发这些端口。
 */
import { describe, expect, it } from 'vitest'
import {
  canSwitchToBuiltinRelay,
  RELAY_CAPABLE_PORTS,
  type RelayGuardInput,
} from '../src/protocols/relay-guard'

const direct: RelayGuardInput = {
  via: 'direct',
  port: 443,
  userProxyConfigured: false,
  aggressive: false,
}

describe('内置反代自动切换的边界', () => {
  it('直连 443 允许切换，80 也允许', () => {
    expect(canSwitchToBuiltinRelay(direct).allowed).toBe(true)
    expect(canSwitchToBuiltinRelay({ ...direct, port: 80 }).allowed).toBe(true)
    expect(RELAY_CAPABLE_PORTS).toEqual([443, 80])
  })

  it('NAT64 视为直连类，允许切换', () => {
    expect(canSwitchToBuiltinRelay({ ...direct, via: 'nat64' }).allowed).toBe(true)
  })

  it('已走落地代理时不切换，原因写进诊断', () => {
    for (const via of ['socks5', 'http', 'https'] as const) {
      const verdict = canSwitchToBuiltinRelay({ ...direct, via })
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toContain(via)
      expect(verdict.reason).toContain('出口')
    }
  })

  it('ProxyIP 的 via 也是 direct，靠「用户配置了代理」兜住', () => {
    const verdict = canSwitchToBuiltinRelay({
      ...direct,
      userProxyConfigured: true,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('ProxyIP')
  })

  it('非 443/80 端口不切换', () => {
    for (const port of [22, 53, 8443, 3306]) {
      const verdict = canSwitchToBuiltinRelay({ ...direct, port })
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toContain(String(port))
    }
  })

  it('激进模式放开通道与端口限制，但原因里保留风险提示', () => {
    const verdict = canSwitchToBuiltinRelay({
      via: 'socks5',
      port: 22,
      userProxyConfigured: true,
      aggressive: true,
    })
    expect(verdict.allowed).toBe(true)
    expect(verdict.reason).toContain('重复请求')
  })
})
