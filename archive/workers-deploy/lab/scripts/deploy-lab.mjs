// 522 根因实验：上传对照产物到实验 Worker，并探测 HTTP 状态。
//
// 用法：CFP_LAB_TOKEN=<token> node scripts/lab/deploy-lab.mjs <产物文件> <轮次标签>
//
// 实验账号（用户提供的令牌，仅存在于环境变量）：
//   账号 70ec011b12cd621609a8412a4d0c1668（干净账号，0 脚本）
//   workers.dev 子域 32724941
//   zone xmdongyao.de5.net（自定义域名 lab522.<zone>，绕过本机 workers.dev DNS 污染）
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const API = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '70ec011b12cd621609a8412a4d0c1668'
const ZONE_ID = '366bb0195f8619cbf414c25fd11f5f3f'
const ZONE_NAME = 'xmdongyao.de5.net'
const WORKERS_SUB = '32724941'
const SCRIPT = process.env.CFP_LAB_SCRIPT || 'cfp522lab'
const HOSTNAME = process.env.CFP_LAB_HOST || `lab522.${ZONE_NAME}`

const token = process.env.CFP_LAB_TOKEN
if (!token) {
  console.error('缺少 CFP_LAB_TOKEN 环境变量')
  process.exit(2)
}

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/lab/deploy-lab.mjs <产物文件> [标签]')
  process.exit(2)
}
const label = process.argv[3] ?? 'lab'
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

// 1) 上传脚本（与 deploy-wizard uploadScript 相同的 multipart 形态）
const metadata = {
  main_module: 'worker.js',
  compatibility_date: process.env.CFP_LAB_COMPAT || '2026-01-01',
  bindings: [],
}
const form = new FormData()
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
form.set('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js')
await api('PUT', `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`, undefined, form)
console.log(`✅ 已上传 ${SCRIPT}（${label}，${(code.length / 1024).toFixed(1)} KB）`)

// 2) 开启 workers.dev 子域路由
await api('POST', `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/subdomain`, { enabled: true })

// 3) 绑定自定义域名（幂等）
const domains = await api('GET', `/accounts/${ACCOUNT}/workers/domains`)
const bound = (domains ?? []).find((d) => d.hostname === HOSTNAME)
if (!bound) {
  await api('PUT', `/accounts/${ACCOUNT}/workers/domains`, {
    hostname: HOSTNAME,
    service: SCRIPT,
    zone_id: ZONE_ID,
    environment: 'production',
  })
  // DNS：proxied CNAME → workers.dev 脚本地址
  const records = await api(
    'GET',
    `/zones/${ZONE_ID}/dns_records?name=${encodeURIComponent(HOSTNAME)}`
  )
  if (!records || records.length === 0) {
    await api('POST', `/zones/${ZONE_ID}/dns_records`, {
      type: 'CNAME',
      name: HOSTNAME,
      content: `${SCRIPT}.${WORKERS_SUB}.workers.dev`,
      proxied: true,
      ttl: 1,
    })
  }
  console.log(`✅ 已绑定自定义域名 ${HOSTNAME}`)
}

// 4) 探测（等域名生效）
const paths = ['/', '/__diag', '/__cfp_version']
const maxRounds = Number(process.env.CFP_LAB_ROUNDS || 12)
let lastErr = ''
for (let attempt = 1; attempt <= maxRounds; attempt++) {
  await new Promise((r) => setTimeout(r, 5000))
  let ok = true
  const results = []
  for (const p of paths) {
    let status = '000'
    let body = ''
    try {
      const out = execFileSync(
        'curl',
        ['-s', '-o', '-', '-w', '\n%{http_code}', '--max-time', '20', `-H`, `Host: ${HOSTNAME}`, `https://${HOSTNAME}${p}`],
        { encoding: 'utf8', timeout: 30000 }
      )
      const idx = out.lastIndexOf('\n')
      body = out.slice(0, idx)
      status = out.slice(idx + 1).trim()
    } catch (err) {
      lastErr = String(err).slice(0, 200)
    }
    results.push(`${p} → ${status} ${body.slice(0, 60).replace(/\s+/g, ' ')}`)
    if (status !== '200') ok = false
  }
  console.log(`第 ${attempt} 轮：\n  ${results.join('\n  ')}`)
  if (ok) {
    console.log(`🎉 ${label} 全部 200 —— 隔离体启动成功`)
    process.exit(0)
  }
  // 522 与 1101 是「确定性失败」，不用等域名传播 —— 但域名刚建时也可能短暂 522，多试几轮
}
console.error(`❌ ${label} 探测未通过（最后错误：${lastErr}）`)
process.exit(1)
