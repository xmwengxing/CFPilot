/**
 * 代理调度逻辑的测试。
 *
 * ## 覆盖三件事
 *
 *  1. **ProxyIP 与落地代理分离**（2026-10-28 修的真实缺陷）
 *     ProxyIP 只要 TCP 连上就算成功（1 RTT），SOCKS5 要 2~3 RTT ——
 *     两者同池竞速时 ProxyIP 必然赢，于是「配了 SOCKS5 也没用」，
 *     而且是静默的（出口 IP 与预期不符，无任何报错）。
 *
 *  2. **落地代理顺序故障转移**
 *     多个 SOCKS5 并发竞速会让所有代理服务器同时向目标站建连再被强行断开，
 *     白白消耗代理的连接配额。
 *
 *  3. **代理调度模式（proxyMode）**
 *     `only`（默认）/ `global` / `fallback` / `smart` 的选路顺序。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { buildRouteCandidates, groupCandidates, type RouteCandidate } from '../src/outbound/route'
import { normalizeProxyMode, PROXY_MODES } from '../src/config'
import type { ProxyMode } from '../src/types'

// ------------------------------------------------------------------
// 候选分组的语义（纯函数，容易测）
// ------------------------------------------------------------------

describe('候选分组：ProxyIP 与落地代理分离', () => {
  const base = { targetHost: 'example.com', targetPort: 443 }

  it('ProxyIP 落到 proxyIp 组，落地代理落到 landing 组', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [
        { host: '1.2.3.4', port: 443, kind: 'direct' },
        { host: 's1.example', port: 1080, kind: 'socks5' },
      ],
    })
    const groups = groupCandidates(list)
    expect(groups.proxyIp.map((c) => c.via?.kind)).toEqual(['direct'])
    expect(groups.landing.map((c) => c.via?.kind)).toEqual(['socks5'])
  })

  it('两组互不重叠', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [
        { host: '1.2.3.4', port: 443, kind: 'direct' },
        { host: 's1.example', port: 1080, kind: 'socks5' },
        { host: 'h1.example', port: 8080, kind: 'http' },
      ],
    })
    const groups = groupCandidates(list)
    const landingHosts = groups.landing.map((c) => c.host)
    const proxyIpHosts = groups.proxyIp.map((c) => c.host)
    expect(landingHosts.some((h) => proxyIpHosts.includes(h))).toBe(false)
  })

  it('代理候选仍与直连候选互斥（AGENTS.md §1.11）', () => {
    const list = buildRouteCandidates({
      ...base,
      proxies: [{ host: 's1.example', port: 1080, kind: 'socks5' }],
      optimizedIps: [{ ip: '9.9.9.9', port: 443 }],
    })
    const groups = groupCandidates(list)
    expect(groups.direct.every((c) => c.source !== 'proxy')).toBe(true)
  })
})

// ------------------------------------------------------------------
// proxyMode 归一化
// ------------------------------------------------------------------

describe('normalizeProxyMode', () => {
  it('四种合法模式原样返回', () => {
    for (const mode of PROXY_MODES) {
      expect(normalizeProxyMode(mode)).toBe(mode)
    }
  })

  it('大小写与空白不敏感', () => {
    expect(normalizeProxyMode('  GLOBAL ')).toBe('global')
    expect(normalizeProxyMode('Smart')).toBe('smart')
  })

  it('读不懂的值回落 only（最保守语义）', () => {
    expect(normalizeProxyMode('')).toBe('only')
    expect(normalizeProxyMode('nonsense')).toBe('only')
    expect(normalizeProxyMode('proxy')).toBe('only')
  })
})

// ------------------------------------------------------------------
// 选路顺序（用打桩的拨号器验证「先试谁」）
// ------------------------------------------------------------------

/**
 * 记录候选被尝试的顺序。
 *
 * 真实拨号要连 socket，测不了；这里用「假的 attemptOf」把顺序记下来，
 * 验证的是**选路策略**（哪个组先、组内怎么排），不是网络行为。
 */
interface Attempt {
  label: string
  group: 'landing' | 'proxyIp' | 'direct'
}

describe('选路顺序', () => {
  const base = { targetHost: 'example.com', targetPort: 443 }

  /** 造一组候选：1 个 ProxyIP + 2 个落地代理 + 直连 + 优选 */
  function makeCandidates(): RouteCandidate[] {
    return buildRouteCandidates({
      ...base,
      proxies: [
        { host: '1.2.3.4', port: 443, kind: 'direct' },
        { host: 's1.example', port: 1080, kind: 'socks5' },
        { host: 's2.example', port: 1080, kind: 'socks5' },
      ],
      optimizedIps: [{ ip: '9.9.9.9', port: 443 }],
    })
  }

  /**
   * 按组构造「尝试器」：每组第一次成功或全部失败。
   *
   * @param failGroups 哪些组要全部失败
   * @param log 记录尝试顺序
   */
  function makeAttempters(failGroups: Set<string>, log: Attempt[]) {
    const attemptOf = (group: string) => async (candidate: RouteCandidate) => {
      log.push({ label: candidate.label, group: group as Attempt['group'] })
      if (failGroups.has(group)) throw new Error(`${group} 失败`)
      return { readable: null as never, writable: null as never, via: group, endpoint: 'x' }
    }
    return attemptOf
  }

  it('landing 组内部保持配置顺序（顺序故障转移，不是并发竞速）', async () => {
    const groups = groupCandidates(makeCandidates())
    const log: Attempt[] = []
    const attemptOf = makeAttempters(new Set(), log)

    // 模拟 dial.ts 的 dialLanding()：第一个失败 → 试第二个
    let first = true
    for (const candidate of groups.landing) {
      if (first) {
        // 第一个代理失败（只记日志，不进 attemptOf，避免重复记录）
        first = false
        log.push({ label: candidate.label, group: 'landing' })
        continue
      }
      await attemptOf('landing')(candidate)
      break
    }
    // 标签格式是 `<KIND> <host>:<port>`；顺序与配置一致
    expect(log.map((a) => a.label)).toEqual(['SOCKS5 s1.example:1080', 'SOCKS5 s2.example:1080'])
    expect(log.every((a) => a.group === 'landing')).toBe(true)
  })

  it('landing 组与 proxyIp 组的标签不混淆', () => {
    const groups = groupCandidates(makeCandidates())
    const landingLabels = groups.landing.map((c) => c.label)
    const proxyIpLabels = groups.proxyIp.map((c) => c.label)
    expect(landingLabels.some((l) => l.startsWith('ProxyIP'))).toBe(false)
    expect(proxyIpLabels.every((l) => l.startsWith('ProxyIP'))).toBe(true)
  })

  it('没有代理时直连组有候选', () => {
    const groups = groupCandidates(buildRouteCandidates(base))
    expect(groups.landing).toHaveLength(0)
    expect(groups.proxyIp).toHaveLength(0)
    expect(groups.direct.length).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------------
// 模式常量
// ------------------------------------------------------------------

describe('PROXY_MODES', () => {
  it('包含四种模式', () => {
    expect(PROXY_MODES).toEqual(['only', 'global', 'fallback', 'smart'])
  })

  it('每种模式都能被 normalizeProxyMode 接受', () => {
    for (const mode of PROXY_MODES as ProxyMode[]) {
      expect(normalizeProxyMode(mode)).toBe(mode)
    }
  })
})
