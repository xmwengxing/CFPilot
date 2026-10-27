/**
 * 数据面 `/__version` 端点 —— 回归测试。
 *
 * ## 为什么需要这个端点
 *
 * 早前 GUI 的「检查状态」只能读 KV 清单里的 `build` 字段 —— 那是
 * **部署时本地写进去的**（自我申报），不是从线上读回来的。
 * 手动改过项目或用命令行部署过，两者就可能对不上。
 *
 * 加上这个端点后，可以直接问线上数据面「你跑的是哪一版」，
 * 结论比清单可靠。
 */
import { describe, expect, it } from 'vitest'
import { routeDataPlane } from '../src/routes/data'
import { VERSION_PATH, versionResponse } from '../src/version'

function makeEnv(): never {
  // 数据面路由在版本端点分支不读 env，给个空壳即可
  return {} as never
}

describe('数据面 /__version', () => {
  it('响应标准路径 /__cfp_version', async () => {
    const req = new Request(`https://data.example.com${VERSION_PATH}`)
    const res = await routeDataPlane(req, makeEnv())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const data = (await res!.json()) as { build?: string; ts?: number }
    expect(typeof data.build).toBe('string')
    expect(data.build!.length).toBeGreaterThan(0)
  })

  it('同时兼容更短的 /__version 写法', async () => {
    const req = new Request('https://data.example.com/__version')
    const res = await routeDataPlane(req, makeEnv())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const data = (await res!.json()) as { build?: string }
    expect(typeof data.build).toBe('string')
  })

  it('返回 JSON 且禁止缓存', () => {
    const res = versionResponse()
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('不泄露任何敏感配置', async () => {
    const req = new Request(`https://data.example.com${VERSION_PATH}`)
    const res = await routeDataPlane(req, makeEnv())
    expect(res).not.toBeNull()
    const text = await res!.text()
    // 绝不能包含 uuid / ws 路径 / 代理配置 / KV 内容
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(text.toLowerCase()).not.toContain('uuid')
    expect(text.toLowerCase()).not.toContain('trojan')
    expect(text.toLowerCase()).not.toContain('proxyip')
    expect(text.toLowerCase()).not.toContain('wspath')
  })

  it('只有 build 与 ts 两个字段', async () => {
    const res = versionResponse()
    const data = (await res.json()) as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['build', 'ts'])
  })
})
