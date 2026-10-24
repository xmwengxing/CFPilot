// 绕过自定义域名（可能卡死在 522）直接探测 workers.dev。
// 做法：alidns DoH 解析 → 取 Cloudflare 网段内的 IP → curl --resolve。
// 用法：node scripts/lab/probe-workersdev.mjs [路径...]
import { execFileSync } from 'node:child_process'

const SCRIPT = 'cfp522lab'
const HOST = `${SCRIPT}.32724941.workers.dev`
const paths = process.argv.slice(2)
if (paths.length === 0) paths.push('/', '/__diag', '/__cfp_version')

// Cloudflare 网段（用于过滤被污染的 DoH 结果）
const CF_RANGES = [
  ['104.16.0.0', 13], ['104.24.0.0', 14], ['172.64.0.0', 13], ['162.158.0.0', 15],
  ['188.114.96.0', 20], ['141.101.64.0', 18], ['108.162.192.0', 18], ['103.21.244.0', 22],
  ['103.22.200.0', 22], ['103.31.4.0', 22], ['131.0.72.0', 22], ['197.234.240.0', 22],
  ['198.41.128.0', 17], ['104.28.0.0', 14], ['172.68.0.0', 14], ['190.93.240.0', 20],
  ['197.234.240.0', 20], ['45.119.80.0', 20],
]
const toInt = (ip) => {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}
const isCf = (ip) => {
  const v = toInt(ip)
  if (v === null) return false
  return CF_RANGES.some(([base, bits]) => {
    const b = toInt(base)
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (v & mask) === (b & mask)
  })
}

async function doh(name) {
  const res = await fetch(`https://dns.alidns.com/resolve?name=${name}&type=A`, {
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json()
  return (data.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data)
}

const answers = await doh(HOST)
const candidates = answers.filter(isCf)
if (candidates.length === 0) {
  console.log(`DoH 返回 ${JSON.stringify(answers)}（无 Cloudflare 网段 IP，全部尝试）`)
  candidates.push(...answers)
}
console.log(`候选 IP：${candidates.join(', ')}`)

for (const ip of candidates.slice(0, 3)) {
  const results = []
  for (const p of paths) {
    let status = '000'
    let body = ''
    try {
      const out = execFileSync(
        'curl',
        ['-s', '-o', '-', '-w', '\n%{http_code}', '--max-time', '20',
          '--resolve', `${HOST}:443:${ip}`, `https://${HOST}${p}`],
        { encoding: 'utf8', timeout: 30000 }
      )
      const idx = out.lastIndexOf('\n')
      body = out.slice(0, idx)
      status = out.slice(idx + 1).trim()
    } catch (err) {
      body = String(err).slice(0, 100)
    }
    results.push(`  ${p} → ${status} ${body.slice(0, 60).replace(/\s+/g, ' ')}`)
  }
  console.log(`IP ${ip}：\n${results.join('\n')}`)
}
