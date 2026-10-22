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
 * 校验产物里没有静态的外部 import。
 *
 * `cloudflare:sockets` 已改为运行时拼接的动态 import（见 outbound/dial.ts）：
 * 真机对照证明静态导入会让 isolate 在启动阶段失败（1101 且无调用日志）。
 * 因此这里从「提升到首字节」改为「必须不存在静态导入」——
 * 一旦有人改回静态 import，构建直接失败，避免再把故障带上生产。
 */
function assertNoStaticExternals(outFile) {
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
        `[worker-core] 产物含静态 import ${spec}（位置 ${hit.index}）。` +
          '这会让 isolate 启动失败（1101）。请改用 outbound/dial.ts 里的 getConnect() 动态导入。'
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

  assertNoStaticExternals(outFile)
  const size = readFileSync(outFile).length
  const kb = (size / 1024).toFixed(1)
  console.log(`[worker-core] ${target.label} → dist/${target.out} (${kb} KB，无静态外部导入)`)
  if (target.out !== 'worker.js' && size > 80 * 1024) {
    console.warn(`[worker-core] 警告：${target.label} 超过 80KB 预算上限`)
  }
}
