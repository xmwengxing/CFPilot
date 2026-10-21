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

mkdirSync(outDir, { recursive: true })

/**
 * 把 external 的静态 import 提升到文件最顶部。
 *
 * esbuild 可能把静态 import 输出到文件中部，这在 ESM 语法上合法。
 * 保留历史归一化以稳定产物布局；对照实验没有证明 import 位置会导致 1101。
 * 不能把这项归一化当作 Cloudflare 运行时限制或线上故障的修复。
 */
function hoistExternals(outFile) {
  let bundle = readFileSync(outFile, 'utf8')
  const hoisted = []

  for (const spec of EXTERNALS) {
    const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `import\\s*(?:\\{[^{}]*\\}|\\*\\s*as\\s+[A-Za-z_$][\\w$]*|[A-Za-z_$][\\w$]*)\\s*from\\s*["']${escaped}["'];?`,
      'g'
    )
    bundle = bundle.replace(pattern, (match) => {
      hoisted.push(match)
      return ''
    })
  }

  const hoistedText = hoisted.join('')
  if (hoisted.length > 0) {
    bundle = hoistedText + bundle
    writeFileSync(outFile, bundle)
  }

  for (const spec of EXTERNALS) {
    const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const checker = new RegExp(`from\\s*["']${escaped}["']`, 'g')
    let hit
    while ((hit = checker.exec(bundle)) !== null) {
      if (hit.index >= hoistedText.length) {
        throw new Error(
          `[worker-core] ${spec} 的 import 不在文件开头（位置 ${hit.index}），` +
            '构建产物未满足本项目的 import 布局归一化约定。'
        )
      }
    }
  }

  return hoisted.length
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

  const hoisted = hoistExternals(outFile)
  const size = readFileSync(outFile).length
  const kb = (size / 1024).toFixed(1)
  console.log(
    `[worker-core] ${target.label} → dist/${target.out} (${kb} KB` +
      (hoisted > 0 ? `，提升 ${hoisted} 条 import` : '') +
      ')'
  )
  if (target.out !== 'worker.js' && size > 80 * 1024) {
    console.warn(`[worker-core] 警告：${target.label} 超过 80KB 预算上限`)
  }
}
