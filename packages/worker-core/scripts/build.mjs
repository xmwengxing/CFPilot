// 构建 CFPilot Worker 内核。
//
// 输出三个产物：
//   dist/worker.js     单文件合并版（控制面 + 数据面，仅用于本地测试）
//   dist/control.js    控制面（面板 + 订阅 + 探针，无出站 TCP）
//   dist/dataplane.js  数据面（VLESS/Trojan-WS + XHTTP + 探针）
//
// 合并版曾复现 Pages 更新被拒（8000119），但平台未说明具体触发原因。
// 拆分产物用于现有部署兼容，不代表 Cloudflare 要求拆分架构。
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = resolve(pkgRoot, 'dist')

/** 运行时内置模块（不能被打包器解析） */
const EXTERNALS = ['cloudflare:sockets']

const TARGETS = [
  { entry: 'src/index.ts', out: 'worker.js', label: '合并版' },
  { entry: 'src/entry-control.ts', out: 'control.js', label: '控制面' },
  { entry: 'src/entry-data.ts', out: 'dataplane.js', label: '数据面' },
]

/**
 * 哪些产物**不允许**出现静态 `cloudflare:sockets` 导入。
 *
 * 真机对照（2026-10-22）证明静态导入会让 isolate 在启动阶段失败
 * （1101 且 Observability 无事件）。因此自研出站代码改用动态导入
 * （见 outbound/dial.ts 的 getConnect()）。
 *
 * 但数据面（dataplane.js）整体复用 vendor/cfnext-dataplane.js，
 * 该文件自身静态导入 sockets 且**在真实 Cloudflare 上工作正常**——
 * 说明静态导入并非绝对不可用，还与运行环境有关。
 * 因此断言只覆盖控制面，数据面按原样构建。
 */
const NO_STATIC_SOCKETS = new Set(['control.js'])

mkdirSync(outDir, { recursive: true })

/**
 * 校验指定产物里没有静态的外部 import。
 *
 * 一旦自研代码改回静态 import，构建直接失败，避免再把故障带上生产。
 */
function assertNoStaticExternals(outFile, targetName) {
  if (!NO_STATIC_SOCKETS.has(targetName)) return
  const bundle = readFileSync(outFile, 'utf8')
  for (const spec of EXTERNALS) {
    const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `import\\s*(?:\\{[^{}]*\\}|\\*\\s*as\\s+[A-Za-z_$][\\w$]*|[A-Za-z_$][\\w$]*)\\s*from\\s*["']${escaped}["']`,
      'g'
    )
    const hit = pattern.exec(bundle)
    if (hit) {
      throw new Error(
        `[worker-core] ${targetName} 含静态 import ${spec}（位置 ${hit.index}）。` +
          '自研出站代码必须改用 outbound/dial.ts 的 getConnect() 动态导入。'
      )
    }
  }
}

for (const target of TARGETS) {
  const outFile = resolve(outDir, target.out)
  await build({
    entryPoints: [resolve(pkgRoot, target.entry)],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    conditions: ['worker', 'browser'],
    define: { 'process.env.NODE_ENV': '"production"' },
    external: EXTERNALS,
  })

  assertNoStaticExternals(outFile, target.out)
  const size = readFileSync(outFile).length
  const kb = (size / 1024).toFixed(1)
  const note = NO_STATIC_SOCKETS.has(target.out) ? '，已校验无静态 sockets 导入' : ''
  console.log(`[worker-core] ${target.label} → dist/${target.out} (${kb} KB${note})`)
  if (target.out !== 'worker.js' && size > 80 * 1024) {
    console.warn(`[worker-core] 警告：${target.label} 超过 80KB 预算上限`)
  }
}
