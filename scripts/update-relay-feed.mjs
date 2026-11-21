#!/usr/bin/env node
/**
 * 定时维护 `data/relay-ips.txt`：从多源公开反代候选池采集 IP，
 * 对每个候选执行真 TLS/HTTP 双通校验：
 *   1. SNI=cloudflare.com → GET /cdn-cgi/trace 返回 HTTP 200；
 *   2. SNI=api.x.com      → GET /1.1/guest/activate.json 抵达 X 后端（非 403 WAF、非 TLS Alert）；
 *   3. SNI=x.com          → GET / 抵达 X（非 403 WAF、非 TLS Alert）。
 *
 * 按总握手耗时排序，按 /16 网段去重分散，输出前 N 条写入 `data/relay-ips.txt`。
 * 若本轮可用条数少于最小值，则保留原清单（fail-closed，避免空清单覆盖线上）。
 *
 * 用法：
 *   node scripts/update-relay-feed.mjs [--max 24] [--limit 120] [--out data/relay-ips.txt]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import * as tls from 'node:tls'

const NL = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)
const DCRLF = CRLF + CRLF

const CF_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '104.31.0.0/15',
  '1.0.0.0/24', '1.1.1.0/24',
]

function ipToInt(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return -1
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

const CF_NETS = CF_CIDRS.map((cidr) => {
  const [base, bits] = cidr.split('/')
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0
  return [(ipToInt(base) & mask) >>> 0, mask]
})

function isCloudflareIp(ip) {
  const v = ipToInt(ip)
  if (v < 0) return true
  return CF_NETS.some(([net, mask]) => ((v & mask) >>> 0) === net)
}

const PUBLIC_FEED_URLS = [
  'https://cdn.jsdelivr.net/gh/KafeMars/best-ips-domains@main/BestProxyIPs_US',
  'https://cdn.jsdelivr.net/gh/ymyuuu/IPDB@main/BestProxy/proxy.txt',
  'https://cdn.jsdelivr.net/gh/skfoa/tg-proxy-fetcher@main/data/proxyip.txt',
  'https://cdn.jsdelivr.net/gh/luuaiyan/CloudflareProxyIP@main/CF-ProxyIP.csv',
]

function parseIps(text) {
  const out = []
  for (const raw of String(text ?? '').split(NL)) {
    const line = raw.split('#')[0].trim()
    if (!line) continue
    let ip = ''
    let port = 443
    if (line.includes(',')) {
      const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      const ipCell = cells.find((c) => /^\d+\.\d+\.\d+\.\d+$/.test(c))
      if (!ipCell) continue
      ip = ipCell
      if (cells[1] && /^\d+$/.test(cells[1])) port = Number(cells[1])
    } else if (line.includes(':')) {
      const [h, p] = line.split(':')
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(h) || !/^\d+$/.test(p)) continue
      ip = h
      port = Number(p)
    } else {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(line)) continue
      ip = line
    }
    if (port !== 443) continue
    if (isCloudflareIp(ip)) continue
    out.push(ip)
  }
  return out
}

function httpGet(host, path) {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept: */*',
    'Connection: close',
    '',
    '',
  ].join(CRLF)
}

function probeSni(ip, sni, path, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let tlsMs = 0
    const chunks = []
    const sock = tls.connect({
      host: ip,
      port: 443,
      servername: sni,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    })
    const finish = (res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch {}
      resolve(res)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    sock.on('secureConnect', () => {
      tlsMs = Date.now() - started
      sock.write(httpGet(sni, path))
    })
    sock.on('data', (chunk) => {
      chunks.push(chunk)
      const txt = Buffer.concat(chunks).toString('utf8')
      if (txt.includes(DCRLF)) {
        const he = txt.indexOf(DCRLF)
        const firstLine = txt.slice(0, txt.indexOf(CRLF))
        const code = Number(firstLine.split(' ')[1] || 0)
        const body = txt.slice(he + 4, he + 200)
        finish({ ok: code > 0, code, tlsMs, body })
      }
    })
    sock.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8')
      if (!txt) return finish({ ok: false, error: 'eof' })
      const code = Number(txt.split(CRLF)[0].split(' ')[1] || 0)
      finish({ ok: code > 0, code, tlsMs, body: txt.slice(0, 200) })
    })
    sock.on('error', (err) => finish({ ok: false, error: err.message }))
  })
}

function isXBlocked(res) {
  if (!res.ok) return true
  if (res.code === 403) return true
  const b = (res.body || '').toLowerCase()
  if (b.includes('just a moment') || b.includes('attention required') || b.trim() === 'ipv6') return true
  return false
}

function flagNum(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return fallback
}

function flagStr(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const outPath = flagStr('--out', 'data/relay-ips.txt')
  const maxKeep = flagNum('--max', 24)
  const candLimit = flagNum('--limit', 160)
  const concurrency = flagNum('--concurrency', 16)

  const seen = new Set()
  const candidates = []
  const addIp = (ip) => {
    if (seen.has(ip) || isCloudflareIp(ip)) return
    seen.add(ip)
    candidates.push(ip)
  }

  // 1. 保留现有清单优先复测（健康的老入口放前面，保持出口稳定）
  try {
    for (const ip of parseIps(readFileSync(outPath, 'utf8'))) addIp(ip)
  } catch {}

  // 2. 拉取公开源并按 /16 网段打散采样，避免 160 个候选全落在同一个机房
  const slash16Count = new Map()
  for (const url of PUBLIC_FEED_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
      if (!res.ok) continue
      const ips = parseIps(await res.text())
      for (const ip of ips) {
        if (candidates.length >= candLimit) break
        const s16 = ip.split('.').slice(0, 2).join('.')
        const n = slash16Count.get(s16) ?? 0
        if (n >= 2) continue
        slash16Count.set(s16, n + 1)
        addIp(ip)
      }
    } catch (err) {
      process.stderr.write(`[relay-feed] 跳过不可达源 ${url}: ${err instanceof Error ? err.message : String(err)}${NL}`)
    }
  }

  process.stderr.write(`[relay-feed] 共收集 ${candidates.length} 个候选，开始 CF + X 双通校验…${NL}`)

  const passed = []
  const queue = [...candidates]
  async function worker() {
    while (queue.length > 0) {
      const ip = queue.shift()
      const cf = await probeSni(ip, 'cloudflare.com', '/cdn-cgi/trace', 4000)
      if (!cf.ok || cf.code !== 200) continue
      const [apiX, xHome] = await Promise.all([
        probeSni(ip, 'api.x.com', '/1.1/guest/activate.json', 4500),
        probeSni(ip, 'x.com', '/', 4500),
      ])
      if (isXBlocked(apiX) || isXBlocked(xHome)) continue
      passed.push({
        ip,
        scoreMs: cf.tlsMs + apiX.tlsMs + xHome.tlsMs,
        cfMs: cf.tlsMs,
        apiXMs: apiX.tlsMs,
        xMs: xHome.tlsMs,
      })
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  passed.sort((a, b) => a.scoreMs - b.scoreMs)

  // 输出按 /16 最多留 2 条，避免单机房故障一锅端
  const finalList = []
  const outS16 = new Map()
  for (const item of passed) {
    const s16 = item.ip.split('.').slice(0, 2).join('.')
    const c = outS16.get(s16) ?? 0
    if (c >= 2) continue
    outS16.set(s16, c + 1)
    finalList.push(item)
    if (finalList.length >= maxKeep) break
  }

  process.stderr.write(`[relay-feed] 双通通过 ${passed.length} 条，去重精选 ${finalList.length} 条${NL}`)
  if (finalList.length < 4) {
    process.stderr.write(`[relay-feed] 可用条目不足 4 条，保留原 ${outPath} 不覆盖${NL}`)
    process.exit(0)
  }

  const now = new Date().toISOString()
  const content = [
    '# CFPilot 动态反代入口清单（CF 通用 + X 双通实测）',
    `# 更新时间：${now}，共 ${finalList.length} 条（按握手耗时排序）`,
    ...finalList.map((x) => x.ip),
    '',
  ].join(NL)
  writeFileSync(outPath, content, 'utf8')
  process.stderr.write(`[relay-feed] 已写入 ${outPath}${NL}`)
}

void main()
