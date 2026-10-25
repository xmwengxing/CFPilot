/**
 * 分流规则配置解析 —— 回归测试。
 *
 * 守护 2026-10-25 借鉴 cfnew 的能力：Clash 订阅自带 ACL4SSR 风格的
 * 分流规则与代理组，用户导入后 YouTube / Netflix / OpenAI 自动走代理。
 *
 * 实现方式为「构建期内联」（方案 A）：ini 放仓库，gzip+base64 嵌进产物，
 * 运行时零外网请求（铁律 8）。ini 里的 ruleset 仍指向公共远端 list，
 * 因此分流数据永远是最新的。
 */
import { describe, expect, it } from 'vitest'
import { parseRouteProfile, renderRouteProfile, renderRouteSections } from '../src/route-profile'

/** 取自内置 assets/route-profiles.ini 的真实片段 */
const SAMPLE = [
  '[custom]',
  ';不要随意改变关键字，否则会导致出错',
  'ruleset=🎯 全球直连,https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/CFnat.list',
  'ruleset=📹 油管视频,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/YouTube.list',
  'ruleset=🎯 全球直连,[]GEOIP,CN',
  'ruleset=🐟 漏网之鱼,[]FINAL',
  '',
  'custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT`.*',
  'custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300',
  'custom_proxy_group=🇭🇰 香港节点`load-balance`(港|HK|hk)`https://captive.apple.com/hotspot-detect.html`300',
  'custom_proxy_group=🛑 全球拦截`select`[]REJECT`[]DIRECT',
  '',
  'enable_rule_generator=true',
].join(String.fromCharCode(10))

describe('parseRouteProfile', () => {
  const profile = parseRouteProfile(SAMPLE)

  it('解析 ruleset 行', () => {
    expect(profile.rules).toHaveLength(4)
    expect(profile.rules[0]).toEqual({
      group: '🎯 全球直连',
      value: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/CFnat.list',
      inline: false,
    })
  })

  it('识别内联规则（[] 开头）', () => {
    const geoip = profile.rules.find((r) => r.value === '[]GEOIP,CN')
    expect(geoip?.inline).toBe(true)
    const final = profile.rules.find((r) => r.value === '[]FINAL')
    expect(final?.inline).toBe(true)
  })

  it('解析 custom_proxy_group 行', () => {
    expect(profile.groups).toHaveLength(4)
    const selector = profile.groups.find((g) => g.name === '🚀 节点选择')
    expect(selector).toMatchObject({ type: 'select' })
    expect(selector?.members).toEqual(['♻️ 自动选择', 'DIRECT', '.*'])
  })

  it('url-test 组带 url 与 interval', () => {
    const auto = profile.groups.find((g) => g.name === '♻️ 自动选择')
    expect(auto).toMatchObject({
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
    })
  })

  it('load-balance 组带正则', () => {
    const hk = profile.groups.find((g) => g.name === '🇭🇰 香港节点')
    expect(hk).toMatchObject({ type: 'load-balance', regex: '(港|HK|hk)' })
  })

  it('忽略注释、空行、节头与未知键', () => {
    // enable_rule_generator 不应产生任何组或规则
    expect(profile.groups.some((g) => g.name.includes('enable'))).toBe(false)
    // 注释行不以 ; 开头混进来
    expect(profile.rules.every((r) => r.group && r.value)).toBe(true)
  })

  it('空输入返回空 profile', () => {
    const empty = parseRouteProfile('')
    expect(empty.rules).toEqual([])
    expect(empty.groups).toEqual([])
  })

  it('畸形行被跳过不抛异常', () => {
    const bad = parseRouteProfile('ruleset=\ncustom_proxy_group=\nruleset=只有组名\ncustom_proxy_group=只有名字`select')
    // ruleset= 后面没内容 → 跳过
    // ruleset=只有组名 没有逗号 → 跳过
    expect(bad.rules).toEqual([])
    // custom_proxy_group=只有名字`select 有名字也有类型 → 能解析（成员为空）
    // 这是有意的：宁可生成一个空组，也不要丢配置
    expect(bad.groups).toHaveLength(1)
    expect(bad.groups[0]).toMatchObject({ name: '只有名字', type: 'select' })
  })

  it('完全没有反引号的 custom_proxy_group 行被跳过', () => {
    const bad = parseRouteProfile('custom_proxy_group=没有类型只有名字')
    expect(bad.groups).toEqual([])
  })
})

describe('renderRouteProfile', () => {
  const profile = parseRouteProfile(SAMPLE)
  const out = renderRouteProfile(profile, { mainGroup: 'CFPilot', autoGroup: '自动选择', nodeNames: [] })

  it('内联 GEOIP 规则翻译成 Clash 语法', () => {
    expect(out.rules).toContain('  - GEOIP,CN,DIRECT')
  })

  it('FINAL 规则翻译成 MATCH', () => {
    expect(out.rules).toContain('  - MATCH,CFPilot')
  })

  it('远端 ruleset 翻译成 RULE-SET', () => {
    const yt = out.rules.find((r) => r.includes('YouTube'))
    expect(yt).toBe('  - RULE-SET,YouTube,CFPilot')
    const nat = out.rules.find((r) => r.includes('CFnat'))
    expect(nat).toBe('  - RULE-SET,CFnat,DIRECT') // 组名含「直连」→ DIRECT
  })

  it('「全球直连」组的规则动作是 DIRECT', () => {
    for (const line of out.rules) {
      if (line.includes('CFnat')) expect(line.endsWith('DIRECT')).toBe(true)
    }
  })

  it('跳过我们已生成的组（避免重复定义）', () => {
    const names = out.groups.join('\n')
    expect(names).not.toContain('"自动选择"')
    expect(names).not.toContain('"CFPilot"')
  })

  it('ini 里带 emoji 前缀的同名组也跳过', () => {
    // ⚠️ 真机发现的回归：ini 里的 `♻️ 自动选择` 与我们的 `自动选择`
    // 只比精确名会漏，导致订阅里出现两个等价的 url-test 组。
    const withEmoji = parseRouteProfile(
      [
        '[custom]',
        'custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`86400',
        'custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT`.*',
        'custom_proxy_group=🇺🇲 美国节点`load-balance`(美|US)`https://captive.apple.com/`300',
      ].join('\n')
    )
    const r = renderRouteProfile(withEmoji, { mainGroup: 'CFPilot', autoGroup: '自动选择', nodeNames: [] })
    const names = r.groups.join('\n')
    expect(names).not.toContain('自动选择') // 两种形态都不该出现
    expect(names).toContain('美国节点') // 国家组保留
  })

  it('ini 里的「节点选择」组被跳过（等价于我们的 CFPilot 组）', () => {
    // 🚀 节点选择 的成员是 [自动选择, DIRECT, .*]，本质就是主组
    const names = out.groups.join('\n')
    expect(names).not.toContain('节点选择')
  })

  it('国家组保留并挂到主组', () => {
    const names = out.groups.join('\n')
    expect(names).toContain('香港节点')
    expect(names).toContain('type: load-balance')
    expect(names).toContain('- CFPilot')
  })

  it('REJECT 组保留', () => {
    const names = out.groups.join('\n')
    expect(names).toContain('全球拦截')
    expect(names).toContain('REJECT')
  })

  it('所有组都是合法 YAML 片段（缩进两格起）', () => {
    for (const line of out.groups) {
      expect(line.startsWith('  ')).toBe(true)
    }
  })
})

describe('renderRouteSections（高层入口）', () => {
  it('空文本返回空（不用分流规则）', () => {
    const r = renderRouteSections('', { mainGroup: 'CFPilot', autoGroup: '自动选择' })
    expect(r.rules).toEqual([])
    expect(r.groups).toEqual([])
  })

  it('纯空白文本也返回空', () => {
    const r = renderRouteSections('   \n\n  \n', { mainGroup: 'CFPilot', autoGroup: '自动选择' })
    expect(r.rules).toEqual([])
  })

  it('正常 ini 产出规则与组', () => {
    const r = renderRouteSections(SAMPLE, { mainGroup: 'CFPilot', autoGroup: '自动选择' })
    expect(r.rules.length).toBeGreaterThan(0)
    expect(r.groups.length).toBeGreaterThan(0)
  })
})

describe('内置配置文件', () => {
  it('能解析出合理数量的规则与组', () => {
    // 用与内置 ini 同构的较大样本验证规模
    const lines: string[] = ['[custom]']
    for (let i = 0; i < 30; i++) {
      lines.push(`ruleset=组${i},https://example.com/list${i}.list`)
    }
    for (let i = 0; i < 10; i++) {
      // 反引号是 ini 的分隔符，用 String.fromCharCode(96) 避免与模板字符串冲突
      const bt = String.fromCharCode(96)
      lines.push(`custom_proxy_group=组${i}${bt}select${bt}[]DIRECT${bt}.*`)
    }
    const r = parseRouteProfile(lines.join('\n'))
    expect(r.rules).toHaveLength(30)
    expect(r.groups).toHaveLength(10)
  })
})
