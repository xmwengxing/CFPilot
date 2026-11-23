// 校验「XHTTP 无凭据探针」的判据文本与数据面中性页没有漂移。
//
// ## 为什么需要这个脚本（2026-11-23 真机故障）
//
// XHTTP 优选阶段二做的是**无凭据**端点探针：数据面认证不了请求，
// 只能靠响应形态判断「这个 IP 上的站点是不是我们的实例」。
//
// 判据依赖数据面中性页里的那两句话（铁律 33：入站端点对外只准像普通静态站，
// 未认证一律回中性页）。一旦有人改了中性页文案，CLI 与桌面版的探针
// 就会把**所有**候选判成「不是本站数据面」，XHTTP 优选直接全军覆没 ——
// 而这个故障只在真机扫描时才暴露，单元测试用的是自己写的假页。
//
// 所以这里把三处锁在一起：
//   packages/worker-core/src/ui/neutral.ts   （判据来源）
//   packages/cli/src/scan/true-probe.ts      （CLI 探针）
//   packages/desktop/internal/scan/xhttp.go  （桌面探针）
import { readFileSync } from 'node:fs'

const MARKER = 'This site is up and running.'

const sources = {
  '数据面中性页': 'packages/worker-core/src/ui/neutral.ts',
  'CLI 探针': 'packages/cli/src/scan/true-probe.ts',
  '桌面探针': 'packages/desktop/internal/scan/xhttp.go',
}

let bad = 0

for (const [name, file] of Object.entries(sources)) {
  const text = readFileSync(file, 'utf8')
  const hit = text.includes(MARKER)
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${name} 含判据文本（${file}）`)
  if (!hit) bad++
}

// 探针里必须是「按响应体判站」，不能再出现「期望 400」那种判据。
const cliProbe = readFileSync('packages/cli/src/scan/true-probe.ts', 'utf8')
const goProbe = readFileSync('packages/desktop/internal/scan/xhttp.go', 'utf8')

const shapeChecks = [
  ['CLI 探针有中性页常量', /NEUTRAL_PAGE_MARKER\s*=\s*'This site is up and running\.'/],
  ['桌面探针有中性页常量', /neutralPageMarker\s*=\s*"This site is up and running\."/],
  ['CLI 探针按响应体判站', /text\.includes\(NEUTRAL_PAGE_MARKER\)/],
  ['桌面探针按响应体判站', /bytes\.Contains\(body, \[\]byte\(neutralPageMarker\)\)/],
]

for (const [name, re] of shapeChecks) {
  const hit = re.test(cliProbe) || re.test(goProbe)
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${name}`)
  if (!hit) bad++
}

if (bad > 0) {
  console.error(`\n✗ ${bad} 项未通过：中性页文案改动后必须同步 CLI 与桌面版探针判据`)
  process.exit(1)
}

console.log('\n全部通过：XHTTP 探针判据与数据面中性页一致。')
