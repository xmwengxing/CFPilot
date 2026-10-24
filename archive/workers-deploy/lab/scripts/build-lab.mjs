// 522 根因实验：构建对照变体产物（仅实验用，不参与正式构建）。
//
// 变体：
//   lab-current.js  现行 dataplane-self 形态（动态 import + 惰性 init）—— 基线
//   lab-inline.js   完全内联形态（全静态 import，单作用域，edgetunnel 形态）
//
// 两者都应用 stripSocketsFallback（与正式 Workers 产物一致：不含 cloudflare:sockets）。
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..', '..')
const outDir = resolve(pkgRoot, 'dist-lab')
mkdirSync(outDir, { recursive: true })

/** 与正式构建一致：剥离 dial.ts 里的动态 sockets 回退路径 */
const stripSocketsFallback = {
  name: 'cfp-strip-sockets-fallback',
  setup(build) {
    build.onLoad({ filter: /outbound[\\/]dial\.ts$/ }, (args) => {
      let source = readFileSync(args.path, 'utf8')
      const pattern = /async function getConnect\(\): Promise<ConnectFn> \{[\s\S]*?\n\}/
      if (!pattern.test(source)) {
        throw new Error('[lab] 未能定位 getConnect()，请同步 strip 插件匹配规则')
      }
      source = source.replace(
        pattern,
        `async function getConnect(): Promise<ConnectFn> {\n` +
          `  if (connectOverride) return connectOverride\n` +
          `  throw new Error('connect 未注入')\n` +
          `}`
      )
      return { contents: source, loader: 'ts' }
    })
  },
}

const VARIANTS = [
  { entry: 'src/entry-data-self.ts', out: 'lab-current.js', label: '现行形态(动态import)' },
  { entry: 'lab-src/entry-inline.ts', out: 'lab-inline.js', label: '完全内联形态(静态import+顶层写globalThis)' },
  // 2×2 二分：{顶层写 globalThis: 是/否} × {包形态: 单作用域/惰性init}
  { entry: 'lab-src/entry-inline-noglobal.ts', out: 'lab-inline-noglobal.js', label: 'A:内联但顶层不写globalThis' },
  { entry: 'lab-src/entry-current-topleveldial.ts', out: 'lab-current-topleveldial.js', label: 'B:现行形态+顶层写globalThis' },
  // 最小化复现：逐步缩小到最小触发面
  { entry: 'lab-src/entry-m3.ts', out: 'lab-m3.js', label: 'M3:dial单独+静态引用' },
  { entry: 'lab-src/entry-m1.ts', out: 'lab-m1.js', label: 'M1:websocket-self+dial(不引用dial符号)' },
  { entry: 'lab-src/entry-m2.ts', out: 'lab-m2.js', label: 'M2:M1+静态引用dial符号' },
  { entry: 'lab-src/entry-s-toplevelglobal.ts', out: 'lab-s.js', label: 'S:顶层globalThis写入(微型)' },
  { entry: 'lab-src/entry-s2-stubdial.ts', out: 'lab-s2.js', label: 'S2:websocket-self+dial桩(无dial模块)' },
  { entry: 'lab-src/entry-s-ctrl.ts', out: 'lab-s-ctrl.js', label: 'S-ctrl:无顶层写入(对照)' },
]

for (const v of VARIANTS) {
  const outFile = resolve(outDir, v.out)
  await build({
    entryPoints: [resolve(pkgRoot, v.entry)],
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
      __CFP_BUILD__: JSON.stringify('lab-' + v.out.replace(/\.js$/, '')),
    },
    external: ['cloudflare:sockets'],
    plugins: [stripSocketsFallback],
  })
  const src = readFileSync(outFile, 'utf8')
  const kb = (src.length / 1024).toFixed(1)
  const hasLazy = /__commonJS|__toESM|__esm/.test(src) ? '含惰性init' : '纯单作用域'
  const hasSockets = src.includes('cloudflare:sockets') ? ' ⚠️含sockets字样' : ''
  console.log(`[lab] ${v.label} → dist-lab/${v.out} (${kb} KB, ${hasLazy}${hasSockets})`)
}
