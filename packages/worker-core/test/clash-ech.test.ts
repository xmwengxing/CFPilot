/**
 * Clash YAML 模板的客户端兼容性测试。
 *
 * ## 关注点
 *
 * 目标是让 **Clash Verge Rev（mihomo 内核）直接导入订阅 URL 就能用**：
 *   1. 不下发 `external-controller` —— 客户端自己管理，写死会与客户端端口冲突；
 *   2. 用 `mixed-port` —— mihomo 只认这个字段；
 *   3. 节点字段齐全（vless / trojan 各自的必填项）；
 *   4. 组与规则的引用完整，不指向不存在的名字；
 *   5. 带 `dns` 段 —— ECH 需要 DoH 解析。
 */
import { describe, expect, it } from 'vitest'
import { renderClash, type RenderContext } from '../src/sub-engine'
import type { UserConfig } from '../src/types'

function makeConfig(over: Partial<UserConfig> = {}): UserConfig {
  return {
    uuid: '11111111-2222-3333-4444-555555555555',
    trojanPassword: 'tp-pass',
    wsPath: '/abc123',
    trojanPath: '/trojan',
    xhttpPath: '/xhttp',
    add: '', addApi: '', addCsv: '',
    poolOfficial: true, officialCount: 20, poolDomain: true, domainCount: 10,
    poolManual: false, poolCountries: '', dls: 0, maxLatency: 0, maxNodes: 0,
    proxyIp: '', socks5: '', httpProxy: '', nat64: '', concurrentDial: true,
    resolvePreferred: true,
    relayPool: '',
    useBuiltinRelay: true,
    subVariants: 'vless-ws',
    subName: 'CFPilot',
    subPorts: '443',
    enableTrojan: true, enableXhttp: true,
    subDomain: '', subProtocol: 'both', subTransport: 'ws',
    clientFingerprint: 'chrome',
    ech: false, echHost: 'cloudflare-ech.com', echDns: '',
    tlsFragment: false, tlsFragmentSize: '10-20', tlsFragmentDelay: '10-20',
    ...over,
  }
}

function makeCtx(over: Partial<UserConfig> = {}): RenderContext {
  return {
    nodes: [
      { ip: '1.2.3.4', port: 443, remark: 'SJC_优选', colo: 'SJC', latency: 12, speed: 35.5, source: 'local' },
      { ip: '2606:4700::1', port: 443, remark: 'LAX', colo: 'LAX', latency: 20, speed: 10, source: 'local' },
    ],
    groups: [],
    config: makeConfig(over),
    domain: 'cfpilot.example.com',
    port: 443,
    ports: [443],
    protocol: 'both',
    transport: 'ws',
  }
}

describe('Clash YAML：Clash Verge 兼容性', () => {
  it('不下发 external-controller（会与客户端自身端口冲突）', () => {
    const yaml = renderClash(makeCtx())
    expect(yaml).not.toContain('external-controller')
  })

  it('使用 mixed-port 而不是老 Clash 的 port / socks-port', () => {
    const yaml = renderClash(makeCtx())
    expect(yaml).toContain('mixed-port:')
    expect(yaml).not.toMatch(/^port:\s/m)
    expect(yaml).not.toMatch(/^socks-port:\s/m)
  })

  it('顶层必需段齐全：proxies / proxy-groups / rules / dns', () => {
    const yaml = renderClash(makeCtx())
    expect(yaml).toMatch(/^proxies:/m)
    expect(yaml).toMatch(/^proxy-groups:/m)
    expect(yaml).toMatch(/^rules:/m)
    expect(yaml).toMatch(/^dns:/m)
    expect(yaml).toContain('mode: rule')
    expect(yaml).toContain('allow-lan: false')
  })

  it('vless / trojan 节点字段齐全', () => {
    // 显式勾选两种形态（默认只勾 vless-ws）
    const yaml = renderClash(makeCtx({ subVariants: 'vless-ws,trojan' }))
    // vless：uuid / server / port / network / tls / servername / ws-opts
    expect(yaml).toContain('type: vless')
    expect(yaml).toContain('uuid: 11111111-2222-3333-4444-555555555555')
    expect(yaml).toContain('servername: cfpilot.example.com')
    expect(yaml).toContain('client-fingerprint: chrome')
    expect(yaml).toContain('ws-opts:')
    expect(yaml).toContain('path: "/abc123"')
    expect(yaml).toContain('Host: cfpilot.example.com')
    // trojan：password / sni
    expect(yaml).toContain('type: trojan')
    expect(yaml).toContain('password: "tp-pass"')
    expect(yaml).toContain('sni: cfpilot.example.com')
  })

  it('proxy-groups 与 rules 引用的名字都真实存在', () => {
    const yaml = renderClash(makeCtx())
    // 提取所有 `- name: "xxx"` 作为节点/组名
    const names = new Set<string>()
    const re = /^\s*- name: "(.+)"$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(yaml)) !== null) names.add(m[1]!)

    // 提取 proxy-groups 下引用的名字
    const groupRefs = [...yaml.matchAll(/^      - "(.+)"$/gm)].map((x) => x[1]!)
    for (const ref of groupRefs) {
      expect(names.has(ref!), `组引用了不存在的节点「${ref}」`).toBe(true)
    }

    // rules 的目标组必须存在
    //
    // ⚠️ 规则格式可能是 `TYPE,VALUE,TARGET` 或 `TYPE,VALUE,TARGET,no-resolve`：
    // `no-resolve` / `src` 等是**修饰符**，不是策略名。
    // 早前用「取最后一个字段」当目标，遇到 `GEOIP,LAN,DIRECT,no-resolve`
    // 就把 `no-resolve` 误判成目标组而误报。
    const MODIFIERS = new Set(['no-resolve', 'src'])
    const ruleTargets = yaml
      .split('\n')
      .filter((l) => /^\s+- [A-Z]+,/.test(l))
      .map((l) => {
        const parts = l.trim().replace(/^-\s*/, '').split(',').map((p) => p.trim())
        // 从末尾往前找第一个「不是修饰符」的字段，它就是策略名
        for (let i = parts.length - 1; i >= 2; i--) {
          if (!MODIFIERS.has(parts[i]!.toLowerCase())) return parts[i]!
        }
        return parts[parts.length - 1]!
      })
    for (const t of ruleTargets) {
      // DIRECT / REJECT 是 mihomo 内置策略，不出现在 proxies / proxy-groups 里
      if (t === 'DIRECT' || t === 'REJECT') continue
      expect(names.has(t), `规则指向了不存在的目标「${t}」`).toBe(true)
    }
  })

  it('不下发 RULE-SET（缺 rule-providers 会让订阅整体加载失败）', () => {
    // 线上事故：早前把远端 ruleset 翻译成 `RULE-SET,<name>,<策略>`，
    // 但没有配套的 `rule-providers:` 段，Clash 报
    // `rules[3] [RULE-SET,CFnat,DIRECT] error: rule set [CFnat] not found`。
    const yaml = renderClash(makeCtx())
    expect(yaml).not.toContain('RULE-SET')
    expect(yaml).not.toContain('rule-providers')
  })

  it('rules 以 MATCH 结尾（否则未匹配流量无去向）', () => {
    const yaml = renderClash(makeCtx())
    const ruleLines = yaml
      .split('\n')
      .filter((l) => /^\s+- [A-Z]+,/.test(l))
    expect(ruleLines.length).toBeGreaterThan(0)
    expect(ruleLines[ruleLines.length - 1]!.trim()).toContain('MATCH,')
  })

  it('节点名两两不重复（mihomo 要求组内名字唯一）', () => {
    const yaml = renderClash(makeCtx())
    const proxyNames = [...yaml.matchAll(/^  - name: "(.+)"$/gm)].map((x) => x[1]!)
    expect(proxyNames.length).toBeGreaterThan(0)
    expect(new Set(proxyNames).size).toBe(proxyNames.length)
  })
})

describe('ECH（Encrypted Client Hello）', () => {
  it('默认关闭：不注入任何 ECH 参数', () => {
    const ctx = makeCtx()
    expect(ctx.config.ech).toBe(false)
    const yaml = renderClash(ctx)
    expect(yaml).not.toContain('ech-opts')
    expect(yaml).not.toContain('query-server-name')
  })

  it('开启后：Clash YAML 注入 ech-opts 块', () => {
    const yaml = renderClash(makeCtx({ ech: true, subVariants: 'vless-ws,trojan' }))
    expect(yaml).toContain('ech-opts:')
    expect(yaml).toContain('enable: true')
    expect(yaml).toContain('query-server-name: "cloudflare-ech.com"')
    // vless 与 trojan 节点都要有
    const count = yaml.split('ech-opts:').length - 1
    expect(count).toBe(4) // 2 个节点 × (vless + trojan)
  })

  it('开启后：dns 段给出 ECH 服务器名的 nameserver-policy', () => {
    const yaml = renderClash(makeCtx({ ech: true }))
    expect(yaml).toContain('nameserver-policy:')
    expect(yaml).toContain('"cloudflare-ech.com"')
  })

  it('开启后：自定义 ECH 主机名与 DoH 生效', () => {
    const yaml = renderClash(makeCtx({ ech: true, echHost: 'my.ech.example', echDns: 'https://dns.example/dns-query' }))
    expect(yaml).toContain('query-server-name: "my.ech.example"')
    expect(yaml).toContain('"my.ech.example": "https://dns.example/dns-query"')
  })

  it('开启后：分享链接注入 ech 参数（edgetunnel 的 ech=<SNI>+<DoH> 约定）', () => {
    const ctx = makeCtx({ ech: true })
    const links = base64Decode(renderBase64Local(ctx)).split('\n')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toContain('ech=')
      expect(decodeURIComponent(link)).toContain('ech=cloudflare-ech.com')
    }
  })

  it('开启后：Sing-box 的 tls 里注入 ech 字段', () => {
    const json = JSON.parse(renderSingboxLocal(makeCtx({ ech: true })))
    const vless = json.outbounds.find((o: { type?: string }) => o.type === 'vless')
    expect(vless.tls.ech).toEqual({ enabled: true, query_server_name: 'cloudflare-ech.com' })
  })

  it('关闭时 Sing-box 不含 ech 字段', () => {
    const json = JSON.parse(renderSingboxLocal(makeCtx()))
    const vless = json.outbounds.find((o: { type?: string }) => o.type === 'vless')
    expect(vless.tls.ech).toBeUndefined()
  })
})

// 本地辅助：直接调用渲染函数，避免与主测试文件耦合
import { renderBase64 as renderBase64Local, renderSingbox as renderSingboxLocal } from '../src/sub-engine'
import { base64Decode } from '../src/util'
