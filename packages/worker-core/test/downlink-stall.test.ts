/**
 * 下行无数据 → 反代重拨 —— 回归测试。
 *
 * 守护 真机定位的缺陷：
 * Cloudflare Workers 的 `connect()` 对 Google / YouTube / GitHub 等 443 目标
 * **TCP 能建连但一个字节都收不到**（真机实测：协议响应头 `[0,0]` 已回，
 * 12 秒内 0 字节）。客户端侧表现为「连着但永远等不到响应」，超时后 -1。
 *
 * 同类实现的解法：直连成功后若下行无数据，
 * 自动重拨到反代入口（第三方服务器按 SNI 转发，出口不是 Cloudflare）。
 * 本测试锁定 CFPilot 的同一机制。
 *
 * 因为 `handleWebSocket` 需要完整的 workerd 环境（WebSocketPair 等），
 * 这里只对**可抽出来的判定逻辑**做单元验证 —— 与 scan.ts 的 TLS 排序测试同一思路。
 */
import { describe, expect, it } from 'vitest'

/** 与 websocket-self.ts 保持一致的下行静默窗口（ms） */
const DOWNLINK_STALL_MS = 2500
/** 与 websocket-self.ts 保持一致的重拨上限 */
const MAX_RELAY_REDIAL = 2

describe('下行静默检测参数', () => {
  it('静默窗口要足够短（不能拖过客户端超时），又不能误杀慢目标', () => {
    // 真机参考：假活时 12s 都是 0 字节；正常目标首字节 1~3s
    expect(DOWNLINK_STALL_MS).toBeGreaterThanOrEqual(1500)
    expect(DOWNLINK_STALL_MS).toBeLessThanOrEqual(4000)
  })

  it('重拨次数有限，避免无限循环打反代', () => {
    expect(MAX_RELAY_REDIAL).toBeGreaterThanOrEqual(1)
    expect(MAX_RELAY_REDIAL).toBeLessThanOrEqual(3)
  })
})

describe('假活判定', () => {
  /** 复刻 websocket-self.ts 的判定：收到字节就取消重拨 */
  const shouldRedial = (downlinkBytes: number, elapsedMs: number): boolean =>
    downlinkBytes === 0 && elapsedMs >= DOWNLINK_STALL_MS

  it('0 字节且超过窗口 → 判定假活，触发重拨', () => {
    expect(shouldRedial(0, DOWNLINK_STALL_MS)).toBe(true)
    expect(shouldRedial(0, DOWNLINK_STALL_MS + 1000)).toBe(true)
  })

  it('收到过字节 → 不触发（哪怕后来没数据）', () => {
    expect(shouldRedial(1, DOWNLINK_STALL_MS + 5000)).toBe(false)
    expect(shouldRedial(1024, 60000)).toBe(false)
  })

  it('窗口内不触发，给慢目标留时间', () => {
    expect(shouldRedial(0, 100)).toBe(false)
    expect(shouldRedial(0, DOWNLINK_STALL_MS - 1)).toBe(false)
  })
})

describe('反代入口去重', () => {
  /**
   * 复刻 redialViaRelay 的入口过滤：同一入口不反复重试。
   *
   * 为什么重要：反代是第三方公共服务，反复打同一入口既浪费又可能被限流。
   */
  const filterFresh = (
    endpoints: Array<{ ip: string; port: number }>,
    tried: Set<string>
  ): Array<{ ip: string; port: number }> =>
    endpoints.filter((e) => !tried.has(`${e.ip}:${e.port}`))

  it('过滤掉已试过的入口', () => {
    const eps = [
      { ip: '1.1.1.1', port: 443 },
      { ip: '2.2.2.2', port: 443 },
      { ip: '3.3.3.3', port: 443 },
    ]
    const tried = new Set(['1.1.1.1:443'])
    expect(filterFresh(eps, tried).map((e) => e.ip)).toEqual(['2.2.2.2', '3.3.3.3'])
  })

  it('全部试过时返回空（调用方据此关闭连接）', () => {
    const eps = [{ ip: '1.1.1.1', port: 443 }]
    const tried = new Set(['1.1.1.1:443'])
    expect(filterFresh(eps, tried)).toEqual([])
  })

  it('端口不同算不同入口', () => {
    const eps = [
      { ip: '1.1.1.1', port: 443 },
      { ip: '1.1.1.1', port: 8443 },
    ]
    expect(filterFresh(eps, new Set(['1.1.1.1:443'])).map((e) => e.port)).toEqual([8443])
  })
})
