/**
 * 配置写入校验 + 导入导出
 *
 * 两件事必须同时成立：
 * 1. **后端拒绝非法值** —— 前端校验只是体验，接口才是安全边界；
 * 2. **导出不含敏感字段** —— 用白名单保证「新增字段默认不导出」，
 *    而不是靠黑名单逐个排除（那样漏一个就泄露一次）。
 */
import { describe, it, expect } from 'vitest'

import { validateConfigPatch, describeFieldErrors } from '../src/config-validate'
import { buildConfigExport, diffConfig, pickImportable } from '../src/config-transfer'
import type { UserConfig } from '../src/types'

function baseConfig(over: Partial<UserConfig> = {}): UserConfig {
  return {
    uuid: '11111111-2222-3333-4444-555555555555',
    trojanPassword: 'secret-pw',
    wsPath: '/vless',
    trojanPath: '/trojan',
    xhttpPath: '/xhttp',
    subDomain: 'cf.example.com',
    socks5: 'socks5://user:pass@1.2.3.4:1080',
    httpProxy: '',
    proxyIp: '',
    officialCount: 20,
    domainCount: 10,
    subPorts: '443',
    addApi: '',
    addCsv: '',
    ...over,
  } as unknown as UserConfig
}

describe('配置校验', () => {
  it('合法配置通过', () => {
    const errors = validateConfigPatch({
      wsPath: '/vless',
      trojanPath: '/trojan',
      xhttpPath: '/xhttp',
      officialCount: 20,
      subDomain: 'cf.example.com',
      subPorts: '443,8443',
      addApi: 'https://example.com/list.txt',
    })
    expect(errors).toEqual([])
  })

  it('路径必须以 / 开头', () => {
    const errors = validateConfigPatch({ wsPath: 'vless' })
    expect(errors).toHaveLength(1)
    expect(errors[0]!.field).toBe('wsPath')
  })

  it('路径不能含空格', () => {
    expect(validateConfigPatch({ wsPath: '/vless path' })).toHaveLength(1)
  })

  it('三个入站路径不能重复', () => {
    const errors = validateConfigPatch({ wsPath: '/same', trojanPath: '/same' })
    expect(errors.some((e) => e.field === 'paths')).toBe(true)
  })

  it('subDomain 必须是主机名', () => {
    expect(validateConfigPatch({ subDomain: 'https://cf.example.com' })).toHaveLength(1)
    expect(validateConfigPatch({ subDomain: 'cf.example.com/path' })).toHaveLength(1)
    // 留空是合法的（用请求域名）
    expect(validateConfigPatch({ subDomain: '' })).toEqual([])
  })

  it('数量类字段有上限', () => {
    expect(validateConfigPatch({ officialCount: 100000 })).toHaveLength(1)
    expect(validateConfigPatch({ officialCount: 0 })).toHaveLength(1)
    expect(validateConfigPatch({ maxNodes: 99999 })).toHaveLength(1)
  })

  it('代理条目必须可识别', () => {
    expect(validateConfigPatch({ socks5: 'socks5://1.2.3.4:1080' })).toEqual([])
    expect(validateConfigPatch({ socks5: '这不是代理' })).toHaveLength(1)
    expect(validateConfigPatch({ proxyIp: '1.2.3.4:443\n2.3.4.5:443\n3.4.5.6:443' })).toEqual([])
  })

  it('远程订阅源必须是 http(s)', () => {
    expect(validateConfigPatch({ addApi: 'https://example.com/a.txt' })).toEqual([])
    expect(validateConfigPatch({ addApi: 'ftp://example.com/a.txt' })).toHaveLength(1)
  })

  it('端口组合必须是合法端口', () => {
    expect(validateConfigPatch({ subPorts: '443,8443' })).toEqual([])
    expect(validateConfigPatch({ subPorts: '443,99999' })).toHaveLength(1)
    expect(validateConfigPatch({ subPorts: '443,8443,2053,2083,2087,2096,8443' })).toHaveLength(1)
  })

  it('uuid 必须是标准格式', () => {
    expect(validateConfigPatch({ uuid: '11111111-2222-3333-4444-555555555555' })).toEqual([])
    expect(validateConfigPatch({ uuid: 'not-a-uuid' })).toHaveLength(1)
  })

  it('错误信息能拼成一句人话', () => {
    const text = describeFieldErrors(validateConfigPatch({ wsPath: 'x', officialCount: 99999 }))
    expect(text).toContain('wsPath')
    expect(text).toContain('officialCount')
  })
})

describe('配置导出', () => {
  it('不包含凭据与实例标识', () => {
    const exported = buildConfigExport(baseConfig())
    expect(exported.config.uuid).toBeUndefined()
    expect(exported.config.trojanPassword).toBeUndefined()
    expect(exported.config.wsPath).toBeUndefined()
    expect(exported.config.trojanPath).toBeUndefined()
    expect(exported.config.xhttpPath).toBeUndefined()
    expect(exported.config.subDomain).toBeUndefined()
    // 普通配置要带出去
    expect(exported.config.officialCount).toBe(20)
    expect(exported.schemaVersion).toBe(1)
  })

  it('带口令的落地代理不导出，但会说明原因', () => {
    const exported = buildConfigExport(baseConfig())
    expect(exported.config.socks5).toBeUndefined()
    const omitted = exported.omitted.find((o) => o.field === 'socks5')
    expect(omitted).toBeTruthy()
    expect(omitted!.reason).toContain('口令')
  })

  it('不含口令的落地代理照常导出', () => {
    const exported = buildConfigExport(baseConfig({ socks5: '1.2.3.4:1080' }))
    expect(exported.config.socks5).toBe('1.2.3.4:1080')
    expect(exported.omitted.find((o) => o.field === 'socks5')).toBeUndefined()
  })
})

describe('配置导入', () => {
  it('只接受白名单内的字段', () => {
    const picked = pickImportable({ officialCount: 30, uuid: 'evil', __proto__: 'x' })
    expect(picked.officialCount).toBe(30)
    expect(picked.uuid).toBeUndefined()
  })

  it('差异只包含真正会变的字段', () => {
    const diffs = diffConfig(baseConfig(), { officialCount: 20, domainCount: 12 })
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.field).toBe('domainCount')
    expect(diffs[0]!.to).toBe('12')
  })
})
