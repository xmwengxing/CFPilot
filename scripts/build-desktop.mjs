// 构建 CFPilot 桌面版（Go 单二进制）。
//
// 产物：
//   packages/desktop/dist/cfpilot-<version>-windows-amd64.exe
//   packages/desktop/dist/cfpilot-<version>-linux-amd64
//   packages/desktop/dist/cfpilot-<version>-linux-arm64
//
// ## 界面资源从哪来
//
// 「同一份界面源码」的落地方式：本脚本把 packages/ui 的界面产物
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
// 界面产物来源（2026-10-27 变更）
//
// 早期是 packages/gui/dist/renderer —— 界面源码长在 Electron 外壳里。
// 0.6.4 起不再发布 Electron 版，外壳移出仓库，界面抽成独立的 @cfpilot/ui。
// 现在从 packages/ui/dist 取，语义清晰，也不再依赖任何外壳。
const uiDist = join(repoRoot, 'packages', 'ui', 'dist')
const assetsDir = join(desktopDir, 'internal', 'server', 'assets')
const webuiDir = join(desktopDir, 'webui')
const outDir = join(desktopDir, 'dist')

// ---- Windows 资源工具的版本（go-winres）----
//
// go-winres 的版本**必须 pin，不要改成 @latest，也不要省略版本号**。
//
// 为什么必须 pin：
//   - CI（release-desktop.yml）用 `go install github.com/tc-hib/go-winres@<版本>` 装它，
//     本脚本的回退用 `go run github.com/tc-hib/go-winres@<版本>`。
//     两处版本必须一致，否则「本地编出来的 exe」与「CI 编出来的 exe」
//     资源写法可能不同，出问题极难复现。
//   - 用 @latest 会让构建行为随上游发版漂移：某天上游改了 syso 格式或
//     `simply` 的参数，CI 会突然挂在一个和本次改动毫无关系的步骤上。
//
// 为什么是 v0.3.3：
//   - 上游当前**最新 release**（2024-04-11 发布，之后未再发新版本）；
//   - 也是本机已安装、模块缓存里验证过 `simply` 能正常出 syso 的版本。
const WINRES_VERSION = 'v0.3.3'
const WINRES_MODULE = `github.com/tc-hib/go-winres@${WINRES_VERSION}`

// go-winres 产出的资源文件名（--out 只给前缀，后缀由工具按架构补）
const WINRES_OUT = 'rsrc'
// go build 交叉编译 windows/amd64 时自动拾取的就是这个文件
const WINRES_SYSO = join(desktopDir, 'cmd', 'cfpilot', `${WINRES_OUT}_windows_amd64.syso`)

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
console.log(`[desktop] 构建 CFPilot Desktop v${version}`)

// ---- 1. 同步界面资源 ----
if (!existsSync(join(uiDist, 'index.html'))) {
  console.error('[desktop] 未找到 packages/ui/dist/index.html')
  console.error('[desktop] 请先执行：npm run build -w @cfpilot/ui')
  process.exit(1)
}
mkdirSync(assetsDir, { recursive: true })

// index.html：插入 adapter.js 的 script 标签（在 renderer.js 之前）
const htmlRaw = readFileSync(join(uiDist, 'index.html'), 'utf8')
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
copyFileSync(join(uiDist, 'renderer.js'), join(assetsDir, 'renderer.js'))
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

// vps-socks5.sh：链式代理（自建落地节点）的部署脚本。
//
// 单一来源仍是 scripts/vps/deploy-socks5.sh —— 这里只是把它复制进
// internal/server/assets/，好让 Go 的 //go:embed 能把它打进 exe。
// ⚠️ 不要手工改 assets 里的副本，改源文件后重新跑构建。
const chainScriptSrc = join(repoRoot, 'scripts/vps/deploy-socks5.sh')
if (existsSync(chainScriptSrc)) {
  copyFileSync(chainScriptSrc, join(assetsDir, 'vps-socks5.sh'))
  console.log(
    `[desktop] 链式代理脚本 → internal/server/assets/vps-socks5.sh (${(statSync(join(assetsDir, 'vps-socks5.sh')).size / 1024).toFixed(1)} KB)`
  )
} else {
  console.warn('[desktop] 未找到 scripts/vps/deploy-socks5.sh，链式代理功能将不可用')
}

// ---- 1b. 同步 Worker 内核产物（go:embed 打进 exe）----
//
// ⚠️ 这一步曾经完全缺失，导致最严重的缺陷（2026-10-26）：
//
//   最初的设计假设「exe 旁边放 worker-core/dist 目录」，
//   但构建脚本从来没把产物拷进包里。用户下载的单文件 exe
//   **完全不包含内核**，点「开始部署」直接报
//   「找不到内核产物（control.js / dataplane.js）」——
//   部署功能 100% 不可用，整个应用是个空壳。
//
// 现在把产物拷到 internal/kernel/assets/ 再编译，
// go:embed 会把它打进二进制，做到真正的单文件分发。
const kernelSrcDir = join(repoRoot, 'packages', 'worker-core', 'dist')
const kernelDstDir = join(desktopDir, 'internal', 'kernel', 'assets')

for (const f of ['control.js', 'dataplane.js']) {
  if (!existsSync(join(kernelSrcDir, f))) {
    console.error(`[desktop] 未找到内核产物 ${f}`)
    console.error(`[desktop] 请先执行：npm run build -w @cfpilot/worker-core`)
    process.exit(1)
  }
}
mkdirSync(kernelDstDir, { recursive: true })
for (const f of ['control.js', 'dataplane.js']) {
  copyFileSync(join(kernelSrcDir, f), join(kernelDstDir, f))
  const kb = (statSync(join(kernelDstDir, f)).size / 1024).toFixed(1)
  console.log(`[desktop] 内核产物 ${f} → internal/kernel/assets/ (${kb} KB)`)
}

// 构建目标（图标生成阶段就要知道是否编 Windows，所以定义在最前面）
const targets = [
  { goos: 'windows', goarch: 'amd64', out: `cfpilot-${version}-windows-amd64.exe`, extra: ['-H=windowsgui'] },
  { goos: 'linux', goarch: 'amd64', out: `cfpilot-${version}-linux-amd64`, extra: [] },
  { goos: 'linux', goarch: 'arm64', out: `cfpilot-${version}-linux-arm64`, extra: [] },
]

// 允许限制构建目标（只编一部分平台时用）。
//
// 两种写法等价，都保留：
//   node scripts/build-desktop.mjs --only windows
//   node scripts/build-desktop.mjs --only windows,linux/amd64
//   CFPILOT_DESKTOP_TARGETS=windows node scripts/build-desktop.mjs   ← 环境变量（旧用法，保留兼容）
const onlyFlagIdx = process.argv.indexOf('--only')
let only = (process.env.CFPILOT_DESKTOP_TARGETS || '').trim()
if (onlyFlagIdx !== -1) {
  only = (process.argv[onlyFlagIdx + 1] || '').trim()
  if (!only) {
    console.error('[desktop] --only 需要一个值，例如：--only windows')
    process.exit(1)
  }
}
const wanted = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : []
const picked = wanted.length
  ? targets.filter((t) => wanted.includes(`${t.goos}/${t.goarch}`) || wanted.includes(t.goos))
  : targets
if (picked.length === 0) {
  console.error(`[desktop] 构建目标没有匹配到任何平台：${only}`)
  console.error(`[desktop] 可用目标：${targets.map((t) => `${t.goos}/${t.goarch}`).join(', ')}`)
  process.exit(1)
}
console.log(`[desktop] 构建目标：${picked.map((t) => `${t.goos}/${t.goarch}`).join(', ')}`)

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

// go-winres 只对 Windows 目标有意义；纯 Linux 构建不经过这里（Linux 不需要 .syso）
if (picked.some((t) => t.goos === 'windows')) {
  generateWindowsRes()
}

// ---- 3. 交叉编译 ----
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const ldflags = (extra) => ['-s', '-w', `-X main.Version=${version}`, ...extra].join(' ')

/**
 * 生成 Windows 资源（exe 图标 + 版本属性）→ cmd/cfpilot/rsrc_windows_*.syso
 *
 * ⚠️ 这是「仓库下载的 exe 没图标」那次故障（2026-10-29）的修复点，改之前先读：
 *
 * 旧实现的降级是**静默**的：findWinres() 找不到就 console.warn 一句然后继续编译。
 * 而 release-desktop.yml 从来没装过 go-winres —— 于是 CI 发布的每个 exe
 * 都「没图标、没版本属性」，本地却因为装过 go-winres 而完全正常。
 * 「CI 与本地环境不一致」被静默降级掩盖，等用户下载后才发现。
 *
 * 现在的策略（按顺序尝试，任一成功即继续）：
 *   1. 本机已安装的 go-winres（$GOPATH/bin → PATH）
 *   2. `go run github.com/tc-hib/go-winres@<pin 版本>` —— 只要机器上有 Go 就能用，
 *      不需要提前安装（首次会编译一次，约 20 秒）
 *   3. 两者都不可用 → **windows 目标直接报错终止**，绝不产出无图标的 exe
 *
 * 纯 Linux 构建不会进入本函数，行为完全不变。
 */
function generateWindowsRes() {
  console.log('[desktop] 生成 Windows 资源（图标 + 版本信息）…')

  // ⚠️ 输出目录必须是**Go 包目录**（cmd/cfpilot/）：
  // go build 只自动拾取「当前编译包」里的 .syso，放到 build/ 之类的地方
  // 会被静默忽略 —— 表现为 exe 有图标却没有版本信息（实测踩过）。
  const pkgDir = join(desktopDir, 'cmd', 'cfpilot')

  // 先删旧的 .syso：否则「本次其实没生成成功」会被上一次的残留文件掩盖，
  // 下面的存在性校验就成了假通过（本地反复构建时尤其容易踩）。
  for (const f of [`${WINRES_OUT}_windows_amd64.syso`, `${WINRES_OUT}_windows_386.syso`]) {
    rmSync(join(pkgDir, f), { force: true })
  }

  const args = [
    'simply',
    '--icon', 'app.ico',
    '--product-name', 'CFPilot',
    '--file-description', 'CFPilot 部署与维护工具',
    '--copyright', 'Copyright © CFPilot Contributors',
    '--original-filename', 'cfpilot.exe',
    '--file-version', version,
    '--product-version', version,
    '--manifest', 'gui',
    '--out', join(pkgDir, WINRES_OUT),
  ]
  // 工作目录是 desktop/build：app.ico 由 gen-desktop-icons.mjs 生成在这里
  const cwd = join(desktopDir, 'build')

  const local = findWinres()
  if (local) {
    console.log(`[desktop] 使用本机 go-winres：${local}`)
    try {
      execFileSync(local, args, { cwd, stdio: 'inherit' })
      assertWinresSyso()
      return
    } catch (e) {
      // 本地这份可能是坏的（残留的旧二进制 / 权限问题）——继续走 go run 回退
      console.warn(`[desktop] ⚠ 本机 go-winres 执行失败（${e.status ?? e.code ?? e.message}），改用 go run 回退`)
    }
  } else {
    console.warn('[desktop] 未找到本机 go-winres（$GOPATH/bin 或 PATH），改用 go run 回退')
  }

  // 回退：只要装了 Go 就能跑，不需要预装 go-winres。
  // CI 里正常会先 `go install ...@<pin>` 命中上面的分支，这里是双保险。
  if (!hasGo()) {
    failWinres('本机没有 go-winres 可执行文件，也没有可用的 go 命令')
  }
  console.log(`[desktop] 回退 go run ${WINRES_MODULE}（首次会先编译工具，约需 20 秒）…`)
  try {
    execFileSync('go', ['run', WINRES_MODULE, ...args], { cwd, stdio: 'inherit' })
  } catch (e) {
    failWinres(`go run ${WINRES_MODULE} 执行失败（${e.status ?? e.code ?? e.message}）`)
  }
  assertWinresSyso()
}

/** 校验 syso 真的生成了；没有就终止（绝不静默降级） */
function assertWinresSyso() {
  if (!existsSync(WINRES_SYSO)) {
    failWinres(`go-winres 已执行，但没有生成 ${WINRES_SYSO}`)
  }
  const kb = (statSync(WINRES_SYSO).size / 1024).toFixed(1)
  console.log(`[desktop] ✅ cmd/cfpilot/rsrc_windows_amd64.syso (${kb} KB，exe 将带图标与版本属性)`)
}

/**
 * Windows 资源生成彻底失败：**必须终止构建**。
 *
 * 为什么不能再像旧版那样只 warn 一句继续：
 * 那样编出来的 exe 没有图标、没有版本属性，而 CI 会把它当成正式产物发布 ——
 * 用户下载后才发现「仓库里的 exe 没图标」。宁可在发版前失败。
 */
function failWinres(reason) {
  console.error('')
  console.error('[desktop] ❌ 无法生成 Windows 资源（exe 图标 + 版本属性）')
  console.error(`[desktop]   原因：${reason}`)
  console.error('[desktop]   继续编译只会产出一个没有图标、没有版本属性的 exe，')
  console.error('[desktop]   而这个 exe 就是 CI 发布给用户的产物 —— 不再静默降级。')
  console.error(`[desktop]   修复：go install ${WINRES_MODULE}`)
  console.error('')
  process.exit(1)
}

/** 本机是否有可用的 go 命令（回退方案依赖它） */
function hasGo() {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 查找本机已安装的 go-winres 可执行文件。
 *
 * 依次找：GOPATH/bin → PATH。
 * 找不到返回 null，由调用方决定回退（go run）还是失败。
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
