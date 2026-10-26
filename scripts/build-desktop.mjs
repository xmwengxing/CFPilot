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
// ## adapter.js 为什么要构建时注入
//
// Go 版没有 Electron 的 preload，`window.cfpilot` 得由 webui/adapter.js 造出来。
// 但共用的 index.html **不能**硬写 `<script src="./adapter.js">` ——
// Electron 版没有这个文件，加载会 404（虽然不影响 renderer 执行，
// 但控制台报错很难看，且将来若改成阻塞式加载会直接坏掉）。
//
// 因此这里在拷贝 index.html 时**动态插入** adapter 的 script 标签。
// Electron 版的 index.html 保持原样，两个版本各取所需。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const desktopDir = join(repoRoot, 'packages', 'desktop')
const guiDist = join(repoRoot, 'packages', 'gui', 'dist', 'renderer')
const assetsDir = join(desktopDir, 'internal', 'server', 'assets')
const webuiDir = join(desktopDir, 'webui')
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

// index.html：插入 adapter.js 的 script 标签（在 renderer.js 之前）
const htmlRaw = readFileSync(join(guiDist, 'index.html'), 'utf8')
const rendererTag = '<script src="./renderer.js"></script>'
if (!htmlRaw.includes(rendererTag)) {
  console.error('[desktop] index.html 里找不到 renderer.js 的 script 标签，无法插入 adapter')
  process.exit(1)
}
const htmlOut = htmlRaw.replace(
  rendererTag,
  // adapter 必须在 renderer 之前执行：renderer 在 DOMContentLoaded 时
  // 就要取 window.cfpilot，晚一步就是 undefined
  '<script src="./adapter.js"></script>\n  ' + rendererTag
)
writeFileSync(join(assetsDir, 'index.html'), htmlOut, 'utf8')
console.log(
  `[desktop] 界面资源 index.html → internal/server/assets/ (${(statSync(join(assetsDir, 'index.html')).size / 1024).toFixed(1)} KB，已注入 adapter)`
)

// renderer.js：直接拷贝
copyFileSync(join(guiDist, 'renderer.js'), join(assetsDir, 'renderer.js'))
console.log(
  `[desktop] 界面资源 renderer.js → internal/server/assets/ (${(statSync(join(assetsDir, 'renderer.js')).size / 1024).toFixed(1)} KB)`
)

// adapter.js：从 webui/ 拷进来
const adapterSrc = join(webuiDir, 'adapter.js')
if (!existsSync(adapterSrc)) {
  console.error('[desktop] 未找到 webui/adapter.js')
  process.exit(1)
}
copyFileSync(adapterSrc, join(assetsDir, 'adapter.js'))
console.log(
  `[desktop] 界面资源 adapter.js → internal/server/assets/ (${(statSync(join(assetsDir, 'adapter.js')).size / 1024).toFixed(1)} KB)`
)

// 构建目标（图标生成阶段就要知道是否编 Windows，所以定义在最前面）
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

// ---- 2. 生成图标与 Windows 资源 ----
//
// 顺序很重要：
//   1. gen-desktop-icons.mjs 从品牌色生成真实的 16/32 PNG 与多尺寸 ICO，
//      并把 PNG 字节内嵌成 internal/tray/icon.go
//   2. go-winres 把 ICO + 版本信息写成 rsrc_windows_amd64.syso，
//      go build 会自动拾取它，exe 这才**有图标**、有版本属性
//
// ⚠️ 早期版本托盘图标是手写的假 PNG 字节，LoadImage 失败导致
// 托盘初始化崩溃 → 程序以 exit code 2 静默退出（双击毫无反应）。
// 现在图标全部由脚本真实生成，并把生成逻辑纳入构建流程，
// 避免有人手改 icon.go 又弄出假字节。
execFileSync(process.execPath, [join(repoRoot, 'scripts', 'gen-desktop-icons.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
})

// go-winres 只对 Windows 目标有意义；没装就跳过（不阻断 Linux 构建）
if (picked.some((t) => t.goos === 'windows')) {
  const winres = findWinres()
  if (winres) {
    console.log('[desktop] 生成 Windows 资源（图标 + 版本信息）…')
    // ⚠️ 输出目录必须是**Go 包目录**（cmd/cfpilot/），
    // go build 只会自动拾取「当前编译包」里的 .syso。
    // 放到 build/ 之类的地方会被静默忽略 —— 表现为 exe 有图标却
    // 没有版本信息（实测踩过），很难看出是 syso 没被链接。
    const pkgDir = join(desktopDir, 'cmd', 'cfpilot')
    execFileSync(
      winres,
      [
        'simply',
        '--icon', 'app.ico',
        '--product-name', 'CFPilot',
        '--file-description', 'CFPilot 部署与维护工具',
        '--copyright', 'Copyright © CFPilot Contributors',
        '--original-filename', 'cfpilot.exe',
        '--file-version', version,
        '--product-version', version,
        '--manifest', 'gui',
        '--out', join(pkgDir, 'rsrc'),
      ],
      { cwd: join(desktopDir, 'build'), stdio: 'inherit' }
    )
    console.log('[desktop] ✅ cmd/cfpilot/rsrc_windows_amd64.syso（exe 将带图标与版本属性）')
  } else {
    console.warn('[desktop] ⚠ 未找到 go-winres，exe 将没有图标与版本属性')
    console.warn('[desktop]   安装：go install github.com/tc-hib/go-winres@latest')
  }
}

// ---- 3. 交叉编译 ----
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const ldflags = (extra) => ['-s', '-w', `-X main.Version=${version}`, ...extra].join(' ')

/**
 * 查找 go-winres 可执行文件。
 *
 * 依次找：GOPATH/bin → PATH → 常见安装位置。
 * 找不到返回 null（构建降级为「无图标」，不阻断）。
 */
function findWinres() {
  const exe = process.platform === 'win32' ? 'go-winres.exe' : 'go-winres'
  const candidates = []

  const gopath = process.env.GOPATH || join(process.env.USERPROFILE || process.env.HOME || '', 'go')
  candidates.push(join(gopath, 'bin', exe))

  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir) candidates.push(join(dir, exe))
  }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

for (const t of picked) {
  const outPath = join(outDir, t.out)
  console.log(`[desktop] 编译 ${t.goos}/${t.goarch} …`)
  execFileSync(
    'go',
    ['build', '-trimpath', `-ldflags=${ldflags(t.extra)}`, '-o', outPath, './cmd/cfpilot'],
    {
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
    }
  )
  const mb = (statSync(outPath).size / 1024 / 1024).toFixed(2)
  console.log(`[desktop] ✅ ${t.out} (${mb} MB)`)
}

console.log('[desktop] 全部完成')
