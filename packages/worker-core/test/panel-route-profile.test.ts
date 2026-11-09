/**
 * 面板两处交互的回归测试。
 *
 * ## 覆盖的问题
 *
 * 1. **Clash 分流规则填写框读取不到内置内容**：
 *    `GET /route-profile` 只回 KV 里的自定义原文，没写自定义时是空串 ——
 *    但订阅里生效的是一整套内置 GEOSITE/GEOIP 规则。
 *    用户看到空框，读到的和生效的不是一回事。
 * 2. **「清空（回落至内置）」按钮无效**：
 *    删除前先 `get` 判断键是否存在，而 KV 读是最终一致的 ——
 *    陈旧读会把「其实有值」误判成「没有」→ 跳过删除 → 自定义规则留在 KV 里。
 * 3. **手动指定 IP 填错没有任何提示**：
 *    解析层遇到看不懂的行就静默跳过，用户只看到「保存成功」，
 *    但订阅里一条节点都没进去。
 */
import { describe, expect, it } from 'vitest'
import {
  buildBuiltinProfileText,
  buildBuiltinRules,
  parseRouteProfile,
  renderRouteSections,
  ROUTE_MAIN_GROUP,
} from '../src/route-profile'
import { validateConfigPatch, validateIpList } from '../src/config-validate'
import { saveRouteProfile } from '../src/config'

/** 内存 KV：模拟 Cloudflare KV 的 delete 语义 */
class FakeKv {
  data = new Map<string, string>()
  writes = 0
  deletes = 0

  async get(key: string): Promise<string | null> {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  async put(key: string, value: string): Promise<void> {
    this.writes++
    this.data.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.deletes++
    this.data.delete(key)
  }
}

describe('分流规则：内置内容可读且可往返', () => {
  it('内置规则文本非空且以 YAML 规则行开头', () => {
    const text = buildBuiltinProfileText(ROUTE_MAIN_GROUP)
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text.split('\n')[0]!.trim().startsWith('- ')).toBe(true)
  })

  it('内置规则文本与 buildBuiltinRules 同构', () => {
    const text = buildBuiltinProfileText(ROUTE_MAIN_GROUP)
    expect(text.split('\n')).toEqual(buildBuiltinRules(ROUTE_MAIN_GROUP))
  })

  it('内置规则文本能被解析回规则（面板读到的东西真的能被内核用）', () => {
    const text = buildBuiltinProfileText(ROUTE_MAIN_GROUP)
    const profile = parseRouteProfile(text)
    expect(profile.rules.length).toBeGreaterThan(0)
    // 每条规则都要有动作
    for (const r of profile.rules) expect(r.group.length).toBeGreaterThan(0)
  })

  it('把内置规则文本当自定义规则保存，渲染结果与内置完全一致', () => {
    const builtin = buildBuiltinProfileText(ROUTE_MAIN_GROUP)
    const rendered = renderRouteSections(builtin, {
      mainGroup: ROUTE_MAIN_GROUP,
      autoGroup: '自动选择',
    })
    expect(rendered.rules).toEqual(buildBuiltinRules(ROUTE_MAIN_GROUP))
  })

  it('YAML 规则行逐字保留 REJECT 目标与 no-resolve 后缀', () => {
    const rendered = renderRouteSections('- GEOSITE,category-ads-all,REJECT', {
      mainGroup: ROUTE_MAIN_GROUP,
      autoGroup: '自动选择',
    })
    expect(rendered.rules).toEqual(['  - GEOSITE,category-ads-all,REJECT'])
  })

  it('YAML 规则行保留 GEOIP 的 no-resolve 后缀', () => {
    const rendered = renderRouteSections('- GEOIP,LAN,DIRECT,no-resolve', {
      mainGroup: ROUTE_MAIN_GROUP,
      autoGroup: '自动选择',
    })
    expect(rendered.rules).toEqual(['  - GEOIP,LAN,DIRECT,no-resolve'])
  })

  it('动作指向不存在的组时跳过该条（不能让整份订阅加载失败）', () => {
    const rendered = renderRouteSections('- GEOSITE,youtube,不存在的组', {
      mainGroup: ROUTE_MAIN_GROUP,
      autoGroup: '自动选择',
    })
    expect(rendered.rules).toEqual([])
  })

  it('RULE-SET 类型被拒绝（缺 rule-providers 会让整份订阅加载失败）', () => {
    const profile = parseRouteProfile('- RULE-SET,CFnat,DIRECT')
    expect(profile.rules).toEqual([])
  })

  it('ini 写法仍然可用（向后兼容）', () => {
    const rendered = renderRouteSections('ruleset=直连,[]GEOIP,CN', {
      mainGroup: ROUTE_MAIN_GROUP,
      autoGroup: '自动选择',
    })
    expect(rendered.rules).toEqual(['  - GEOIP,CN,DIRECT'])
  })
})

describe('分流规则：清空按钮必须真的清掉', () => {
  it('传入空串会删除 KV 键', async () => {
    const kv = new FakeKv()
    kv.data.set('ROUTE_PROFILE', '自定义内容')
    await saveRouteProfile(kv as never, '')
    expect(kv.data.has('ROUTE_PROFILE')).toBe(false)
  })

  it('键不存在时也会执行删除（陈旧读不能挡住删除）', async () => {
    const kv = new FakeKv()
    await saveRouteProfile(kv as never, '')
    // ⚠️ 关键：即使键本来就不存在，也必须真的发出 delete。
    // 之前是「先 get 再决定删不删」，陈旧读会把有值的键误判成没有 → 跳过删除。
    expect(kv.deletes).toBe(1)
  })

  it('传入非空内容会写入 KV', async () => {
    const kv = new FakeKv()
    await saveRouteProfile(kv as never, '- GEOSITE,youtube,CFPilot')
    expect(kv.data.get('ROUTE_PROFILE')).toBe('- GEOSITE,youtube,CFPilot')
  })
})

describe('手动指定 IP：语法校验', () => {
  it('合法格式全部放行', () => {
    const valid = [
      '104.16.1.1',
      '104.16.1.1:443',
      '104.16.1.1:443#US-SJC',
      '[2606:4700::1]:443#US-LAX',
      '[2606:4700::1]',
      '2606:4700::1',
      'example.com',
      'example.com:443',
      '# 整行注释',
      '',
      '   ',
    ]
    for (const line of valid) {
      expect(validateIpList(line), `应放行：${line}`).toBe('')
    }
  })

  it('非法格式被拦下并指出行号', () => {
    expect(validateIpList('not a host')).toContain('1 行')
    expect(validateIpList('104.16.1.1:99999')).toContain('1 行')
    expect(validateIpList('104.16.1.1:abc')).toContain('1 行')
    expect(validateIpList('[2606:4700::1:443')).toContain('1 行')
  })

  it('纯数字的四段标签按域名规则合法（与解析层一致，不拦）', () => {
    // `999.1.1.1` 的标签全是数字 —— 按域名规则合法，解析层认得。
    // 校验必须与解析层同口径，否则会出现「校验说没问题但节点没进去」。
    expect(validateIpList('999.1.1.1')).toBe('')
  })

  it('端口 0 与 65536 都非法', () => {
    expect(validateIpList('104.16.1.1:0')).toContain('无法识别')
    expect(validateIpList('104.16.1.1:65536')).toContain('无法识别')
  })

  it('端口 1 与 65535 合法', () => {
    expect(validateIpList('104.16.1.1:1')).toBe('')
    expect(validateIpList('104.16.1.1:65535')).toBe('')
  })

  it('问题列表带行号（用户要能定位到哪一行）', () => {
    const text = validateIpList('104.16.1.1\nnot a host\n104.16.2.2')
    expect(text).toContain('第 2 行')
    expect(text).toContain('1 行')
  })

  it('错误描述能直接展示给用户', () => {
    const text = validateIpList('not a host\n104.16.1.1:99999')
    expect(text).toContain('2 行')
    expect(text).toContain('第 1 行')
    expect(text).toContain('第 2 行')
  })

  it('后端配置校验拦住非法的 add 字段', () => {
    const errors = validateConfigPatch({ add: '104.16.1.1\nnot a host' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.field === 'add')).toBe(true)
  })

  it('合法的 add 字段通过校验', () => {
    const errors = validateConfigPatch({ add: '104.16.1.1:443#US-SJC\n[2606:4700::1]:443' })
    expect(errors).toEqual([])
  })

  it('空的 add 字段通过校验（清空是合法操作）', () => {
    expect(validateConfigPatch({ add: '' })).toEqual([])
  })
})
