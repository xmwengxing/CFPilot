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
import { execSync } from 'node:child_process'
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
 * 旧版第三方实现（`wsHandler`）已于 2026-10-25 **完全移除** ——
 * 它占数据面产物体积 77% 且自带 sockets 静态 import。现在所有产物
 * 都是纯自研代码，因此断言覆盖**全部**产物。
 */
const NO_STATIC_SOCKETS = new Set(['worker.js', 'control.js', 'dataplane.js'])

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

/**
 * 构建版本号。
 *
 * 形式：`<git短hash>-<源码内容哈希前8位>`。
 *
 * ⚠️ 绝不能加时间戳：产物必须**可复现**，否则 CI 的
 * 「校验内置内核资产与最新构建一致」会因为每次构建内容不同而失败。
 *
 * 源码哈希覆盖 worker-core 的全部源文件，代码一改版本就变；
 * 代码没改则版本稳定 —— 这正是「同版本跳过部署」需要的行为。
 */
async function buildVersion() {
  let git = 'nogit'
  try {
    git = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    /* 不在 git 仓库时用 nogit */
  }

  // 对 worker-core/src 下所有 .ts 与 .html 求内容哈希
  let hash = 'nohash'
  try {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { createHash } = await import('node:crypto')
    const srcDir = resolve(pkgRoot, 'src')
    const files = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = resolve(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        // ⚠️ 必须排除构建产物（2026-10-27 修复版本号永不收敛）
        //
        // `ui/panel.generated.ts` 是 panel.html 压缩后的中间产物，
        // 每次构建都会重新生成。把它算进哈希会出两个问题：
        //   1. 哈希在**构建前**计算，用的是上一次的 generated
        //      → 改了面板 UI 后版本号不变，用户点「检查状态」永远显示「已是最新」
        //   2. 下一次构建又因为 generated 变了而得到新哈希
        //      → 版本号在两个值之间反复横跳，永不收敛
        //
        // 源码哈希只应覆盖**人写的东西**，不该包含机器生成的中间物。
        else if (/\.(ts|html)$/.test(name) && !/\.generated\.ts$/.test(name)) files.push(p)
      }
    }
    walk(srcDir)
    // 按路径排序保证顺序稳定
    files.sort()
    const digest = createHash('sha256')
    for (const file of files) {
      digest.update(readFileSync(file))
    }
    hash = digest.digest('hex').slice(0, 8)
  } catch {
    hash = 'nohash'
  }

  return `${git}-${hash}`
}

const BUILD_VERSION = await buildVersion()

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
    define: {
      'process.env.NODE_ENV': '"production"',
      __CFP_BUILD__: JSON.stringify(BUILD_VERSION),
    },
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
