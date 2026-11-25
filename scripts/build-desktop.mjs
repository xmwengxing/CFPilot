// 构建 CFPilot 桌面版（Go 单二进制）。
//
// 产物：
//   普通版：packages/desktop/dist/cfpilot-<version>-<platform>
//   macOS 额外产物：dist/CFPilot.app 与 dist/cfpilot-<version>-macos-<arch>.dmg
//   +mesh：packages/desktop/dist/cfpilot-<version>+mesh-<platform>-setup.exe / .deb
//
// ## +mesh 变体的安装包（2026-11-20 起自动构建）
//
// +mesh 必须交付**现代化安装包**（Windows NSIS setup.exe / Linux deb），
// 因为只有安装过程才会以管理员权限把 wintun.dll 下载到安装目录
// （ADR-0002：DLL 不随包捆绑，安装时从官方源下载 + 双重 SHA256 校验）。
// 只发裸 exe 时 wintun.dll 无处落地，用户启动组网必然失败。
//
// --mesh 的主程序只写入 dist/.mesh-build/，再自动交给安装器打包；
// dist 最终只保留 setup.exe / .deb，不暴露可误发的裸 Mesh 程序。
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const uiSrc = join(repoRoot, 'packages', 'ui', 'src')
const uiBuildScript = join(repoRoot, 'packages', 'ui', 'scripts', 'build.mjs')
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

// ---- 1. 重建并同步界面资源 ----
// build-desktop 必须自己保证 packages/ui/dist 是最新的：之前只复制 dist，
// 改了 renderer.ts 却忘记跑 npm run build -w @cfpilot/ui 时，会把旧 JS 打进
// 新 exe（真机表现为「装了新包、UI 完全没变化」）。这里无条件重建一次，
// 代价只有几秒，换来的是产物与源码一一对应。
execFileSync(process.execPath, [uiBuildScript], { cwd: join(repoRoot, 'packages', 'ui'), stdio: 'inherit' })
if (!existsSync(join(uiSrc, 'index.html'))) {
  console.error('[desktop] 未找到 packages/ui/src/index.html')
  process.exit(1)
}
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

// 内核版本清单（内核热更新通道的内置序号锚点，go:embed 进 exe）。
// 与 CLI 共用同一份（packages/cli/assets/cfpilot-kernel-VERSION，由 sync-asset 生成）：
// 序号取构建时间，包发布时间 ≥ 任何已有内核发布 → 内置序号不会误判落后。
const kernelVersionSrc = join(repoRoot, 'packages', 'cli', 'assets', 'cfpilot-kernel-VERSION')
if (existsSync(kernelVersionSrc)) {
  copyFileSync(kernelVersionSrc, join(kernelDstDir, 'cfpilot-kernel-VERSION'))
  console.log('[desktop] 内核版本清单 cfpilot-kernel-VERSION → internal/kernel/assets/')
} else {
  console.warn('[desktop] 未找到 cfpilot-kernel-VERSION（先跑 npm run build -w cfpilot）；通道将视内置序号为 0')
}

// ---- 1b-edge. 同步盲中继 / 云监测台资产（go:embed 打进 exe）----
//
// 权威源码在 packages/edge-relay/，由 scripts/build-edge-relay.mjs 编译到
// packages/cli/assets/edge-relay/。桌面版复用同一份产物，避免两边漂移。
const edgeSrcDir = join(repoRoot, 'packages', 'cli', 'assets', 'edge-relay')
const edgeDstDir = join(desktopDir, 'internal', 'edge', 'assets')
if (existsSync(edgeSrcDir)) {
  mkdirSync(edgeDstDir, { recursive: true })
  for (const f of ['worker.js', 'dashboard.html', 'dashboard-worker.js', 'schema.sql']) {
    const src = join(edgeSrcDir, f)
    if (!existsSync(src)) {
      console.error(`[desktop] 未找到 edge 资产 ${f}，请先运行 node scripts/build-edge-relay.mjs`)
      process.exit(1)
    }
    copyFileSync(src, join(edgeDstDir, f))
  }
  console.log('[desktop] edge-relay 资产 → internal/edge/assets/')
} else {
  console.warn('[desktop] 未找到 edge-relay 资产（先跑 npm run build -w cfpilot），盲中继部署将不可用')
}

// ---- 1c. 同步内置反代候选清单（go:embed 打进 exe）----
//
// 与 CLI 共用**同一份文件**（packages/cli/assets/relay-ip-builtin.txt）：
// 两边各维护一份必然漂移，而这份清单是「手上没有 IP 源时也能开跑」的兜底，
// 漂移了用户就会拿到过期数据却毫无提示。
const builtinRelaySrc = join(repoRoot, 'packages', 'cli', 'assets', 'relay-ip-builtin.txt')
const builtinRelayDstDir = join(desktopDir, 'internal', 'relay', 'assets')
if (existsSync(builtinRelaySrc)) {
  mkdirSync(builtinRelayDstDir, { recursive: true })
  copyFileSync(builtinRelaySrc, join(builtinRelayDstDir, 'relay-ip-builtin.txt'))
  const n = readFileSync(builtinRelaySrc, 'utf8').split('\n').filter((l) => l.trim()).length
  console.log(`[desktop] 内置反代候选 → internal/relay/assets/ (${n} 条)`)
} else {
  console.error('[desktop] 未找到 packages/cli/assets/relay-ip-builtin.txt')
  process.exit(1)
}

// 构建目标（图标生成阶段就要知道是否编 Windows，所以定义在最前面）
//
// --mesh：构建 +mesh 变体（内嵌 MobiHop 组网模块）。
//   - 产物名加 `+mesh` 后缀，与普通版同批发布（同一 tag 多 asset，不增版本号通道）
//   - go build 加 `-tags=mesh`，启用 internal/mesh 的真实入口（Phase 3b 填充协议）
//   - Mesh 主程序只进入隐藏暂存目录，最终 dist 只保留安装包
const meshVariant = process.argv.includes('--mesh')
const meshSuffix = meshVariant ? '+mesh' : ''
//
// Linux 的 `cfp_gui` 标签：启用系统 WebKitGTK 窗口（purego 运行时 dlopen）。
// ⚠️ 带这个标签的产物会因 purego 而链接 glibc（libc / libdl / libpthread），
//    不能放进 Alpine 容器 —— 容器用的静态产物在下面单独编，见 stageDocker。
const allTargets = [
  { goos: 'windows', goarch: 'amd64', out: `cfpilot-${version}${meshSuffix}-windows-amd64.exe`, extra: ['-H=windowsgui'], tags: [] },
  { goos: 'linux', goarch: 'amd64', out: `cfpilot-${version}${meshSuffix}-linux-amd64`, extra: [], tags: ['cfp_gui'] },
  { goos: 'linux', goarch: 'arm64', out: `cfpilot-${version}${meshSuffix}-linux-arm64`, extra: [], tags: ['cfp_gui'] },
  // macOS：cgo 必须开 —— 面板窗口是 WKWebView，托盘是 ObjC（energye/systray）。
  // 因此这两项**只能在 macOS 上编**（Windows / Linux 上没有 AppKit 头文件），
  // 下面的 picked 过滤已经按宿主机平台做了守卫。
  //
  // 暂不产出 .app / .dmg：分发形态还没定（签名与公证要先有 Developer ID），
  // 目前先给裸可执行文件，配合托盘与内嵌窗口已经能直接用。
  { goos: 'darwin', goarch: 'amd64', out: `cfpilot-${version}${meshSuffix}-darwin-amd64`, extra: [], tags: ['cfp_gui'], cgo: true },
  { goos: 'darwin', goarch: 'arm64', out: `cfpilot-${version}${meshSuffix}-darwin-arm64`, extra: [], tags: ['cfp_gui'], cgo: true },
]
const targets = allTargets

// 允许限制构建目标（只编一部分平台时用）。
//
// 两种写法等价，都保留：
//   node scripts/build-desktop.mjs --only windows
//   node scripts/build-desktop.mjs --only windows,linux/amd64
//   CFPILOT_DESKTOP_TARGETS=windows node scripts/build-desktop.mjs   ← 环境变量（旧用法，保留兼容）
//
// 另有 --assets-only：**只做资源准备，不编译任何二进制**。
// 安卓版用得上 —— 它要的是「界面与内核资产已塞进 internal/server/assets/」，
// 编译的是自己的 .so（另一套工具链，见 CI 的 android job）。
// 少编一遍 linux 二进制，省掉几十秒的交叉编译。
const assetsOnly = process.argv.includes('--assets-only')
if (meshVariant && !assetsOnly && process.argv.includes('--no-installer')) {
  console.error('[desktop] --mesh 必须生成安装包，不支持 --no-installer')
  process.exit(1)
}
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
const selected = wanted.length
  ? targets.filter((t) => wanted.includes(`${t.goos}/${t.goarch}`) || wanted.includes(t.goos))
  : targets
if (selected.length === 0) {
  console.error(`[desktop] 构建目标没有匹配到任何平台：${only}`)
  console.error(`[desktop] 可用目标：${targets.map((t) => `${t.goos}/${t.goarch}`).join(', ')}`)
  process.exit(1)
}

// darwin 必须在 macOS 上编（cgo + AppKit 头文件）。
//
// 两种情形分开处理：
//   - 显式 --only darwin：用户以为能编，直接报错并说明原因；
//   - 默认全平台（CI 在 Linux/Windows 上跑）：跳过 darwin，不当成失败。
const darwinTs = selected.filter((t) => t.goos === 'darwin')
if (darwinTs.length && process.platform !== 'darwin') {
  if (wanted.length) {
    console.error('[desktop] macOS 产物只能在 macOS 上编译（面板窗口依赖 WKWebView / AppKit）')
    process.exit(1)
  }
  console.log('[desktop] 跳过 darwin 目标：macOS 产物只能在 macOS 上编译')
}
// +mesh 的安装包只定义了 Windows / Linux 两种形态，不把 darwin 拖进去。
const picked = selected.filter((t) =>
  t.goos !== 'darwin' || (process.platform === 'darwin' && !(meshVariant && !assetsOnly))
)
if (picked.length === 0) {
  console.log('[desktop] 没有任何可在本机构建的目标，退出')
  process.exit(0)
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
// 不递归删除整个 dist：Windows 下正在运行的 exe 会锁住目录，安全删除层
// 也会拦下整目录 trash，导致构建莫名其妙失败。产物文件名带版本号，旧版本
// 留着无害，同名产物由 go build 直接覆盖，因此只需确保目录存在。
mkdirSync(outDir, { recursive: true })
const meshBuildDir = join(outDir, '.mesh-build')
const buildDir = meshVariant ? meshBuildDir : outDir
if (meshVariant) {
  cleanStaleInstallers()
  rmSync(meshBuildDir, { recursive: true, force: true })
  mkdirSync(meshBuildDir, { recursive: true })
}

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

  // Windows PE 版本资源（VS_FIXEDFILEINFO）要求纯四段/三段数字，不能带 -beta.1 后缀；
  // 预发布后缀保留在 main.Version / 文件名里。
  const winVer = (version.match(/^\d+\.\d+\.\d+/) ?? ['0.0.0'])[0]
  const args = [
    'simply',
    '--icon', 'app.ico',
    '--product-name', 'CFPilot',
    '--file-description', 'CFPilot 部署与网络维护' + meshSuffix,
    '--copyright', 'Copyright © CFPilot Contributors',
    '--original-filename', 'cfpilot.exe',
    '--file-version', winVer,
    '--product-version', winVer,
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

if (assetsOnly) {
  console.log('[desktop] --assets-only：资源已就位，跳过二进制编译')
  process.exit(0)
}

for (const t of picked) {
  const outPath = join(buildDir, t.out)
  console.log(`[desktop] 编译 ${t.goos}/${t.goarch} …`)
  const tags = [...(meshVariant ? ['mesh'] : []), ...(t.tags || [])]
  const tagArgs = tags.length ? [`-tags=${tags.join(',')}`] : []
  execFileSync(
    'go',
    ['build', '-trimpath', ...tagArgs, `-ldflags=${ldflags(t.extra)}`, '-o', outPath, './cmd/cfpilot'],
    {
      cwd: desktopDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        // CGO 默认关：开 CGO 就编不过 Linux（systray 已是纯 Go 实现）。
        // 注意：关掉 CGO 不代表必然静态 ——
        // 带 cfp_gui 的 Linux 产物会因 purego 的 cgo_import_dynamic
        // 链接 glibc，所以容器产物另外编（stageDocker）。
        //
        // darwin 是唯一必须开 cgo 的目标：面板窗口是 WKWebView，
        // 托盘是 ObjC，两者都只能通过 cgo 调用。
        CGO_ENABLED: t.cgo ? '1' : '0',
        GOOS: t.goos,
        GOARCH: t.goarch,
      },
    }
  )
  const mb = (statSync(outPath).size / 1024 / 1024).toFixed(2)
  console.log(`[desktop] ✅ ${t.out} (${mb} MB)`)

  // 图形壳产物的校验：不得链接 WebKitGTK / GTK。
  //
  // 窗口是运行时 dlopen 的，一旦链接进来，用户没装 libwebkit 的机器
  // 连「打开浏览器」都跑不起来 —— 这种回归只能看产物才能发现。
  if (t.goos === 'linux') {
    assertNoWebkitLinked(outPath)
  }

  // 容器镜像用的暂存区。
  //
  // 镜像**不在里面编译** —— Go 二进制在这里编好，Dockerfile 只做一次 COPY。
  // 目录按架构分（docker/dist/amd64、docker/dist/arm64），
  // 对应 Dockerfile 里的 `COPY dist/${TARGETARCH}/cfpilot`。
  //
  // ⚠️ 暂存的是**另行编译的静态产物**（不带 cfp_gui）：
  //    图形壳产物的 purego 依赖会链接 glibc，而镜像是 Alpine（musl），
  //    直接拷进去会在 exec 阶段失败。
  if (t.goos === 'linux' && !meshVariant) {
    stageDocker(t)
  }
}

// ---- macOS 应用包（.app + .dmg）----
//
// 只能在 macOS 上生成（iconutil / codesign / lipo / hdiutil 都是系统工具）。
// 两种架构都编出来的话，打包脚本用 lipo 合成 universal，只出一个 dmg ——
// 用户不该为「Intel 还是 Apple Silicon」做选择题。
const darwinBuilt = picked.filter((t) => t.goos === 'darwin')
if (darwinBuilt.length && !process.argv.includes('--no-dmg')) {
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'package-macos.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 告诉打包脚本「本次到底编了哪几种架构」：
      // dist 里可能残留上一次构建的另一种架构，不能按文件存在与否猜，
      // 否则 --only darwin/amd64 会莫名其妙打出一个 universal 包。
      CFPILOT_MAC_ARCHS: darwinBuilt.map((t) => t.goarch).join(','),
    },
  })
}

/* ------------------------------------------------------------------ */
/* +mesh：安装包自动构建 + 陈旧包清理（2026-11-20）                      */
/* ------------------------------------------------------------------ */

/**
 * 清理 dist 里旧的 Mesh 安装包与误留的裸程序。
 *
 * 背景：早前 build-desktop 从不删 dist，旧安装包一直留着。
 * 重新构建后裸 exe 是新的、setup.exe 却是上一版 —— 发版时很容易上传错包；
 * 而装错包就没有正确的 wintun.dll 落地路径（ADR-0002）。
 *
 * 现在每次自动构建安装包前**全删重建**：
 *   - 工具齐全 → 立刻生成同版本的新包；
 *   - 工具缺失（如本机没 dpkg-deb）→ 宁可没有，也绝不留下内容过期的旧包被人误传。
 * 这样「每次都要提醒清理旧包」的问题从流程上根治。
 */
function cleanStaleInstallers() {
  let cleaned = 0
  for (const name of readdirSync(outDir)) {
    const oldMeshProgram = /^cfpilot-.+\+mesh-(windows-amd64\.exe|linux-(amd64|arm64))$/.test(name)
    if (/^cfpilot-.+\+mesh-.*(\.deb|-setup\.exe)$/.test(name) || oldMeshProgram || name === 'cfpilot-meshd.exe' || name === 'cfpilot-meshd') {
      rmSync(join(outDir, name), { force: true })
      console.log(`[desktop] 清理旧 Mesh 构建产物：${name}`)
      cleaned++
    }
  }
  if (cleaned === 0) console.log('[desktop] 无旧安装包需要清理')
}

/**
 * --mesh 主程序仅暂存在隐藏目录，成功打包后删除暂存。
 */
function buildMeshInstallers() {
  console.log('[desktop] 构建 +mesh 安装包（NSIS setup.exe / deb）…')
  try {
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-installers.mjs')], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        CFPILOT_MESH_BUILD_DIR: meshBuildDir,
        CFPILOT_MESH_BUILD_TARGETS: picked.map((target) =>
          target.goos === 'windows' ? 'windows' : `linux-${target.goarch}`
        ).join(','),
        ...(process.platform === 'win32' ? { CFPILOT_DPKG_DEB_WSL: '1' } : {}),
      },
    })
    for (const target of picked) {
      const packageName = target.goos === 'windows'
        ? `cfpilot-${version}+mesh-windows-amd64-setup.exe`
        : `cfpilot-${version}+mesh-linux-${target.goarch}.deb`
      if (!existsSync(join(outDir, packageName))) {
        throw new Error(`未生成 ${packageName}；请确认安装器工具已安装`)
      }
      console.log(`[desktop] ✅ 安装包就绪：${packageName}`)
    }
    for (const target of picked) {
      if (existsSync(join(outDir, target.out))) {
        throw new Error(`检测到不应分发的 Mesh 单文件程序：${target.out}`)
      }
    }
  } finally {
    rmSync(meshBuildDir, { recursive: true, force: true })
  }
}

if (meshVariant && !assetsOnly) {
  buildMeshInstallers()
}

/**
 * 编译容器用的静态 Linux 产物并暂存。
 *
 * 不带任何 GUI 标签：`shell.New` 返回 ErrUnsupported，
 * 启动时按老路径走系统浏览器（容器本来就传 --no-browser）。
 */
function stageDocker(t) {
  const stageDir = join(repoRoot, 'docker', 'dist', t.goarch)
  mkdirSync(stageDir, { recursive: true })
  const outPath = join(stageDir, 'cfpilot')
  execFileSync(
    'go',
    ['build', '-trimpath', `-ldflags=${ldflags([])}`, '-o', outPath, './cmd/cfpilot'],
    {
      cwd: desktopDir,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: t.goos, GOARCH: t.goarch },
    }
  )
  assertFullyStatic(outPath)
  const mb = (statSync(outPath).size / 1024 / 1024).toFixed(2)
  console.log(`[desktop] 📦 容器暂存 → docker/dist/${t.goarch}/cfpilot (${mb} MB，静态)`)
}

/**
 * 读取 ELF 的 DT_NEEDED 列表。
 *
 * 只处理 64 位小端（amd64 / arm64），已足够覆盖本项目的 Linux 产物。
 */
function readElfNeeded(buf) {
  if (buf[0] !== 0x7f || buf.toString('latin1', 1, 4) !== 'ELF') return null
  if (buf[4] !== 2) return null // 非 64 位
  const shoff = Number(buf.readBigUInt64LE(0x28))
  const shent = buf.readUInt16LE(0x3a)
  const shnum = buf.readUInt16LE(0x3c)
  const shstr = buf.readUInt16LE(0x3e)
  if (!shoff || !shnum || shstr >= shnum) return null
  const strOff = Number(buf.readBigUInt64LE(shoff + shstr * shent + 0x18))
  const secName = (i) => {
    const off = strOff + buf.readUInt32LE(shoff + i * shent)
    let end = off
    while (buf[end] !== 0) end++
    return buf.toString('latin1', off, end)
  }
  let dyn = -1
  let dynstr = -1
  for (let i = 0; i < shnum; i++) {
    const name = secName(i)
    if (name === '.dynamic') dyn = i
    if (name === '.dynstr') dynstr = i
  }
  if (dyn < 0 || dynstr < 0) return { dynamic: false, needed: [] }
  const dynOff = Number(buf.readBigUInt64LE(shoff + dyn * shent + 0x18))
  const dynSize = Number(buf.readBigUInt64LE(shoff + dyn * shent + 0x20))
  const strBase = Number(buf.readBigUInt64LE(shoff + dynstr * shent + 0x18))
  const needed = []
  for (let p = dynOff; p < dynOff + dynSize; p += 16) {
    const tag = Number(buf.readBigInt64LE(p))
    if (tag === 0) break
    if (tag !== 1) continue // DT_NEEDED
    const v = Number(buf.readBigUInt64LE(p + 8))
    let end = strBase + v
    const start = end
    while (buf[end] !== 0) end++
    needed.push(buf.toString('latin1', start, end))
  }
  return { dynamic: true, needed }
}

/**
 * 图形壳产物不得链接 WebKitGTK / GTK。
 *
 * purego 的 dlopen 会带上 libc / libdl / libpthread，这是预期内的；
 * 但 libwebkit* 与 libgtk-* 一旦出现在 DT_NEEDED 里，
 * 说明「运行时按需加载」退化成了「启动就必须装」，
 * 没装 WebKit 的用户会直接启动失败。
 */
function assertNoWebkitLinked(path) {
  const info = readElfNeeded(readFileSync(path))
  if (!info) {
    console.warn(`[desktop] ⚠ 无法解析 ELF 依赖：${path}`)
    return
  }
  const bad = info.needed.filter((n) => /^lib(webkit|gtk)/i.test(n))
  if (bad.length) {
    console.error(`[desktop] ❌ ${path} 链接了 ${bad.join(', ')}`)
    console.error('[desktop]    图形壳必须在运行时 dlopen，不能写进 DT_NEEDED')
    process.exit(1)
  }
  console.log(`[desktop] ✅ 图形壳未链接 WebKitGTK（DT_NEEDED: ${info.needed.join(', ') || '无'}）`)
}

/**
 * 容器产物必须是完全静态的（无 .dynamic 段）。
 *
 * 镜像基于 Alpine（musl），任何 glibc 依赖都会让 exec 失败。
 */
function assertFullyStatic(path) {
  const info = readElfNeeded(readFileSync(path))
  if (!info) {
    console.error(`[desktop] ❌ 无法解析 ELF：${path}`)
    process.exit(1)
  }
  if (info.dynamic) {
    console.error(`[desktop] ❌ 容器产物不是静态二进制：${path}`)
    console.error(`[desktop]    DT_NEEDED: ${info.needed.join(', ') || '(空)'}`)
    console.error('[desktop]    Alpine（musl）镜像里跑不起来；请确认未带 cfp_gui 标签')
    process.exit(1)
  }
  console.log('[desktop] ✅ 容器产物为静态二进制')
}

console.log('[desktop] 全部完成')
