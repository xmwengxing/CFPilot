/**
 * CSV 优选列表解析增强 —— 回归测试。
 *
 * 守护 借鉴 cfnew `normalizePreferredList` 的三项增强：
 *   1. **TLS 列过滤** —— `TLS=false` 的行对 VLESS-WS 无用（客户端到边缘必须 TLS）
 *   2. **国家 / 城市列** —— 填进 remark，客户端里显示「洛杉矶」而非裸 IP
 *   3. **无表头时的国家/城市启发式** —— 中文文本列按长度/后缀判城市或国家
 */
import { describe, expect, it } from 'vitest'
import { parseCsvText } from '../src/sub-engine'

describe('parseCsvText：TLS 列过滤', () => {
  it('TLS=false 的行被丢弃并计数', () => {
    const csv = [
      'IP地址,端口,下载速度,平均延迟,TLS',
      '104.16.1.1,443,10.5,120,true',
      '104.16.2.2,443,8.2,180,false',
      '104.16.3.3,443,5.1,220,true',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.hasHeader).toBe(true)
    expect(r.entries.map((e) => e.ip)).toEqual(['104.16.1.1', '104.16.3.3'])
    expect(r.tlsDropped).toBe(1)
  })

  it('TLS 空值不丢（有些导出工具不填这列）', () => {
    const csv = [
      'IP地址,端口,下载速度,平均延迟,TLS',
      '104.16.1.1,443,10.5,120,',
      '104.16.2.2,443,8.2,180,true',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries).toHaveLength(2)
    expect(r.tlsDropped).toBe(0)
  })

  it('TLS 的否 / no / 0 都判为不支持', () => {
    const csv = [
      'IP地址,端口,下载速度,平均延迟,TLS',
      '104.16.1.1,443,10.5,120,true',
      '104.16.2.2,443,8.2,180,否',
      '104.16.3.3,443,7.2,190,no',
      '104.16.4.4,443,6.1,200,0',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries).toHaveLength(1)
    expect(r.tlsDropped).toBe(3)
  })

  it('TLS 大小写不敏感', () => {
    const csv = [
      'IP,Port,Speed,Latency,TLS',
      '104.16.1.1,443,10.5,120,TRUE',
      '104.16.2.2,443,8.2,180,FALSE',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries).toHaveLength(1)
    expect(r.tlsDropped).toBe(1)
  })

  it('没有 TLS 列时全部保留', () => {
    const csv = [
      'IP地址,下载速度,平均延迟',
      '104.16.1.1,10.5,120',
      '104.16.2.2,8.2,180',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries).toHaveLength(2)
    expect(r.tlsDropped).toBe(0)
  })
})

describe('parseCsvText：国家 / 城市列', () => {
  it('城市填进 remark', () => {
    const csv = [
      'IP地址,端口,下载速度,平均延迟,国家,城市',
      '104.16.1.1,443,10.5,120,美国,洛杉矶',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('洛杉矶')
    expect(r.entries[0]!.country).toBe('美国')
  })

  it('只有国家列时 remark 用国家', () => {
    const csv = [
      'IP地址,下载速度,平均延迟,国家',
      '104.16.1.1,10.5,120,日本',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('日本')
  })

  it('城市优先于国家作 remark', () => {
    const csv = [
      'IP,下载速度,平均延迟,国家,城市',
      '104.16.1.1,10.5,120,美国,圣何塞',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('圣何塞')
  })

  it('城市和国家都没有时退回机房码', () => {
    const csv = [
      'IP地址,下载速度,平均延迟,colo',
      '104.16.1.1,10.5,120,LAX',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('LAX')
    expect(r.entries[0]!.colo).toBe('LAX')
  })

  it('英文表头 city / country 也认', () => {
    const csv = [
      'IP,Speed,Latency,Country,City',
      '104.16.1.1,10.5,120,US,Seattle',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('Seattle')
  })
})

describe('parseCsvText：无表头时的国家/城市启发式', () => {
  it('中文城市名（含市/省等）识别为城市', () => {
    const csv = '104.16.1.1,10.5,120,洛杉矶'
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('洛杉矶')
  })

  it('中文国名（短）识别为国家', () => {
    const csv = '104.16.1.1,10.5,120,日本'
    const r = parseCsvText(csv)
    expect(r.entries[0]!.remark).toBe('日本')
  })

  it('已有 colo 时不被中文列覆盖', () => {
    // 4 列：IP + 2 数字 + 一个字母串（colo）
    const csv = '104.16.1.1,10.5,120,LAX'
    const r = parseCsvText(csv)
    expect(r.entries[0]!.colo).toBe('LAX')
  })
})

describe('parseCsvText：原有能力不回归', () => {
  it('标准 CloudflareSpeedTest 表头仍可解析', () => {
    const csv = [
      'IP地址,端口,下载速度,平均延迟,colo',
      '104.16.1.1,443,10.5,120,LAX',
      '104.16.2.2,443,8.2,180,SJC',
    ].join('\n')
    const r = parseCsvText(csv)
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ ip: '104.16.1.1', port: 443, speed: 10.5, latency: 120 })
  })

  it('阈值过滤仍然生效', () => {
    const csv = [
      'IP地址,下载速度,平均延迟',
      '104.16.1.1,10.5,120',
      '104.16.2.2,0.5,300',
    ].join('\n')
    const r = parseCsvText(csv, { dls: 1, maxLatency: 200 })
    expect(r.entries).toHaveLength(1)
    expect(r.filtered).toBe(1)
  })

  it('空输入不报错', () => {
    const r = parseCsvText('')
    expect(r.entries).toEqual([])
    expect(r.tlsDropped).toBe(0)
  })
})
