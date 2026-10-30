// 内核产物「静态脱敏」契约检查。
//
// ## 为什么需要这个脚本
//
// `packages/worker-core/scripts/obfuscate.mjs` 是 **8000119 风控的唯一已证实规避手段**
// （2026-10-27 判决性实验：明文产物第 2 次上传 100% 被拒、脱敏后 8/8 通过）。
// 它有两个容易悄悄失效的地方：
//
//   1. **规则被改坏**：比如为了省体积把某类字面量排除掉，产物重新出现明文域名；
//   2. **新代码引入新特征**：新加一个优选域名库 / 反代入口，没人记得它会被编码。
//
// 光靠 obfuscate.mjs 内的自检不够 —— 那份自检词表是**手写枚举**的，
// 而这里直接拿**源码里的真实域名**去比对产物，属于「从源头反查」。
//
// ## 检查项
//
//   1. 两个产物都以带缓存的 `__sfx` 解码器开头（说明脱敏步骤真的跑了）；
//   2. 源码里的第三方域名（优选域名库 / 反代入口表 / 测速 URL）不在产物里明文出现；
//   3. 数据面无协议关键字明文（vless / trojan / xhttp / socks5 / websocket / cfpilot）；
//   4. 控制面的面板 HTML（gzip+base64）**仍在**——它必须被跳过编码，否则体积超预算；
//   5. 两个产物都在体积预算内（AGENTS.md §1.4，当前 96KB）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 收集问题的数组；为空表示全部通过 */
const problems = []
const note = (msg) => problems.push(msg)

const read = (rel) => readFileSync(resolve(root, rel), 'utf8')

const ARTIFACTS = [
  { name: 'control.js', path: 'packages/worker-core/dist/control.js' },
  { name: 'dataplane.js', path: 'packages/worker-core/dist/dataplane.js' },
]

// 源码里「不该以明文出现在产物里」的域名：优选域名库 + 反代入口表。
const DOMAIN_SOURCES = [
  'packages/worker-core/src/data/pools.ts',
  'packages/worker-core/src/outbound/relay.ts',
]

/** 从源码里抠出形如域名/IP 的字面量（排除 IP 与明显不是域名的短串） */
function collectSourceDomains() {
  const out = new Set()
  for (const rel of DOMAIN_SOURCES) {
    const text = read(rel)
    for (const m of text.matchAll(/'([a-z0-9][a-z0-9.-]*\.[a-z]{2,24})'/g)) {
      const domain = m[1]
      // 只收真域名（至少两段、TLD 全是字母），IP 字面量本来就被别的规则覆盖
      if (/^\d/.test(domain)) continue
      out.add(domain)
    }
  }
  return [...out]
}

const sourceDomains = collectSourceDomains()
if (sourceDomains.length < 5) {
  // 抠不到说明源码结构变了，检查本身失效 —— 必须报错而不是静默通过
  note(`DOMAIN_SOURCES 里只找到 ${sourceDomains.length} 个域名，域名提取规则可能已失效`)
}

for (const artifact of ARTIFACTS) {
  const code = read(artifact.path)
  const kb = code.length / 1024

  // 1) 解码器必须存在且带缓存
  if (!code.startsWith('const __sfx=')) {
    note(`${artifact.name}: 未以 __sfx 解码器开头，静态脱敏没有执行`)
    continue
  }
  if (!/__c\s*=\s*new Map\(\)/.test(code)) {
    note(`${artifact.name}: __sfx 解码器没有结果缓存（每次调用都会 new TextDecoder）`)
  }
  const encoded = (code.match(/__sfx\(/g) ?? []).length
  if (encoded < 50) {
    note(`${artifact.name}: 只编码了 ${encoded} 处字面量，脱敏规则疑似失效`)
  }

  // 2) 源码域名不能明文出现
  const leakedDomains = sourceDomains.filter((d) => code.includes(d))
  if (leakedDomains.length > 0) {
    note(`${artifact.name}: 明文残留第三方域名 ${leakedDomains.join(', ')}`)
  }

  // 3) 数据面不允许协议关键字明文
  if (artifact.name === 'dataplane.js') {
    const stripped = code.replace(/WebSocketPair/g, '')
    const words = ['vless', 'trojan', 'xhttp', 'socks5', 'websocket', 'cfpilot']
    const leaked = words.filter((w) => new RegExp(w, 'i').test(stripped))
    if (leaked.length > 0) {
      note(`dataplane.js: 明文残留协议关键字 ${leaked.join(', ')}`)
    }
  }

  // 4) 控制面的面板 HTML 必须仍是未编码的 gzip+base64
  //    （它超过 MAX_LITERAL_CHARS 被跳过；一旦被编码，体积会 +33% 顶爆预算）
  if (artifact.name === 'control.js' && !code.includes('H4sI')) {
    note('control.js: 找不到面板 HTML 的 gzip base64 载荷（是否被误编码？）')
  }

  // 5) 体积预算
  //
  // 与 worker-core/scripts/build.mjs 的 SIZE_BUDGET_KB 保持一致（2026-10-30 由 80 调到 96）。
  // 80KB 是早期自定的数，没有平台依据；而静态脱敏会把含中文的字面量整段 base64
  // （产物里 260 个，体积 ×1.33），80KB 时控制面只剩 26 字节余量。
  const SIZE_BUDGET_KB = 96
  if (kb > SIZE_BUDGET_KB) {
    note(`${artifact.name}: ${kb.toFixed(1)} KB 超出 ${SIZE_BUDGET_KB}KB 预算（AGENTS.md §1.4）`)
  }
}

if (problems.length > 0) {
  console.error('[check-kernel-desensitize] 失败：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const sizes = ARTIFACTS.map((a) => {
  const kb = (readFileSync(resolve(root, a.path)).length / 1024).toFixed(1)
  return `${a.name} ${kb}KB`
}).join(' / ')
console.log(
  `[check-kernel-desensitize] 通过：${sizes}；源码域名 ${sourceDomains.length} 个全部未明文出现`
)
