/**
 * 订阅「节点形态」选择测试。
 *
 * 守护的是用户报告的问题：**默认下发 30 个节点，订阅里却有 90 个**
 * —— 因为老的 `subProtocol`（vless/trojan/both）× `subTransport`（ws/xhttp/both）
 * 交叉后必然生成三种形态，节点数被乘三。
 *
 * 同时锁定「入站没启用就不下发该形态」——
 * 否则会出现「XHTTP 入站关着，订阅里却有 XHTTP 节点」，
 * 客户端测速全是 -1，看起来像节点坏了。
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_SUB_VARIANTS,
  WS_ONLY_VARIANTS,
  resolveSubVariants,
  renderBase64,
  renderClash,
  renderSingbox,
  type RenderContext,
} from '../src/sub-engine'
import type { UserConfig } from '../src/types'

const config = (over: Partial<UserConfig> = {}): UserConfig =>
  ({
    uuid: 'u-uuid',
    trojanPassword: 'tp',
    wsPath: '/ws',
    trojanPath: '/trojan',
    xhttpPath: '/xhttp',
    subDomain: '',
    subProtocol: 'both',
    subTransport: 'both',
    subVariants: 'vless-ws',
    clientFingerprint: 'chrome',
    ech: false,
    echHost: '',
    echDns: '',
    enableTrojan: true,
    enableXhttp: true,
    ...over,
  }) as UserConfig

const nodes = [
  { ip: '1.1.1.1', port: 443, remark: '', colo: '', latency: 0, speed: 0, source: 'official' as const, country: '' },
  { ip: '2.2.2.2', port: 443, remark: '', colo: '', latency: 0, speed: 0, source: 'official' as const, country: '' },
]

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  nodes,
  config: config(),
  domain: 'example.pages.dev',
  port: 443,
  protocol: 'both',
  transport: 'both',
  ...over,
})

describe('resolveSubVariants', () => {
  it('默认只勾 vless-ws', () => {
    expect(resolveSubVariants('vless-ws', config())).toEqual(['vless-ws'])
  })

  it('可多选', () => {
    expect(resolveSubVariants('vless-ws,trojan', config())).toEqual(['vless-ws', 'trojan'])
  })

  it('三种全选时保持面板顺序', () => {
    expect(resolveSubVariants('trojan,vless-xhttp,vless-ws', config())).toEqual([
      'vless-ws',
      'vless-xhttp',
      'trojan',
    ])
  })

  it('XHTTP 入站未启用 → 剔除 xhttp 形态', () => {
    const got = resolveSubVariants('vless-ws,vless-xhttp', config({ enableXhttp: false }))
    expect(got).toEqual(['vless-ws'])
  })

  it('Trojan 入站未启用 → 剔除 trojan 形态', () => {
    const got = resolveSubVariants('vless-ws,trojan', config({ enableTrojan: false }))
    expect(got).toEqual(['vless-ws'])
  })

  it('空配置回落到 vless-ws（订阅不为空）', () => {
    expect(resolveSubVariants('', config())).toEqual(['vless-ws'])
    expect(resolveSubVariants(undefined, config())).toEqual(['vless-ws'])
  })

  it('格式不支持某形态时剔除它', () => {
    // Clash / sing-box 不支持 XHTTP
    const got = resolveSubVariants('vless-ws,vless-xhttp', config(), WS_ONLY_VARIANTS)
    expect(got).toEqual(['vless-ws'])
  })

  it('只剩格式不支持的形态时回落到该格式支持的形态', () => {
    const got = resolveSubVariants('vless-xhttp', config(), WS_ONLY_VARIANTS)
    expect(got).toEqual(['vless-ws'])
  })

  it('忽略未知取值', () => {
    expect(resolveSubVariants('vless-ws,bogus', config())).toEqual(['vless-ws'])
  })
})

describe('订阅节点数按形态展开', () => {
  const decode = (b64: string): string[] =>
    Buffer.from(b64, 'base64').toString('utf8').split('\n').filter(Boolean)

  it('只勾 vless-ws → 节点数不翻倍', () => {
    const body = renderBase64(ctx({ config: config({ subVariants: 'vless-ws' }) }))
    expect(decode(body)).toHaveLength(2)
  })

  it('勾选三种 → 每节点生成三条', () => {
    const body = renderBase64(ctx({ config: config({ subVariants: 'vless-ws,vless-xhttp,trojan' }) }))
    const lines = decode(body)
    expect(lines).toHaveLength(6)
    expect(lines.filter((l) => l.startsWith('vless://') && l.includes('type=ws'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes('type=xhttp'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('trojan://'))).toHaveLength(2)
  })

  it('XHTTP 入站关闭 → 订阅里不含 xhttp 节点', () => {
    const body = renderBase64(
      ctx({ config: config({ subVariants: 'vless-ws,vless-xhttp', enableXhttp: false }) })
    )
    expect(decode(body).some((l) => l.includes('type=xhttp'))).toBe(false)
  })

  it('Clash 格式不含 xhttp 节点（Clash 不支持该传输）', () => {
    const yaml = renderClash(ctx({ config: config({ subVariants: 'vless-ws,vless-xhttp' }) }))
    expect(yaml).not.toContain('network: xhttp')
  })

  it('Sing-box 格式不含 xhttp 节点', () => {
    const json = JSON.parse(
      renderSingbox(ctx({ config: config({ subVariants: 'vless-ws,vless-xhttp' }) }))
    ) as { outbounds: Array<{ transport?: { type?: string } }> }
    expect(json.outbounds.some((o) => o.transport?.type === 'xhttp')).toBe(false)
  })

  it('默认配置下节点数 = 节点池大小（不再乘三）', () => {
    const body = renderBase64(ctx())
    expect(decode(body)).toHaveLength(nodes.length)
  })
})

describe('形态常量', () => {
  it('三种形态齐全', () => {
    expect(ALL_SUB_VARIANTS).toEqual(['vless-ws', 'vless-xhttp', 'trojan'])
  })

  it('WS_ONLY 只含 ws 系', () => {
    expect(WS_ONLY_VARIANTS).toEqual(['vless-ws', 'trojan'])
  })
})
