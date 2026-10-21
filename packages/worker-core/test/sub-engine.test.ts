import { describe, expect, it } from 'vitest'
import {
  cleanIpLine,
  mergePools,
  parseAddList,
  parseApiList,
  parseCsvText,
  parseLocalList,
  parseScannerRemark,
  renderBase64,
  renderClash,
  renderSingbox,
  type RenderContext,
} from '../src/sub-engine'
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
  dls: 0,
  maxLatency: 0,
  maxNodes: 0,
  proxyIp: '',
  socks5: '',
  httpProxy: '',
  nat64: '',
  concurrentDial: true,
  enableTrojan: true,
  enableXhttp: true,
  subDomain: '',
  subProtocol: 'both',
  subTransport: 'both',
  clientFingerprint: 'chrome',
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
  it('按优先级去重：local 优先于 add', () => {
    const merged = mergePools([
      { source: 'local', entries: [{ ...parseLocalList('1.1.1.1:443')[0]! }] },
      { source: 'add', entries: [{ ...parseAddList('1.1.1.1:443')[0]! }] },
      { source: 'addcsv', entries: [{ ...parseAddList('2.2.2.2:443')[0]! }] },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]!.source).toBe('local')
    expect(merged[1]!.source).toBe('addcsv')
  })

  it('同 ip 不同端口视为不同节点', () => {
    const merged = mergePools([
      { source: 'local', entries: [{ ...parseLocalList('1.1.1.1:443')[0]! }] },
      { source: 'add', entries: [{ ...parseAddList('1.1.1.1:8443')[0]! }] },
    ])
    expect(merged).toHaveLength(2)
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
    protocol: 'both',
    transport: 'both',
  }

  it('Base64 订阅包含 VLESS / Trojan / XHTTP 链接且 SNI 正确', () => {
    const body = renderBase64(ctx)
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
    const yaml = renderClash(ctx)
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
