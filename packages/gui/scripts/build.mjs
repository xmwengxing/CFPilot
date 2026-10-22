// 构建 CFPilot GUI。
//
// 产物：
//   dist/main/main.js        主进程入口
//   dist/main/bridge.js      桥接层（独立文件，避免 bundle 后导出失效）
//   dist/main/config-store.js 凭据存储（独立文件）
//   dist/preload/preload.js  预加载脚本
//   dist/renderer/renderer.js 渲染层
//   dist/renderer/index.html
//
// 为什么 bridge / config-store 不 bundle 进 main.js：
//   esbuild 把 ESM 源码转成 CJS 时会加 `0 && (module.exports = {...})` 守卫，
//   被内联的模块导出会变成死代码，运行时拿到 undefined。
//   分成独立文件各自导出即可绕开。
import { build } from 'esbuild'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = resolve(pkgRoot, 'dist')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(resolve(outDir, 'main'), { recursive: true })
mkdirSync(resolve(outDir, 'preload'), { recursive: true })
mkdirSync(resolve(outDir, 'renderer'), { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  // Electron 主进程用 CJS 最稳（ESM 输出会让 esbuild 生成对不存在变量的解构）
  format: 'cjs',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  // electron 由运行时提供，不打进包里
  external: ['electron'],
}

// 主进程相关：config-store 与 bridge 各自独立成文件，main.js 只做入口
const mainTargets = [
  { entry: 'src/main/config-store.ts', out: 'main/config-store.js', label: '凭据存储' },
  { entry: 'src/main/scanner.ts', out: 'main/scanner.js', label: '优选桥接' },
  { entry: 'src/main/bridge.ts', out: 'main/bridge.js', label: '桥接层' },
  { entry: 'src/main/main.ts', out: 'main/main.js', label: '主进程入口' },
]

for (const target of mainTargets) {
  await build({
    ...common,
    entryPoints: [resolve(pkgRoot, target.entry)],
    outfile: resolve(outDir, target.out),
  })
  console.log(`[gui] ${target.label} → dist/${target.out}`)
}

// scanner 库：scanner-cli 的扫描逻辑本来就是库函数（runScan / resolveCandidates），
// 这里单独打成一个文件给主进程 import —— 不起子进程，也不需要系统装 Node。
// 用 CJS：主进程产物也是 CJS，动态 import() 在 CJS 里加载 ESM 会被 esbuild
// 转成 import 语句，导致 "Cannot use import statement outside a module"。
const repoRoot = resolve(pkgRoot, '../..')
await build({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  entryPoints: [resolve(repoRoot, 'packages/scanner-cli/src/scanner-lib.ts')],
  outfile: resolve(outDir, 'main/scanner-lib.js'),
})
console.log('[gui] scanner 库 → dist/main/scanner-lib.js')

// 预加载与渲染层
const uiTargets = [
  { entry: 'src/preload/preload.ts', out: 'preload/preload.js', label: '预加载' },
  { entry: 'src/renderer/renderer.ts', out: 'renderer/renderer.js', label: '渲染层' },
]

for (const target of uiTargets) {
  await build({
    ...common,
    entryPoints: [resolve(pkgRoot, target.entry)],
    outfile: resolve(outDir, target.out),
  })
  console.log(`[gui] ${target.label} → dist/${target.out}`)
}

copyFileSync(resolve(pkgRoot, 'src/renderer/index.html'), resolve(outDir, 'renderer/index.html'))
console.log('[gui] index.html → dist/renderer/index.html')
