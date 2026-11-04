#!/usr/bin/env node
/**
 * 反代候选「多源合并」工具（开发期手动跑，产物入库）。
 *
 * ## 为什么不把第三方列表直接写进内核
 *
 * 内核内置表是**随版本发布**的：第三方列表天天变，写死进去等于让用户
 * 用半年前的 IP 去连。所以这里只做**采集与合并**，产出：
 *
 *   docs/relay-ip-merged.csv     本轮候选（临时，gitignored）
 *   <快照文件>                    经优选后由人挑出、随版本发布的固定清单
 *
 * ## 解析规则
 *
 * 各来源格式不一致，统一走「按行 / 按列找 IP」：
 *   - TXT：每行 `ip[:port][#备注]`，`#` 开头是注释
 *   - CSV：找第一个「像 IP」的列，端口列取表头含 port/端口 的列，缺省 443
 *
 * ## 必须排除 Cloudflare 官方网段
 *
 * 官方网段是 CF 自己的 anycast 入口，拿它当反代只会绕回自己（TCP Loop）。
 *
 * 用法：
 *   node scripts/collect-relay-sources.mjs [--out docs/relay-ip-merged.csv]
 */
import { writeFileSync } from 'node:fs'

/** Cloudflare 官方 IPv4 网段（用于排除；来源 cloudflare.com/ips-v4 的静态副本） */
const CF_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]

const CF_NETS = CF_CIDRS.map((cidr) => {
  const [base, bits] = cidr.split('/')
  const octets = base.split('.').map(Number)
  const value = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return { net: (value & mask) >>> 0, mask }
})

function isCloudflareIp(ip) {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const value = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]
  return CF_NETS.some(({ net, mask }) => ((value & mask) >>> 0) === net)
}

/**
 * 候选来源（按文档给出的优先级）。
 *
 * 每个源给**主 URL + 镜像**：本机与部分网络访问 raw.githubusercontent.com
 * 会被阻断，镜像只是搬运同一份文件；候选在优选阶段都会被实测，镜像不参与
 * 任何完整性判定。
 */
const SOURCES = [
  {
    name: 'skfoa-proxyip-txt',
    weight: 100,
    urls: [
      'https://raw.githubusercontent.com/skfoa/tg-proxy-fetcher/main/data/proxyip.txt',
      'https://cdn.jsdelivr.net/gh/skfoa/tg-proxy-fetcher@main/data/proxyip.txt',
      'https://gh-proxy.com/raw.githubusercontent.com/skfoa/tg-proxy-fetcher/main/data/proxyip.txt',
    ],
  },
  {
    name: 'skfoa-proxyip-csv',
    weight: 100,
    urls: [
      'https://raw.githubusercontent.com/skfoa/tg-proxy-fetcher/main/data/proxyip.csv',
      'https://cdn.jsdelivr.net/gh/skfoa/tg-proxy-fetcher@main/data/proxyip.csv',
      'https://gh-proxy.com/raw.githubusercontent.com/skfoa/tg-proxy-fetcher/main/data/proxyip.csv',
    ],
  },
  {
    name: 'skfoa-proxyip-cf',
    weight: 80,
    urls: [
      'https://raw.githubusercontent.com/skfoa/tg-proxy-fetcher/main/data/proxyip_cf.txt',
      'https://cdn.jsdelivr.net/gh/skfoa/tg-proxy-fetcher@main/data/proxyip_cf.txt',
      'https://gh-proxy.com/raw.githubusercontent.com/skfoa/tg-proxy-fetcher/main/data/proxyip_cf.txt',
    ],
  },
  {
    name: 'kafemars-us',
    weight: 60,
    urls: [
      'https://raw.githubusercontent.com/KafeMars/best-ips-domains/refs/heads/main/BestProxyIPs_US',
      'https://cdn.jsdelivr.net/gh/KafeMars/best-ips-domains@main/BestProxyIPs_US',
      'https://gh-proxy.com/raw.githubusercontent.com/KafeMars/best-ips-domains/main/BestProxyIPs_US',
    ],
  },
  {
    name: 'luuaiyan-csv',
    weight: 40,
    urls: [
      'https://raw.githubusercontent.com/luuaiyan/CloudflareProxyIP/main/CF-ProxyIP.csv',
      'https://cdn.jsdelivr.net/gh/luuaiyan/CloudflareProxyIP@main/CF-ProxyIP.csv',
      'https://gh-proxy.com/raw.githubusercontent.com/luuaiyan/CloudflareProxyIP/main/CF-ProxyIP.csv',
    ],
  },
]

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

function isIpv4(value) {
  if (!IPV4.test(value)) return false
  return value.split('.').every((octet) => Number(octet) <= 255)
}

/** 从一个单元格里取出 `ip` 或 `ip:port` */
function cellAddress(cell) {
  const token = String(cell ?? '').trim().replace(/^"|"$/g, '')
  if (!token) return null
  const clean = token.split('#')[0].trim()
  if (clean.includes(':') && clean.split(':').length === 2) {
    const [host, port] = clean.split(':')
    if (isIpv4(host) && /^\d+$/.test(port)) return { ip: host, port: Number(port) }
    return null
  }
  return isIpv4(clean) ? { ip: clean, port: 443 } : null
}

/** 解析任意来源文本：逐行，先当表格再当单列 */
export function parseSource(text) {
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes(',')) {
      const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      // 找第一个「像 IP」的单元格
      let hit = null
      let portFromHeader = 443
      for (const cell of cells) {
        const addr = cellAddress(cell)
        if (addr) {
          hit = addr
          break
        }
      }
      if (!hit) continue // 表头 / 说明行
      // 端口列：表头含 port / 端口 时取同列
      const header = out.header
      if (header) {
        const idx = header.findIndex((h) => /port|端口/i.test(h))
        if (idx >= 0) {
          const p = Number(String(cells[idx] ?? '').replace(/\D/g, ''))
          if (Number.isInteger(p) && p > 0 && p <= 65535) portFromHeader = p
        }
      }
      out.push({ ip: hit.ip, port: hit.port === 443 ? portFromHeader : hit.port })
      continue
    }
    // 单列行
    const addr = cellAddress(line)
    if (addr) out.push(addr)
    else if (line.includes(',') === false && /port|ip|地址|端口/i.test(line)) out.header = line.split(',')
  }
  return out
}

async function fetchFirst(urls, timeoutMs = 20000) {
  let lastError = ''
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      if (!res.ok) {
        lastError = `${url} → HTTP ${res.status}`
        continue
      }
      const text = await res.text()
      if (text.trim().length === 0) {
        lastError = `${url} → 空内容`
        continue
      }
      return { url, text }
    } catch (err) {
      lastError = `${url} → ${err instanceof Error ? err.message : String(err)}`
    }
  }
  throw new Error(lastError || '全部镜像失败')
}

function main() {
  const outIndex = process.argv.indexOf('--out')
  const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : 'docs/relay-ip-merged.csv'

  void (async () => {
    const merged = new Map() // `${ip}:${port}` → { ip, port, sources:Set }
    for (const source of SOURCES) {
      try {
        const { url, text } = await fetchFirst(source.urls)
        const parsed = parseSource(text)
        let added = 0
        for (const { ip, port } of parsed) {
          if (isCloudflareIp(ip)) continue
          const key = `${ip}:${port}`
          const existing = merged.get(key)
          if (existing) {
            existing.sources.add(source.name)
            continue
          }
          merged.set(key, { ip, port, sources: new Set([source.name]) })
          added += 1
        }
        process.stderr.write(
          `✓ ${source.name}: 解析 ${parsed.length} 条，新增 ${added} 条（源 ${url.slice(0, 48)}…）\n`
        )
      } catch (err) {
        process.stderr.write(`✗ ${source.name}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }

    // 合并本地已有的种子清单（上一轮实测过的那批）
    try {
      const { readFileSync } = await import('node:fs')
      const seed = readFileSync('docs/relay-ip-candidates.csv', 'utf8')
      let added = 0
      for (const { ip, port } of parseSource(seed)) {
        if (isCloudflareIp(ip)) continue
        const key = `${ip}:${port}`
        if (!merged.has(key)) {
          merged.set(key, { ip, port, sources: new Set(['seed-260']) })
          added += 1
        } else {
          merged.get(key).sources.add('seed-260')
        }
      }
      process.stderr.write(`✓ seed-260: 新增 ${added} 条\n`)
    } catch {
      process.stderr.write('· seed-260: 没有本地种子清单，跳过\n')
    }

    const rows = [...merged.values()].sort((a, b) => a.ip.localeCompare(b.ip))
    const lines = ['ip,port,sources'].concat(
      rows.map((r) => `${r.ip},${r.port},"${[...r.sources].join('|')}"`)
    )
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    process.stderr.write(`\n合计 ${rows.length} 个候选（去重后）→ ${outPath}\n`)

    const ipOnly = [...new Set(rows.map((r) => r.ip))]
    writeFileSync(outPath.replace(/\.csv$/, '.txt'), ipOnly.join('\n') + '\n', 'utf8')
    process.stderr.write(`纯 IP 列表 ${ipOnly.length} 条 → ${outPath.replace(/\.csv$/, '.txt')}\n`)
  })()
}

main()
