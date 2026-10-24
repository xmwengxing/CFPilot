// 通用实验部署（旧账号带 zone / 新账号仅 workers.dev 均可）。
// 用法：
//   CFP_LAB_TOKEN=... CFP_LAB_ACCOUNT=... CFP_LAB_SCRIPT=... \
//   [CFP_LAB_HOST=xxx.zone] [CFP_LAB_ZONE=zoneid] node scripts/lab/deploy-any.mjs <文件> [标签] [轮数]
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const API = 'https://api.cloudflare.com/client/v4'
const token = process.env.CFP_LAB_TOKEN
const account = process.env.CFP_LAB_ACCOUNT
const script = process.env.CFP_LAB_SCRIPT
const zoneId = process.env.CFP_LAB_ZONE || ''
const hostname = process.env.CFP_LAB_HOST || '' // 空 = 仅 workers.dev
const file = process.argv[2]
const label = process.argv[3] || 'lab'
const rounds = Number(process.argv[4] || 3)

if (!token || !account || !script || !file) {
  console.error('缺少必要环境变量：CFP_LAB_TOKEN / CFP_LAB_ACCOUNT / CFP_LAB_SCRIPT')
  process.exit(2)
}

const code = readFileSync(resolve(file), 'utf8')

async function api(method, path, body, form) {
  const headers = { Authorization: `Bearer ${token}` }
  if (!form) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || (parsed && parsed.success === false)) {
    throw new Error(`API ${method} ${path} → HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  return parsed?.result
}

// 1) 上传
const metadata = {
  main_module: 'worker.js',
  compatibility_date: process.env.CFP_LAB_COMPAT || '2026-01-01',
  bindings: [],
}
const form = new FormData()
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
form.set('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js')
await api('PUT', `/accounts/${account}/workers/scripts/${script}`, undefined, form)
console.log(`✅ 已上传 ${script}（${label}，${(code.length / 1024).toFixed(1)} KB）`)

// 2) 开启 workers.dev 子域路由
const sub = await api('GET', `/accounts/${account}/workers/subdomain`)
const subdomain = sub?.subdomain || ''
await api('POST', `/accounts/${account}/workers/scripts/${script}/subdomain`, { enabled: true })
const workersDev = `${script}.${subdomain}.workers.dev`

// 3) 可选：绑定自定义域名 + DNS
if (hostname && zoneId) {
  const domains = await api('GET', `/accounts/${account}/workers/domains`)
  const bound = (domains ?? []).find((d) => d.hostname === hostname)
  if (!bound) {
    await api('PUT', `/accounts/${account}/workers/domains`, {
      hostname,
      service: script,
      zone_id: zoneId,
      environment: 'production',
    })
    const records = await api('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`)
    if (!records || records.length === 0) {
      await api('POST', `/zones/${zoneId}/dns_records`, {
        type: 'CNAME',
        name: hostname,
        content: workersDev,
        proxied: true,
        ttl: 1,
      })
    }
  }
  console.log(`✅ 自定义域名 ${hostname} → ${script}`)
}

// 4) 探测（自定义域名直连；无域名时打印 workers.dev 供 relay 使用）
const paths = ['/', '/__cfp_version']
if (!hostname) {
  console.log(`workers.dev: https://${workersDev}/`)
  console.log('（本机无法直连 workers.dev，请用 relay 探测）')
  process.exit(0)
}

for (let attempt = 1; attempt <= rounds; attempt++) {
  if (attempt > 1) await new Promise((r) => setTimeout(r, 5000))
  const results = []
  let ok = true
  for (const p of paths) {
    let status = '000'
    let body = ''
    try {
      const out = execFileSync(
        'curl',
        ['-s', '-o', '-', '-w', '\n%{http_code}', '--max-time', '20', `https://${hostname}${p}`],
        { encoding: 'utf8', timeout: 30000 }
      )
      const idx = out.lastIndexOf('\n')
      body = out.slice(0, idx)
      status = out.slice(idx + 1).trim()
    } catch (err) {
      body = String(err).slice(0, 100)
    }
    results.push(`  ${p} → ${status} ${body.slice(0, 60).replace(/\s+/g, ' ')}`)
    if (status !== '200') ok = false
  }
  console.log(`第 ${attempt} 轮：\n${results.join('\n')}`)
  if (ok) {
    console.log(`🎉 ${label} 全部 200`)
    process.exit(0)
  }
}
console.error(`❌ ${label} 探测未通过`)
process.exit(1)
