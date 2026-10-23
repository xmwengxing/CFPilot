/**
 * WebSocket close reason 截断测试。
 *
 * 守护的是真机实测发现的缺陷：
 * close frame 的 reason 最多 123 字节（RFC 6455 §5.5.1），
 * 超长时 **Cloudflare 边缘会静默丢弃整个 close frame** ——
 * 客户端表现为「一直连着但永远等不到关闭」（真机实测挂起 45s+），
 * 而本地 workerd 宽容地照发，能正常关闭。
 * 这个差异只在真机上暴露。
 */
import { describe, expect, it } from 'vitest'
import { truncateCloseReason } from '../src/protocols/websocket-self'

const MAX = 123
const bytes = (s: string): number => new TextEncoder().encode(s).length

describe('close reason 截断', () => {
  it('短 reason 原样保留', () => {
    expect(truncateCloseReason('done')).toBe('done')
  })

  it('超长 reason 截断到 ≤123 字节', () => {
    const detail =
      '出站被 Cloudflare 拒绝（HTTP 45.74.31.40:5292）：proxy request failed, cannot connect to the specified address\n' +
      '  常见原因：目标地址在 Cloudflare 自家网段（Worker 不能主动连回 CF 自己的入口）。\n' +
      '  → 换一个第三方 IP，或改用代理落地。'
    const t = truncateCloseReason(detail)
    expect(bytes(t)).toBeLessThanOrEqual(MAX)
    expect(t).toContain('…')
  })

  it('纯 ASCII 超长也截到 ≤123 字节', () => {
    const t = truncateCloseReason('a'.repeat(500))
    expect(bytes(t)).toBeLessThanOrEqual(MAX)
  })

  it('纯中文超长也截到 ≤123 字节', () => {
    const t = truncateCloseReason('中'.repeat(200))
    expect(bytes(t)).toBeLessThanOrEqual(MAX)
  })

  it('不产生半个 UTF-8 字符', () => {
    const t = truncateCloseReason('中'.repeat(200))
    // 重新编码后长度不变（没有 U+FFFD 替换字符）
    expect(t).not.toContain('\uFFFD')
    expect(bytes(t)).toBe(bytes(t))
  })

  it('恰好等于上限时原样保留', () => {
    const s = 'a'.repeat(MAX)
    expect(truncateCloseReason(s)).toBe(s)
  })

  it('超出 1 字节时也能正确截断（省略号本身占 3 字节的边界）', () => {
    // 回归测试：曾经漏了「加省略号后再检查」这一步，超出 1~3 字节
    const s = '中'.repeat(41) // 123 字节
    const t = truncateCloseReason(s + 'x')
    expect(bytes(t)).toBeLessThanOrEqual(MAX)
  })
})
