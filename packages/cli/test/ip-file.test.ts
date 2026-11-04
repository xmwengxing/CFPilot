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
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readIpFile, readIpUrl } from '../src/scan/ip-ranges'
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

/**
 * 远程清单导入。
 *
 * 三条边界都要锁住，否则一个错链接会以「候选 0 个」或「内存被打爆」的形式失败：
 * 协议白名单、体积上限（声明值与实际字节两个口径）、内容必须真含 IP。
 */
describe('readIpUrl（远程清单）', () => {
  /** 起一个只服务一次的本地 HTTP 服务，返回链接与关闭函数 */
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<{
    url: string
    close: () => Promise<void>
  }> {
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}/list.txt`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it('正常清单按同样规则清洗（CSV 表头 / 备注 / IPv6 括号）', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(
        [
          'No,Proxy IP,Port',
          '1,94.143.231.154,443',
          '2,[2606:4700::1]:443#LAX',
        ].join('\n')
      )
    })
    try {
      await expect(readIpUrl(srv.url)).resolves.toEqual(['94.143.231.154', '2606:4700::1'])
    } finally {
      await srv.close()
    }
  })

  it('只接受 http/https', async () => {
    await expect(readIpUrl('file:///etc/passwd')).rejects.toThrow(/http\/https/)
    await expect(readIpUrl('不是链接')).rejects.toThrow(/不是合法的链接/)
  })

  it('HTTP 非 2xx 直接报错并带上状态码', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    try {
      await expect(readIpUrl(srv.url)).rejects.toThrow(/404/)
    } finally {
      await srv.close()
    }
  })

  it('声明的 content-length 超上限就提前拒绝', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '999999' })
      res.end('1.2.3.4\n')
    })
    try {
      await expect(readIpUrl(srv.url, 5000, 100)).rejects.toThrow(/过大/)
    } finally {
      await srv.close()
    }
  })

  it('没有 content-length 时按实际字节截断', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' })
      // 每行 8 字节，读够 100 字节上限之前必然超限
      for (let i = 0; i < 50; i++) res.write(`1.2.3.${i % 256}\n`)
      res.end()
    })
    try {
      await expect(readIpUrl(srv.url, 5000, 100)).rejects.toThrow(/过大/)
    } finally {
      await srv.close()
    }
  })

  it('内容是 HTML 之类没有 IP 时明确报错，而不是静默返回空', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body>not found</body></html>')
    })
    try {
      await expect(readIpUrl(srv.url)).rejects.toThrow(/没有可识别的 IP/)
    } finally {
      await srv.close()
    }
  })
})
