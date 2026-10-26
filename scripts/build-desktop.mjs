// 构建 CFPilot 桌面版（Go 单二进制）。
//
// 产物：
//   packages/desktop/dist/cfpilot-<version>-windows-amd64.exe
//   packages/desktop/dist/cfpilot-<version>-linux-amd64
//   packages/desktop/dist/cfpilot-<version>-linux-arm64
//
// ## 界面资源从哪来
//
// 「同一份界面源码」的落地方式：本脚本把 packages/gui 的渲染层产物
// 拷进 packages/desktop/internal/server/assets/，再 go:embed 进去。
// 这样两个版本永远渲染同一份 HTML/JS，不存在「Go 版界面落后」的问题。
//
// ## 为什么先构建 gui
//
// gui 的 dist/renderer 是 esbuild 产物（renderer.ts → renderer.js）。
// 直接拷 TS 源码不可行，必须先跑 gui 的 build。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const desktopDir = join(repoRoot, 'packages', 'desktop')
const guiDist = join(repoRoot, 'packages', 'gui', 'dist', 'renderer')
const assetsDir = join(desktopDir, 'internal', 'server', 'assets')
const outDir = join(desktopDir, 'dist')

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
console.log(`[desktop] 构建 CFPilot Desktop v${version}`)

// ---- 1. 同步界面资源 ----
if (!existsSync(join(guiDist, 'index.html'))) {
  console.error('[desktop] 未找到 packages/gui/dist/renderer/index.html')
  console.error('[desktop] 请先执行：npm run build -w @cfpilot/gui')
  process.exit(1)
}
mkdirSync(assetsDir, { recursive: true })
for (const f of ['index.html', 'renderer.js']) {
  copyFileSync(join(guiDist, f), join(assetsDir, f))
  const kb = (statSync(join(assetsDir, f)).size / 1024).toFixed(1)
  console.log(`[desktop] 界面资源 ${f} → internal/server/assets/ (${kb} KB)`)
}

// ---- 2. 交叉编译 ----
const targets = [
  { goos: 'windows', goarch: 'amd64', out: `cfpilot-${version}-windows-amd64.exe`, extra: ['-H=windowsgui'] },
  { goos: 'linux', goarch: 'amd64', out: `cfpilot-${version}-linux-amd64`, extra: [] },
  { goos: 'linux', goarch: 'arm64', out: `cfpilot-${version}-linux-arm64`, extra: [] },
]

// 允许用环境变量限制目标（CI 分平台构建时用）
const only = (process.env.CFPILOT_DESKTOP_TARGETS || '').trim()
const picked = only
  ? targets.filter((t) => only.split(',').includes(`${t.goos}/${t.goarch}`) || only.split(',').includes(t.goos))
  : targets

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const ldflags = (extra) =>
  ['-s', '-w', `-X main.Version=${version}`, ...extra].join(' ')

for (const t of picked) {
  const outPath = join(outDir, t.out)
  const args = [
    'build',
    '-trimpath',
    `-ldflags=${ldflags(t.extra)}`,
    '-o',
    outPath,
    './cmd/cfpilot',
  ]
  console.log(`[desktop] 编译 ${t.goos}/${t.goarch} …`)
  execFileSync('go', args, {
    cwd: desktopDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // CGO 必须关：开 CGO 就编不过 Linux（systray 已是纯 Go 实现），
      // 且关掉后产物是静态二进制，不挑 glibc 版本。
      CGO_ENABLED: '0',
      GOOS: t.goos,
      GOARCH: t.goarch,
    },
  })
  const mb = (statSync(outPath).size / 1024 / 1024).toFixed(2)
  console.log(`[desktop] ✅ ${t.out} (${mb} MB)`)
}

console.log('[desktop] 全部完成')
