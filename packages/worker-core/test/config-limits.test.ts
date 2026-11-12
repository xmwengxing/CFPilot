/**
 * 配置校验的条数上限 —— 回归测试。
 *
 * ## 为什么要有上限
 *
 * - **手动指定 IP**（`add`）会进订阅。订阅请求每次都要读 + 解析这份配置
 *   （配置有 15 秒缓存，超时就要重解析 —— 免费版的 CPU 预算扛不住）。
 *   粘几万条会让**所有**订阅请求都变慢甚至报错，殃及所有人。
 * - **反代入口池**（`relayPool`）是优选出来的候选池，会被轮换使用，
 *   条数可以比代理池多，但同样要挡住「误粘几万条」。
 * - **代理池**（`proxyIp` / `socks5` / `httpProxy`）是用户自配的一小组出口，
 *   20 条足够。
 */
import { describe, it, expect } from 'vitest'
import { validateConfigPatch } from '../src/config-validate'

function lines(n: number, prefix = '9.9.9'): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`${prefix}.${i % 256}:443`)
  return out.join('\n')
}

describe('条数上限', () => {
  it('手动指定 IP：超过上限要报错', () => {
    const errors = validateConfigPatch({ add: lines(2001) })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.message.includes('最多 2000 条'))).toBe(true)
  })

  it('手动指定 IP：正好到上限不报错', () => {
    expect(validateConfigPatch({ add: lines(2000) })).toHaveLength(0)
  })

  it('反代入口池：上限比代理池宽（200 条）', () => {
    expect(validateConfigPatch({ relayPool: lines(200) })).toHaveLength(0)
    const errors = validateConfigPatch({ relayPool: lines(201) })
    expect(errors.some((e) => e.message.includes('最多 200 条'))).toBe(true)
  })

  it('代理池：仍然最多 20 条', () => {
    expect(validateConfigPatch({ proxyIp: lines(20) })).toHaveLength(0)
    const errors = validateConfigPatch({ proxyIp: lines(21) })
    expect(errors.some((e) => e.message.includes('最多 20 条'))).toBe(true)
  })

  it('SOCKS5 / HTTP 代理：同样最多 20 条', () => {
    expect(validateConfigPatch({ socks5: lines(20) })).toHaveLength(0)
    expect(validateConfigPatch({ httpProxy: lines(21) }).length).toBeGreaterThan(0)
  })
})
