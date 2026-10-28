import { describe, expect, it } from 'vitest'
import {
  buildDomainPool,
  buildOfficialPool,
  cleanIpLine,
  collectNodes,
  filterByCountries,
  mergePools,
  parseAddList,
  parseApiList,
  parseCsvText,
  parseLocalList,
  parseScannerRemark,
  renderBase64,
  renderClash,
  renderSingbox,
  sampleFromCidrs,
  type RenderContext,
} from '../src/sub-engine'
import { PREFERRED_DOMAINS } from '../src/data/pools'
import { base64Decode } from '../src/util'
import type { UserConfig } from '../src/types'

const config: UserConfig = {
  uuid: '11111111-2222-3333-4444-555555555555',
  trojanPassword: 'trojan-secret',
  wsPath: '/vless',
  trojanPath: '/trojan',
  xhttpPath: '/xhttp',
  add: '',
  addApi: '',
  addCsv: '',
  poolOfficial: true,
  officialCount: 20,
  poolDomain: true,
  domainCount: 10,
  poolManual: false,
  poolCountries: '',
  dls: 0,
  maxLatency: 0,
  maxNodes: 0,
  proxyIp: '',
  socks5: '',
  httpProxy: '',
  proxyMode: 'only',
  nat64: '',
  concurrentDial: true,
  resolvePreferred: true,
  relayPool: '',
  useBuiltinRelay: true,
  subVariants: 'vless-ws',
  subName: 'CFPilot',
  subPorts: '443',
  enableTrojan: true,
  enableXhttp: true,
  subDomain: '',
  subProtocol: 'both',
  subTransport: 'both',
  clientFingerprint: 'chrome',
  ech: false,
  echHost: 'cloudflare-ech.com',
  echDns: '',
  tlsFragment: false,
  tlsFragmentSize: '10-20',
  tlsFragmentDelay: '10-20',
}

describe('cleanIpLine', () => {
  it('清洗裸 IP', () => {
    expect(cleanIpLine('1.2.3.4')).toEqual({ ip: '1.2.3.4', port: 443, remark: '' })
  })

  it('清洗 IP:端口', () => {
    expect(cleanIpLine('1.2.3.4:8443')).toEqual({ ip: '1.2.3.4', port: 8443, remark: '' })
  })

  it('清洗 IP:端口#备注', () => {
    expect(cleanIpLine('1.2.3.4:8443#HKG 优选')).toEqual({
      ip: '1.2.3.4',
      port: 8443,
      remark: 'HKG 优选',
    })
  })

  it('清洗 [IPv6]:端口#备注', () => {
    expect(cleanIpLine('[2606:4700::1]:443#LAX')).toEqual({
      ip: '2606:4700::1',
      port: 443,
      remark: 'LAX',
    })
  })

  it('清洗裸 IPv6（无端口）', () => {
    expect(cleanIpLine('2606:4700::1')).toEqual({ ip: '2606:4700::1', port: 443, remark: '' })
  })

  it('清洗优选域名', () => {
    expect(cleanIpLine('cdn.example.com:443#优选域名')).toEqual({
      ip: 'cdn.example.com',
      port: 443,
      remark: '优选域名',
    })
  })

  it('忽略注释与空行', () => {
    expect(cleanIpLine('# 这是注释')).toBeNull()
    expect(cleanIpLine('   ')).toBeNull()
    expect(cleanIpLine('')).toBeNull()
  })

  it('拒绝非法端口', () => {
    expect(cleanIpLine('1.2.3.4:99999')).toBeNull()
    expect(cleanIpLine('1.2.3.4:abc')).toBeNull()
  })

  it('兼容 CSV 行里的引号包裹', () => {
    expect(cleanIpLine('"1.2.3.4:443"')).toEqual({ ip: '1.2.3.4', port: 443, remark: '' })
  })
})

describe('parseScannerRemark', () => {
  it('解析 机房_延迟_速度', () => {
    expect(parseScannerRemark('SJC_12_35.5')).toEqual({ colo: 'SJC', latency: 12, speed: 35.5 })
  })

  it('解析只有机房与延迟', () => {
    expect(parseScannerRemark('LAX_88')).toEqual({ colo: 'LAX', latency: 88, speed: 0 })
  })

  it('无法解析时返回空值', () => {
    expect(parseScannerRemark('普通备注')).toEqual({ colo: '', latency: 0, speed: 0 })
  })
})

describe('parseLocalList / parseAddList / parseApiList', () => {
  it('解析本地优选池并识别来源', () => {
    const entries = parseLocalList('1.2.3.4:443#SJC_12_35.5\n[2606:4700::1]:443#LAX_20_10.2\n')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.source).toBe('local')
    expect(entries[0]!.colo).toBe('SJC')
    expect(entries[0]!.latency).toBe(12)
    expect(entries[0]!.speed).toBe(35.5)
    expect(entries[1]!.ip).toBe('2606:4700::1')
    expect(entries[1]!.port).toBe(443)
  })

  it('区分 add 与 addapi 来源', () => {
    expect(parseAddList('1.1.1.1')[0]!.source).toBe('add')
    expect(parseApiList('1.1.1.1')[0]!.source).toBe('addapi')
  })
})

describe('parseCsvText', () => {
  const csvWithHeader = [
    'IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s),机房',
    '1.2.3.4,100,200,0,88.5,12.30,HKG',
    '5.6.7.8,100,200,0,250.0,3.20,LAX',
  ].join('\n')

  it('识别中文表头并按列解析', () => {
    const result = parseCsvText(csvWithHeader)
    expect(result.hasHeader).toBe(true)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.ip).toBe('1.2.3.4')
    expect(result.entries[0]!.latency).toBe(88.5)
    expect(result.entries[0]!.speed).toBe(12.3)
    expect(result.entries[0]!.colo).toBe('HKG')
  })

  it('按 DLS 与 MAX_LATENCY 过滤', () => {
    const result = parseCsvText(csvWithHeader, { dls: 10 })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.ip).toBe('1.2.3.4')
    expect(result.filtered).toBe(1)

    const byLatency = parseCsvText(csvWithHeader, { maxLatency: 100 })
    expect(byLatency.entries).toHaveLength(1)
    expect(byLatency.entries[0]!.ip).toBe('1.2.3.4')
  })

  it('解析英文表头', () => {
    const csv = 'IP Address,Download Speed (MB/s),Latency,Colo\n9.9.9.9,20.5,33,HKG'
    const result = parseCsvText(csv)
    expect(result.hasHeader).toBe(true)
    expect(result.entries[0]!.ip).toBe('9.9.9.9')
    expect(result.entries[0]!.speed).toBe(20.5)
    expect(result.entries[0]!.latency).toBe(33)
  })

  it('无表头时启发式解析', () => {
    const csv = '1.2.3.4,443,25.6,120.5,SJC\n5.6.7.8,443,3.2,300,LAX'
    const result = parseCsvText(csv)
    expect(result.hasHeader).toBe(false)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.ip).toBe('1.2.3.4')
    expect(result.entries[0]!.speed).toBe(25.6)
    expect(result.entries[0]!.latency).toBe(120.5)
  })

  it('忽略无法识别的行', () => {
    const result = parseCsvText('垃圾行\n1.2.3.4,443,10,20,SJC')
    expect(result.entries).toHaveLength(1)
  })
})

describe('mergePools', () => {
  it('按优先级去重：official 优先于 domain', () => {
    const merged = mergePools([
      { key: 'official', name: '官方优选IP', entries: [{ ...parseLocalList('1.1.1.1:443')[0]!, source: 'official' }] },
      { key: 'domain', name: '优选域名', entries: [{ ...parseAddList('1.1.1.1:443')[0]!, source: 'domain' }] },
      { key: 'csv', name: '测速CSV', entries: [{ ...parseAddList('2.2.2.2:443')[0]!, source: 'addcsv' }] },
    ])
    expect(merged.nodes).toHaveLength(2)
    expect(merged.nodes[0]!.source).toBe('official')
    expect(merged.nodes[1]!.source).toBe('addcsv')
    expect(merged.deduped).toBe(1)
  })

  it('同 ip 不同端口视为不同节点', () => {
    const merged = mergePools([
      { key: 'official', name: '官方优选IP', entries: [{ ...parseLocalList('1.1.1.1:443')[0]!, source: 'official' }] },
      { key: 'domain', name: '优选域名', entries: [{ ...parseAddList('1.1.1.1:8443')[0]!, source: 'domain' }] },
    ])
    expect(merged.nodes).toHaveLength(2)
  })
})

describe('内置优选库', () => {
  it('官方优选 IP 按数量生成且互不重复', () => {
    const entries = buildOfficialPool(50)
    expect(entries).toHaveLength(50)
    expect(new Set(entries.map((e) => e.ip)).size).toBe(50)
    for (const entry of entries) expect(entry.ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
  })

  it('优选域名随机取样不重复，且不超过库容量', () => {
    const entries = buildDomainPool(10)
    expect(entries).toHaveLength(10)
    expect(new Set(entries.map((e) => e.ip)).size).toBe(10)
    expect(buildDomainPool(999)).toHaveLength(PREFERRED_DOMAINS.length)
  })

  it('CIDR 抽样结果落在网段内', () => {
    const ips = sampleFromCidrs(['104.16.0.0/13'], 20)
    expect(ips).toHaveLength(20)
    for (const ip of ips) {
      const [a, b] = ip.split('.').map(Number)
      expect(a).toBe(104)
      expect(b).toBeGreaterThanOrEqual(16)
      expect(b).toBeLessThanOrEqual(23)
    }
  })

  it('国家筛选只保留机房已知且匹配的条目', () => {
    const entries = [
      { ip: '1.1.1.1', port: 443, remark: 'HKG_10_5', colo: 'HKG', latency: 10, speed: 5, source: 'local' as const, country: 'HK' },
      { ip: '2.2.2.2', port: 443, remark: 'NRT_20_3', colo: 'NRT', latency: 20, speed: 3, source: 'local' as const, country: 'JP' },
      { ip: '3.3.3.3', port: 443, remark: '', colo: '', latency: 0, speed: 0, source: 'official' as const, country: '' },
    ]
    expect(filterByCountries(entries, ['HK']).map((e) => e.ip)).toEqual(['1.1.1.1'])
    expect(filterByCountries(entries, ['HK', 'JP'])).toHaveLength(2)
    expect(filterByCountries(entries, [])).toHaveLength(3)
  })
})

describe('collectNodes 零配置兜底', () => {
  it('三个来源都未勾选时自动给 20 官方 IP + 10 优选域名', async () => {
    const result = await collectNodes(
      { ...config, poolOfficial: false, poolDomain: false, poolManual: false },
      ''
    )
    expect(result.groups.map((g) => g.key)).toEqual(['official', 'domain'])
    expect(result.stats.official).toBe(20)
    expect(result.stats.domain).toBe(10)
    expect(result.nodes).toHaveLength(30)
  })

  it('勾选手动来源但池为空时给出可读提示', async () => {
    const result = await collectNodes(
      { ...config, poolOfficial: false, poolDomain: false, poolManual: true },
      ''
    )
    expect(result.stats.errors.join()).toContain('手动优选 IP 为空')
  })
})

describe('订阅输出', () => {
  const ctx: RenderContext = {
    nodes: [
      { ip: '1.2.3.4', port: 443, remark: 'SJC_12_35.5', colo: 'SJC', latency: 12, speed: 35.5, source: 'local' },
      { ip: '2606:4700::1', port: 443, remark: 'LAX', colo: 'LAX', latency: 20, speed: 10, source: 'local' },
    ],
    config,
    domain: 'cfpilot.example.com',
    port: 443,
    ports: [443],
    protocol: 'both',
    transport: 'both',
  }

  it('Base64 订阅包含 VLESS / Trojan / XHTTP 链接且 SNI 正确', () => {
    // 显式勾选三种形态（默认只勾 vless-ws）
    const body = renderBase64({ ...ctx, config: { ...ctx.config, subVariants: 'vless-ws,vless-xhttp,trojan' } })
    const decoded = base64Decode(body)
    const links = decoded.split('\n')
    expect(links.some((l) => l.startsWith('vless://') && l.includes('sni=cfpilot.example.com'))).toBe(true)
    expect(links.some((l) => l.startsWith('vless://') && l.includes('type=xhttp'))).toBe(true)
    expect(links.some((l) => l.startsWith('trojan://'))).toBe(true)
    expect(links.some((l) => l.includes('[2606:4700::1]:443'))).toBe(true)
    for (const link of links) {
      expect(link).toContain('host=cfpilot.example.com')
    }
  })

  it('Clash YAML 关键字段完整', () => {
    const yaml = renderClash({ ...ctx, config: { ...ctx.config, subVariants: 'vless-ws,trojan' } })
    expect(yaml).toContain('type: vless')
    expect(yaml).toContain('type: trojan')
    expect(yaml).toContain('server: 1.2.3.4')
    expect(yaml).toContain('servername: cfpilot.example.com')
    expect(yaml).toContain('path: "/vless"')
    expect(yaml).toContain('Host: cfpilot.example.com')
    expect(yaml).toContain('proxy-groups:')
  })

  it('Sing-box JSON 结构合法', () => {
    const json = JSON.parse(renderSingbox(ctx))
    expect(Array.isArray(json.outbounds)).toBe(true)
    const vless = json.outbounds.find((o: any) => o.type === 'vless')
    expect(vless.server).toBe('1.2.3.4')
    expect(vless.server_port).toBe(443)
    expect(vless.tls.server_name).toBe('cfpilot.example.com')
    expect(vless.transport.type).toBe('ws')
    expect(vless.transport.path).toBe('/vless')
  })
})

describe('端到端：默认配置渲染三种订阅', () => {
  it('默认配置产出 30 个节点，三种格式都按来源分组', async () => {
    const collected = await collectNodes(config, '')
    expect(collected.nodes).toHaveLength(30)
    expect(collected.groups.map((g) => g.key)).toEqual(['official', 'domain'])

    const fullCtx: RenderContext = {
      nodes: collected.nodes,
      groups: collected.groups,
      config,
      domain: 'cfpilot.example.com',
      port: 443,
      ports: [443],
      protocol: 'both',
      transport: 'both',
    }

    // ⚠️ 默认只勾 vless-ws → **30 个节点就是 30 条链接**（不再乘三）。
    // 旧行为（subProtocol=both × subTransport=both）会生成 30 × 3 = 90 条，
    // 客户端里多出大量用不了的 XHTTP / Trojan 节点，测速全是 -1。
    const links = base64Decode(renderBase64(fullCtx)).split('\n')
    expect(links).toHaveLength(30)
    expect(links.every((l) => l.includes('sni=cfpilot.example.com'))).toBe(true)
    expect(links.every((l) => l.startsWith('vless://') && l.includes('type=ws'))).toBe(true)

    // 显式勾选三种形态 → 才会展开成 90 条
    const allCtx: RenderContext = {
      ...fullCtx,
      config: { ...config, subVariants: 'vless-ws,vless-xhttp,trojan' },
    }
    const allLinks = base64Decode(renderBase64(allCtx)).split('\n')
    expect(allLinks).toHaveLength(90)

    // Clash 主组是扁平的：所有节点直接列在 CFPilot 组里（避免客户端只显示分组）
    const yaml = renderClash(fullCtx)
    expect(yaml).toContain('- name: "CFPilot"')
    expect(yaml).toContain('官方优选IP')
    expect(yaml).toContain('优选域名')

    const json = JSON.parse(renderSingbox(fullCtx))
    const tags = json.outbounds
      .filter((o: { type?: string }) => o.type === 'selector')
      .map((o: { tag: string }) => o.tag)
    expect(tags).toContain('CFPilot')
    expect(tags).toContain('官方优选IP')
    expect(tags).toContain('优选域名')
  })
})
