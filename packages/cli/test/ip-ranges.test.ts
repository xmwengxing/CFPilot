import { describe, it, expect } from 'vitest'
import { expandCidrs, parseCidr } from '../src/scan/ip-ranges'

/** 取 IPv4 末位 */
function lastOctet(ip: string): number {
  return Number(ip.split('.')[3])
}

/** IPv4 → BigInt（无 BigInt 进制参数，手写换算） */
function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.').map(Number)
  return (
    (BigInt(parts[0]!) << 24n) |
    (BigInt(parts[1]!) << 16n) |
    (BigInt(parts[2]!) << 8n) |
    BigInt(parts[3]!)
  )
}

describe('expandCidrs 采样分布', () => {
  /**
   * 回归测试：旧实现把 `offset = random() * step` 放在循环外，
   * 同一网段采出的 IP 是固定步长的等差数列。
   *
   * /16 = 65536 地址，取 64 个 → step = 1024（256 的倍数）
   * → 旧实现下 64 个样本的末位**全部相同**
   */
  it('同一网段的样本末位不应全部相同', () => {
    const ips = expandCidrs(['104.16.0.0/16'], { sample: 64, seed: 24301 })
    expect(ips.length).toBe(64)

    const octets = new Set(ips.map(lastOctet))
    expect(octets.size).toBeGreaterThan(1)
  })

  it('样本不应落在 .0（网络地址）', () => {
    const ips = expandCidrs(['104.16.0.0/16'], { sample: 512, seed: 1 })
    expect(ips.length).toBe(512)
    expect(ips.filter((ip) => lastOctet(ip) === 0)).toHaveLength(0)
  })

  it('样本不应落在 .255（广播地址）', () => {
    const ips = expandCidrs(['104.16.0.0/16'], { sample: 512, seed: 7 })
    expect(ips.length).toBe(512)
    expect(ips.filter((ip) => lastOctet(ip) === 255)).toHaveLength(0)
  })

  it('末位分布应覆盖较多种取值（抖动生效）', () => {
    const ips = expandCidrs(['104.16.0.0/16'], { sample: 256, seed: 99 })
    const octets = new Set(ips.map(lastOctet))
    // 256 个样本抖动着落在 256 个桶里，末位应覆盖大部分取值
    expect(octets.size).toBeGreaterThan(100)
  })

  it('不同种子应产出不同样本', () => {
    const a = expandCidrs(['104.16.0.0/16'], { sample: 64, seed: 1 })
    const b = expandCidrs(['104.16.0.0/16'], { sample: 64, seed: 2 })
    expect(a).not.toEqual(b)
  })

  it('同种子应可复现', () => {
    const a = expandCidrs(['104.16.0.0/16'], { sample: 64, seed: 42 })
    const b = expandCidrs(['104.16.0.0/16'], { sample: 64, seed: 42 })
    expect(a).toEqual(b)
  })

  it('样本必须落在网段范围内', () => {
    const cidr = parseCidr('104.16.0.0/16')!
    const ips = expandCidrs(['104.16.0.0/16'], { sample: 300, seed: 5 })
    for (const ip of ips) {
      const v = ipv4ToBigInt(ip)
      expect(v).toBeGreaterThanOrEqual(cidr.base)
      expect(v).toBeLessThan(cidr.base + cidr.size)
    }
  })

  it('不应产生重复 IP', () => {
    const ips = expandCidrs(['104.16.0.0/16', '104.24.0.0/14'], { sample: 400, seed: 11 })
    expect(new Set(ips).size).toBe(ips.length)
  })
})
