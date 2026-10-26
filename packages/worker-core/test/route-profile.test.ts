/**
 * 分流规则 —— 回归测试。
 *
 * ## 2026-10-26 重要修正
 *
 * 早前实现把 ACL4SSR 风格的 ini 用 gzip+base64 内嵌进部署代码，
 * 并把其中远端 `ruleset=` 翻译成 `RULE-SET,<name>,<策略>`，
 * 但**没有生成配套的 `rule-providers:` 段** → Clash 报
 *
 *     rules[3] [RULE-SET,CFnat,DIRECT] error: rule set [CFnat] not found
 *
 * **整个订阅加载失败**，用户一个节点都用不了。
 *
 * 现在改为 `buildBuiltinRules()` 生成的 GEOSITE/GEOIP 内置规则：
 * 零外部依赖、零下载、兼容所有 Clash / mihomo。
 */
import { describe, expect, it } from 'vitest'
import {
  buildBuiltinRules,
  parseRouteProfile,
  renderRouteProfile,
  renderRouteSections,
} from '../src/route-profile'

/** 模拟 KV 里用户自定义的 ini（含远端 ruleset，应被忽略） */
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

  it('远端 ruleset 被完全忽略（不再生成 RULE-SET）', () => {
    // ⚠️ 2026-10-26 线上事故回归：
    // 早前把 `ruleset=<组>,<URL>` 翻译成 `RULE-SET,<name>,<策略>`，
    // 但没有配套的 `rule-providers:` 段 → Clash 报
    // `rule set [CFnat] not found`，**整个订阅加载失败**。
    //
    // 现在远端 ruleset 一律忽略，只保留内联 GEOIP 类规则。
    const ruleText = out.rules.join('\n')
    expect(ruleText).not.toContain('RULE-SET')
    expect(ruleText).not.toContain('YouTube')
    expect(ruleText).not.toContain('CFnat')
  })

  it('只输出合法的内置规则类型', () => {
    for (const line of out.rules) {
      const body = line.trim().replace(/^-\s*/, '')
      const kind = body.split(',')[0]!.toUpperCase()
      // 允许的规则类型：GEOSITE / GEOIP / MATCH / DOMAIN 系列 / IP-CIDR 等
      expect(
        ['GEOSITE', 'GEOIP', 'MATCH', 'FINAL', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'PROCESS-NAME', 'DST-PORT'].includes(kind)
      ).toBe(true)
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

describe('buildBuiltinRules：内核内置分流规则', () => {
  const rules = buildBuiltinRules('CFPilot')

  it('不含任何 RULE-SET（否则需要 rule-providers）', () => {
    expect(rules.join('\n')).not.toContain('RULE-SET')
  })

  it('不含 rule-providers 引用', () => {
    expect(rules.join('\n')).not.toContain('rule-providers')
  })

  it('只使用 GEOSITE / GEOIP / MATCH 三类（Clash 内置，无需下载）', () => {
    for (const line of rules) {
      const body = line.trim().replace(/^-\s*/, '')
      const kind = body.split(',')[0]!.toUpperCase()
      expect(['GEOSITE', 'GEOIP', 'MATCH']).toContain(kind)
    }
  })

  it('必定以 MATCH 结尾（兜底规则）', () => {
    const last = rules[rules.length - 1]!.trim()
    expect(last).toBe('- MATCH,CFPilot')
  })

  it('包含媒体分流（YouTube / Netflix）', () => {
    const text = rules.join('\n')
    expect(text).toContain('GEOSITE,youtube')
    expect(text).toContain('GEOSITE,netflix')
  })

  it('包含 AI 服务分流（OpenAI 地区敏感）', () => {
    expect(rules.join('\n')).toContain('GEOSITE,openai')
  })

  it('国内流量直连（含局域网 no-resolve）', () => {
    const text = rules.join('\n')
    expect(text).toContain('GEOIP,LAN,DIRECT,no-resolve')
    expect(text).toContain('GEOSITE,cn,DIRECT')
    expect(text).toContain('GEOIP,CN,DIRECT')
  })

  it('广告拦截指向 REJECT', () => {
    expect(rules.join('\n')).toContain('category-ads-all,REJECT')
  })

  it('主组名可定制（不同订阅名也能正确引用）', () => {
    const custom = buildBuiltinRules('我的节点')
    expect(custom[custom.length - 1]!.trim()).toBe('- MATCH,我的节点')
    expect(custom.join('\n')).toContain('GEOSITE,youtube,我的节点')
  })

  it('国内直连规则排在 MATCH 之前（顺序决定优先级）', () => {
    const cnIdx = rules.findIndex((r) => r.includes('GEOIP,CN,DIRECT'))
    const matchIdx = rules.findIndex((r) => r.includes('MATCH,'))
    expect(cnIdx).toBeGreaterThan(-1)
    expect(cnIdx).toBeLessThan(matchIdx)
  })

  it('规则数量合理（不会被误删成空）', () => {
    expect(rules.length).toBeGreaterThan(15)
  })
})

describe('GEOSITE 分类安全（2026-10-26 事故回归）', () => {
  const rules = buildBuiltinRules('CFPilot')
  const categories = rules
    .filter((r) => r.includes('GEOSITE,'))
    .map((r) => r.trim().replace(/^-\s*GEOSITE,/, '').split(',')[0]!)

  it('绝不能使用 wikipedia 分类（geosite.dat 里不存在）', () => {
    // ⚠️ 线上事故：Clash Verge 报
    //   rules[18] [GEOSITE,wikipedia,CFPilot] error:
    //   list wikipedia not found in geosite.dat
    // **整份配置加载失败**。正确的是 wikimedia。
    expect(categories).not.toContain('wikipedia')
  })

  it('使用 wikimedia 而非 wikipedia', () => {
    expect(categories).toContain('wikimedia')
  })

  it('分类名不含空格与非法字符（避免解析歧义）', () => {
    for (const c of categories) {
      expect(c).toMatch(/^[A-Za-z0-9_!-]+$/)
    }
  })

  it('分类名不重复（重复会让内核重复加载）', () => {
    expect(new Set(categories).size).toBe(categories.length)
  })

  it('每个 GEOSITE 规则都有明确策略（不能只有类型和目标）', () => {
    for (const line of rules.filter((r) => r.includes('GEOSITE,'))) {
      const parts = line.trim().replace(/^-\s*/, '').split(',')
      expect(parts.length).toBeGreaterThanOrEqual(3)
      expect(parts[2]!.trim()).not.toBe('')
    }
  })

  it('核心分类都在（媒体 / AI / 国内直连）', () => {
    expect(categories).toEqual(
      expect.arrayContaining(['youtube', 'netflix', 'openai', 'github', 'cn'])
    )
  })
})
