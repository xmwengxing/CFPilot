import { describe, expect, it } from 'vitest'
import { formatEntries } from '../src/scan'
import { flagBool, flagList, flagNumber, flagString, parseArgs } from '../src/args'

describe('formatEntries', () => {
  it('生成面板回填格式 IP:Port#机房_延迟_速度', () => {
    const lines = formatEntries([
      { ip: '1.2.3.4', port: 443, colo: 'SJC', latency: 12, speed: 35.5 },
    ])
    expect(lines).toEqual(['1.2.3.4:443#SJC_12_35.5'])
  })
})

describe('parseArgs', () => {
  it('解析子命令与长参数', () => {
    const args = parseArgs(['scan', '--host', 'example.com', '--top=20', '--no-callback'])
    expect(args.command).toBe('scan')
    expect(flagString(args, 'host')).toBe('example.com')
    expect(flagNumber(args, 'top', 15)).toBe(20)
    expect(flagBool(args, 'no-callback')).toBe(true)
  })

  it('布尔参数没有值时为 true', () => {
    const args = parseArgs(['--json'])
    expect(flagBool(args, 'json')).toBe(true)
    expect(flagString(args, 'json', 'fallback')).toBe('fallback')
  })

  it('支持逗号分隔的列表参数', () => {
    const args = parseArgs(['--cidr', '1.2.3.0/24,5.6.7.0/24'])
    expect(flagList(args, 'cidr')).toEqual(['1.2.3.0/24', '5.6.7.0/24'])
  })

  it('缺省时使用默认值', () => {
    const args = parseArgs([])
    expect(flagNumber(args, 'port', 443)).toBe(443)
    expect(flagString(args, 'host')).toBe('')
  })
})
