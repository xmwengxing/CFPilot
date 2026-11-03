/**
 * 候选文件读取与自定义网段归一。
 *
 * ## 为什么单独锁这两件事
 *
 * 它们都是**静默失败**型缺陷：出错时不会抛异常，用户只会看到
 * 「候选数为 0」或「候选数对不上」，完全不知道是格式问题。
 * 一个 CSV 表头被当成候选、一个裸 IP 被丢掉，都会让整轮优选白跑。
 */
import { describe, expect, it } from 'vitest'
import { readIpFile } from '../src/scan/ip-ranges'
import { resolveCandidatePlan } from '../src/scan/candidates'

describe('readIpFile（候选文件读取）', () => {
  it('CSV 按「哪一列像 IP」取，表头整行跳过', () => {
    // 真实形态：第一列是序号、第二列才是 IP，第一行是表头
    const csv = [
      'No,Proxy IP,Port,Country,City,ISP',
      '1,94.143.231.154,443,Germany,Frankfurt am Main,"dataforest GmbH"',
      '2,63.176.161.135,443,Germany,Frankfurt,Amazon.com',
    ].join('\n')

    expect(readIpFile(csv)).toEqual(['94.143.231.154', '63.176.161.135'])
  })

  it('面板 ADD 池写法保持原样可用（第一列就是 IP）', () => {
    const text = [
      '1.2.3.4:443#SJC_12_35.5',
      '[2606:4700::1]:443#LAX_20_10.2',
      'example.com:8443',
      '',
      '# 注释行',
    ].join('\n')

    expect(readIpFile(text)).toEqual(['1.2.3.4', '2606:4700::1', 'example.com'])
  })

  it('「主机,端口」写法回退取第一列（不能因为不像 IP 就丢掉域名）', () => {
    expect(readIpFile('example.com,8080')).toEqual(['example.com'])
  })

  it('裸 IPv6 与 [IPv6]:端口 都能识别', () => {
    expect(readIpFile('2606:4700::1')).toEqual(['2606:4700::1'])
    expect(readIpFile('[2606:4700::1]:443')).toEqual(['2606:4700::1'])
    expect(readIpFile('::1')).toEqual(['::1'])
  })

  it('带空格的说明行整行跳过（不产出垃圾候选）', () => {
    const text = ['说明：这里放 IP', 'IP,Port', '1.2.3.4,443'].join('\n')
    expect(readIpFile(text)).toEqual(['1.2.3.4'])
  })
})

describe('自定义网段归一（--cidr）', () => {
  it('裸 IPv4 自动补 /32，不再被静默丢弃', async () => {
    const plan = await resolveCandidatePlan({ cidr: ['1.2.3.4'], sample: 100 })
    expect(plan.candidates).toContain('1.2.3.4')
    expect(plan.candidates.length).toBeGreaterThan(0)
  })

  it('裸 IPv6 自动补 /128', async () => {
    const plan = await resolveCandidatePlan({
      cidr: ['2606:4700::1'],
      sample: 100,
      family: 'v6',
    })
    expect(plan.candidates).toContain('2606:4700::1')
  })

  it('已是 CIDR 形态的原样保留', async () => {
    const plan = await resolveCandidatePlan({ cidr: ['10.0.0.0/30'], sample: 100 })
    expect(plan.candidates.length).toBeGreaterThan(0)
  })

  it('无法识别的条目**显式报错**并列出，而不是让候选变成 0', async () => {
    await expect(resolveCandidatePlan({ cidr: ['not-an-ip'], sample: 100 })).rejects.toThrow(
      /无法识别的网段\/IP/
    )
  })
})
