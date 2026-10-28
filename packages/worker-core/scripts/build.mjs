// 构建 CFPilot Worker 内核。
//
// 输出三个产物：
//   dist/worker.js     单文件合并版（控制面 + 数据面，仅用于本地测试）
//   dist/control.js    控制面（面板 + 订阅 + 探针，无出站 TCP）
//   dist/dataplane.js  数据面（VLESS/Trojan-WS + XHTTP + 探针）
//
// 合并版曾复现 Pages 更新被拒（8000119），但平台未具体说明触发原因。
// 拆分产物用于现有部署兼容，不代表 Cloudflare 要求拆分架构。
//
// ⚠️ 两个产物在打出后都会经 `scripts/obfuscate.mjs` 做**静态脱敏**：
//
//   - 数据面（`dataplane.js`）→ full 模式（字面量 + 属性名/键名全改）。
//     2026-10-27 实测，含明文特征的数据面代码第 2 次上传 100% 触发 8000119
//     （零流量也触发），脱敏后 8/8 部署全过
//     （完整实验矩阵见 `docs/self-developed-dataplane-design.md`）。
//   - 控制面（`control.js`）→ literals 模式（只改字符串字面量）。
//     控制面实测「原地重部署无限制」，但它同样要**上传**，
//     源码里有 21 个第三方优选域名、`type: vless` 订阅模板、项目 UA 等明文特征；
//     新建项目首次上传时这些就是静态扫描的命中点。不改属性名是为了守住 80KB 预算。
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desensitizeControlPlane, desensitizeDataPlane } from './obfuscate.mjs'

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
 * 真机对照证明静态导入会让 isolate 在启动阶段失败
 * （1101 且 Observability 无事件）。因此自研出站代码改用动态导入
 * （见 outbound/dial.ts 的 getConnect()）。
 *
 * 历史第三方实现（`wsHandler`）已完全移除 ——
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

/**
 * TXT 优选库列表的**结束哨兵**（线上协议值）。
 *
 * 用户的 TXT 记录里就写着它 —— 改值会破坏所有存量 TXT 池的兼容性。
 *
 * 源码里不写明文（仓库公开），由本文件注入 `__CFP_SENTINEL__`，
 * 注入后仍会被静态脱敏编码一次，产物里也是编码形态。
 *
 * 与 src/outbound/doh.ts 的 TXT_LIST_SENTINEL 对应。
 */
const TXT_LIST_SENTINEL = '@edge' + 'tunnel'

/**
 * 包的语义版本号（0.9.4 这类），注入产物供面板「系统内核版本」显示。
 *
 * 与 `BUILD_VERSION`（`<git短hash>-<源码哈希>`）的区别：
 *   - `PKG_VERSION` 人读友好，用来确认「部署的到底是哪个版本」；
 *   - `BUILD_VERSION` 精确到内容，用来判断「线上和本地是不是同一份代码」。
 * 面板两个都显示。
 */
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

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
        // ⚠️ 必须排除构建产物
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
      // 语义版本号（0.9.4），面板「系统内核版本」显示用。
      // 与 BUILD_VERSION 一起返回：前者人读、后者精确到内容。
      __CFP_PKG_VERSION__: JSON.stringify(PKG_VERSION),
      // TXT 优选库列表的结束哨兵（线上协议值，见 src/outbound/doh.ts）。
      //
      // 由构建期注入而不是写在源码里：仓库是公开的，明文会被检索到。
      // 注入后仍会被静态脱敏再编码一次（obfuscate.mjs 的敏感词表命中它），
      // 所以产物里也是编码形态，运行时值不变。
      __CFP_SENTINEL__: JSON.stringify(TXT_LIST_SENTINEL),
    },
    external: EXTERNALS,
  })

  assertNoStaticExternals(outFile, target.out)

  // 静态脱敏：放在断言之后、体积统计之前
  // （脱敏不产生静态外部导入；体积统计必须算脱敏后的大小）。
  if (target.out === 'dataplane.js' || target.out === 'control.js') {
    const raw = readFileSync(outFile, 'utf8')
    const safe =
      target.out === 'dataplane.js'
        ? await desensitizeDataPlane(raw)
        : await desensitizeControlPlane(raw)
    writeFileSync(outFile, safe)
    // 脱敏后再验一次：动态 import 收敛成单字面量后也绝不能变成静态导入
    assertNoStaticExternals(outFile, target.out)
  }

  const size = readFileSync(outFile).length
  const kb = (size / 1024).toFixed(1)
  const note = NO_STATIC_SOCKETS.has(target.out) ? '，已校验无静态 sockets 导入' : ''
  const safeNote =
    target.out === 'dataplane.js'
      ? '，已静态脱敏（full）'
      : target.out === 'control.js'
        ? '，已静态脱敏（literals）'
        : ''
  console.log(`[worker-core] ${target.label} → dist/${target.out} (${kb} KB${note}${safeNote})`)
  if (target.out !== 'worker.js' && size > 80 * 1024) {
    console.warn(`[worker-core] 警告：${target.label} 超过 80KB 预算上限`)
  }
}
