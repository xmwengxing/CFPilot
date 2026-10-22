/**
 * 网络环境检测的单元测试。
 *
 * 只测纯函数与确定性行为：
 *   - fake-ip 判定（198.18.0.0/15、198.19.0.0/15）
 *   - 端口探测在「无监听」时返回 false
 *   - detectProxyInterference 的结构契约
 *
 * 不测真实端口/注册表：那依赖运行环境，会让测试在 CI 上不稳定。
 */
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isFakeIp, isPortListening, detectProxyInterference, PROXY_PORTS } from '../src/net-env'
import { isMsysPollutedPath } from '../src/cli'

describe('isFakeIp', () => {
  it('识别 198.18.0.0/15 段（Clash fake-ip 默认池）', () => {
    expect(isFakeIp('198.18.0.1')).toBe(true)
    expect(isFakeIp('198.18.255.254')).toBe(true)
    expect(isFakeIp('198.19.0.1')).toBe(true)
    expect(isFakeIp('198.19.255.255')).toBe(true)
  })

  it('不把真实 IP 误判为 fake-ip', () => {
    expect(isFakeIp('104.16.0.1')).toBe(false)
    expect(isFakeIp('198.17.0.1')).toBe(false)
    expect(isFakeIp('198.20.0.1')).toBe(false)
    expect(isFakeIp('172.64.0.1')).toBe(false)
  })
})

describe('isPortListening', () => {
  it('有服务监听时返回 true，服务关闭后返回 false', async () => {
    const server = createServer((_req, res) => res.end('ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    expect(await isPortListening(port)).toBe(true)

    const closed = once(server, 'close')
    server.close()
    await closed

    expect(await isPortListening(port)).toBe(false)
  })

  it('对必然无人监听的端口返回 false 而不是抛错', async () => {
    // 1 号端口不会分配给普通进程
    expect(await isPortListening(1, 300)).toBe(false)
  })
})

describe('detectProxyInterference', () => {
  it('返回 clean 与 findings 两个字段，且 findings 结构完整', async () => {
    const result = await detectProxyInterference()
    expect(typeof result.clean).toBe('boolean')
    expect(Array.isArray(result.findings)).toBe(true)
    for (const f of result.findings) {
      expect(typeof f.message).toBe('string')
      expect(typeof f.advice).toBe('string')
      expect(f.message.length).toBeGreaterThan(0)
      expect(f.advice.length).toBeGreaterThan(0)
    }
    // clean 与 findings 必须一致：有发现就不算干净
    expect(result.clean).toBe(result.findings.length === 0)
  })

  it('端口清单里没有重复项', () => {
    const ports = PROXY_PORTS.map((p) => p.port)
    expect(new Set(ports).size).toBe(ports.length)
  })
})

describe('isMsysPollutedPath', () => {
  it('识别被 MSYS 转换的 Windows 路径', () => {
    // 这是真实踩到的形态：Git-Bash 把 --path /vless 转成了项目内的 node_modules 路径
    expect(
      isMsysPollutedPath('C:/Users/wxgo8/.dsh/profiles/web/node_modules/@dsh-ops/bash-win32-x64/vless')
    ).toBe(true)
    expect(isMsysPollutedPath('C:\\Users\\x\\vless')).toBe(true)
    expect(isMsysPollutedPath('/c/Users/x/node_modules/foo')).toBe(true)
  })

  it('放行正常的 WS 路径', () => {
    expect(isMsysPollutedPath('/')).toBe(false)
    expect(isMsysPollutedPath('/vless')).toBe(false)
    expect(isMsysPollutedPath('/11111111-2222-3333-4444-555555555555')).toBe(false)
    expect(isMsysPollutedPath('/a/b')).toBe(false)
    expect(isMsysPollutedPath('/__edge_probe')).toBe(false)
  })
})
