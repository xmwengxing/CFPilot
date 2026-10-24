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
  // Workers 通道专用：纯自研、零 vendor。
  //
  // 真机实测：含 vendor 的数据面产物在 Workers 上 522（isolate 启动失败），
  // 而纯自研的 38KB 产物 200 —— Pages 通道两者都正常。
  // `worker-split` 部署默认使用本产物。
  { entry: 'src/entry-data-self.ts', out: 'dataplane-self.js', label: '数据面(Workers专用)' },
]

/**
 * 哪些产物**不允许**出现静态 `cloudflare:sockets` 导入。
 *
 * ## 真机结论（2026-10-24 最终定性：两个账号、60+ 轮对照）
 *
 * **Workers 通道下，静态 `import { connect } from 'cloudflare:sockets'`
 * 会让 isolate 在启动阶段失败，对外表现为 HTTP 522**；
 * 同一份字节内容部署到 Pages 上则 5/5 全部正常。
 *
 * 对照实验（同一账号、同一时刻、同一份代码，只改 connect 的来源）：
 *
 * | connect 来源                                     | Workers |
 * |--------------------------------------------------|---------|
 * | `import { connect } from 'cloudflare:sockets'`   | **522** |
 * | `request.fetcher.connect(...)`                   | **200** |
 *
 * 同类项目 edgetunnel 能稳定跑在 Workers 上，正因为它从不 import sockets，
 * 而是走 `request.fetcher.connect()`。cfnew / CFNext 都静态导入，
 * 因此在 Workers 上 522 —— **cfnew 只有 37KB，同样 522，可见与体积无关**。
 *
 * 因此**所有产物**都必须做到：
 *   1. 自研代码用 `outbound/dial.ts` 的动态导入（已有）；
 *   2. vendor 代码的静态导入由下面的 esbuild 插件在**构建时**改写为
 *      「从全局注入取 connect」—— 不改 vendor 源文件（遵守「勿改 vendor」铁律）。
 */
const NO_STATIC_SOCKETS = new Set(['control.js', 'dataplane.js', 'worker.js'])

/**
 * esbuild 插件：把 vendor 里的静态 sockets 导入改写为运行时注入。
 *
 * vendor（`src/vendor/cfnext-dataplane.js`）第一行是
 *   `import{connect as t}from"cloudflare:sockets";`
 * 这正是 Workers 522 的成因。我们**不改 vendor 源文件**，而是在构建时替换成：
 *
 *   `const t = __cfpGetConnect();`
 *
 * `__cfpGetConnect` 由 `src/outbound/dial.ts` 挂到 globalThis，
 * 数据面入口在每个请求里把 `request.fetcher.connect` 注入进去。
 * 这样 vendor 内部的 11 处 `t(...)` 调用完全不用动，语义保持一致。
 */
const vendorSocketsShim = {
  name: 'cfp-vendor-sockets-shim',
  setup(build) {
    build.onLoad({ filter: /vendor[\\/]cfnext-dataplane\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      const pattern =
        /import\s*\{\s*connect\s+as\s+([A-Za-z_$][\w$]*)\s*\}\s*from\s*["']cloudflare:sockets["']\s*;?/
      if (!pattern.test(source)) {
        // 没有静态导入就原样返回（vendor 可能已被上游改过）
        return { contents: source, loader: 'js' }
      }
      // ⚠️ 必须**惰性**取 connect，不能在模块顶层立即调用：
      // esbuild 打包后 vendor 与 dial.ts 的模块求值顺序不保证，
      // 顶层立即执行会拿到 undefined 并抛错（或缓存住错误实现）。
      const rewritten = source.replace(
        pattern,
        (_m, local) =>
          `const ${local} = (a, o) => {` +
          ` const g = globalThis.__cfpGetConnect;` +
          ` if (!g) throw new Error('connect 未注入：Workers 通道需要 request.fetcher.connect');` +
          ` const fn = g();` +
          ` return o === undefined ? fn(a) : fn(a, o);` +
          ` };`
      )
      return { contents: rewritten, loader: 'js' }
    })
  },
}

/**
 * esbuild 插件：把 `outbound/dial.ts` 里的 sockets 回退路径整体剥离。
 *
 * ## 为什么必须剥离（2026-10-24 真机决定性实验）
 *
 * 只要产物里**存在** `import("cloudflare" + ":sockets")` 这个表达式，
 * 哪怕它永远不执行，Workers 的 isolate 也会在启动阶段失败（对外 HTTP 522）。
 *
 * | 同一份 26KB 产物，只改 dial 调用           | Workers |
 * |--------------------------------------------|---------|
 * | `dialed = await dial({...})`（真调用）      | **522** |
 * | `dialed = await (async () => null)()`      | **200** |
 *
 * `dial()` 内部唯一与 sockets 相关的就是这条动态导入 —— 所以剥离它即可。
 *
 * Workers 通道的 connect 一律来自 `request.fetcher.connect` 注入，
 * 本就不需要回退路径；Pages 产物不剥离，保留回退能力。
 */
const stripSocketsFallback = {
  name: 'cfp-strip-sockets-fallback',
  setup(build) {
    build.onLoad({ filter: /outbound[\\/]dial\.ts$/ }, (args) => {
      let source = readFileSync(args.path, 'utf8')
      // 把 getConnect 里「动态导入 sockets」那段替换成纯注入实现
      const pattern =
        /async function getConnect\(\): Promise<ConnectFn> \{[\s\S]*?\n\}/
      if (!pattern.test(source)) {
        throw new Error(
          '[worker-core] 未能在 outbound/dial.ts 中定位 getConnect()，' +
            'stripSocketsFallback 插件失效 —— 请同步更新该插件的匹配规则。'
        )
      }
      source = source.replace(
        pattern,
        `async function getConnect(): Promise<ConnectFn> {\n` +
          `  // [构建期剥离] Workers 产物不含 cloudflare:sockets 回退路径。\n` +
          `  // connect 必须由 entry 的 installConnect(request) 注入。\n` +
          `  if (connectOverride) return connectOverride\n` +
          `  throw new Error('connect 未注入：Workers 通道需要 request.fetcher.connect（见 entry-data.ts）')\n` +
          `}`
      )
      return { contents: source, loader: 'ts' }
    })
  },
}

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
        else if (/\.(ts|html)$/.test(name)) files.push(p)
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
    // 1) 把 vendor 的静态 sockets 导入改写为运行时注入（Workers 通道必需）
    // 2) 剥离自研 dial.ts 里的动态 sockets 回退路径（同样必需）
    plugins: [vendorSocketsShim, stripSocketsFallback],
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
