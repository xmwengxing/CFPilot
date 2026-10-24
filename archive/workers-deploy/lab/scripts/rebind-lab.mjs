// 把一个**新自定义域名**绑到**已有脚本**上并探测 —— 不重新上传内容。
// 用途：区分「域名绑定被 522 污染卡死」与「脚本本身卡死」。
// 用法：CFP_LAB_TOKEN=... CFP_LAB_SCRIPT=... node scripts/lab/rebind-lab.mjs <hostname> [轮数]
import { execFileSync } from 'node:child_process'

const API = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '70ec011b12cd621609a8412a4d0c1668'
const ZONE_ID = '366bb0195f8619cbf414c25fd11f5f3f'
const ZONE_NAME = 'xmdongyao.de5.net'
const WORKERS_SUB = '32724941'

const token = process.env.CFP_LAB_TOKEN
const script = process.env.CFP_LAB_SCRIPT || 'cfp522lab'
const hostname = process.argv[2]
const rounds = Number(process.argv[3] || 8)
if (!token || !hostname) {
  console.error('用法：CFP_LAB_TOKEN=... node scripts/lab/rebind-lab.mjs <hostname> [轮数]')
  process.exit(2)
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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

await api('PUT', `/accounts/${ACCOUNT}/workers/domains`, {
  hostname,
  service: script,
  zone_id: ZONE_ID,
  environment: 'production',
})
const records = await api('GET', `/zones/${ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}`)
if (!records || records.length === 0) {
  await api('POST', `/zones/${ZONE_ID}/dns_records`, {
    type: 'CNAME',
    name: hostname,
    content: `${script}.${WORKERS_SUB}.workers.dev`,
    proxied: true,
    ttl: 1,
  })
}
console.log(`✅ 已绑定 ${hostname} → ${script}（未重新上传）`)

for (let attempt = 1; attempt <= rounds; attempt++) {
  await new Promise((r) => setTimeout(r, 5000))
  const results = []
  let ok = true
  for (const p of ['/', '/__cfp_version']) {
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
      body = String(err).slice(0, 80)
    }
    results.push(`  ${p} → ${status} ${body.slice(0, 60).replace(/\s+/g, ' ')}`)
    if (status !== '200') ok = false
  }
  console.log(`第 ${attempt} 轮：\n${results.join('\n')}`)
  if (ok) {
    console.log(`🎉 ${hostname} → 200（脚本正常，旧域名是被污染的）`)
    process.exit(0)
  }
}
console.error(`❌ ${hostname} 探测未通过`)
process.exit(1)
