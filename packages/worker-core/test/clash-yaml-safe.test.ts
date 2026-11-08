/**
 * Clash YAML 字符串安全回归。
 *
 * 节点备注来自本地优选 IP 池 / CSV 的 `#备注`，是用户输入。
 * 双引号标量里 `:` / `#` / `{}` / `'` 都是字面量，真正会让整份订阅解析失败的
 * 只有控制字符（尤其换行）与未转义的 `\` / `"`。这里逐项钉住。
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
    proxyMode: 'only',
    poolOfficial: true, officialCount: 20, poolDomain: true, domainCount: 10,
    poolManual: false, poolCountries: '', dls: 0, maxLatency: 0, maxNodes: 0,
    proxyIp: '', socks5: '', httpProxy: '', nat64: '', concurrentDial: true, dataBudgetMB: 0,
    resolvePreferred: true,
    aggressiveRedial: false,
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
    subToken: 'legacy',
    subTokenTtlDays: 0,
    unlockProbe: false,
    udpDns: 'off',
    udpDnsEndpoint: 'https://dns.google/dns-query',
    ...over,
  }
}

function makeCtx(remark: string, over: Partial<UserConfig> = {}): RenderContext {
  return {
    nodes: [
      { ip: '1.2.3.4', port: 443, remark, colo: 'SJC', latency: 12, speed: 35.5, source: 'local' },
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

/** 合法的 YAML 双引号标量：内容只能由「普通字符」或「反斜杠转义」组成 */
const DOUBLE_QUOTED_SCALAR = /^"(?:[^"\\]|\\.)*"$/

describe('Clash YAML 字符串安全', () => {
  it('备注含换行 / 冒号 / 井号 / 引号时仍是合法双引号标量', () => {
    const remark = '香港: #1\r\nname: injected\n单\'引号 "双引号" 反斜杠\\ 结尾'
    const yaml = renderClash(makeCtx(remark))
    const lines = yaml.split('\n')
    const nameLines = lines.filter((l) => /^\s*- name:/.test(l))

    expect(nameLines.length).toBeGreaterThan(0)
    for (const line of nameLines) {
      expect(line.replace(/^\s*- name:\s*/, '')).toMatch(DOUBLE_QUOTED_SCALAR)
    }
    // 注入不能凭空造出独立的 YAML 键，也不能把控制字符带进文档
    expect(lines.some((l) => /^\s*name: injected\s*$/.test(l))).toBe(false)
    expect(yaml).not.toContain('\r')
    expect(yaml).not.toContain('\u0000')
    // 备注里的双引号被正确转义
    expect(yaml).toContain(String.raw`\"双引号\"`)
    expect(yaml).toContain(String.raw`反斜杠\\`)
  })

  it('配置字段里的单引号、双引号与反斜杠按字面量保留', () => {
    const yaml = renderClash(makeCtx('正常备注', {
      subVariants: 'vless-ws,trojan',
      trojanPassword: `pa'ss"word\\tail`,
      wsPath: `/vl'ess`,
    }))
    expect(yaml).toContain(String.raw`password: "pa'ss\"word\\tail"`)
    expect(yaml).toContain(`path: "/vl'ess"`)
  })

  it('所有 name 行都是完整双引号标量（含分组引用）', () => {
    const yaml = renderClash(makeCtx('SJC_优选'))
    for (const line of yaml.split('\n').filter((l) => /^\s*- name:/.test(l))) {
      expect(line.replace(/^\s*- name:\s*/, '')).toMatch(DOUBLE_QUOTED_SCALAR)
    }
  })
})
