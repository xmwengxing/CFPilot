// 把 darwin 产物打成 macOS 应用包（.app）与磁盘映像（.dmg）。
//
// 输入：packages/desktop/dist 里的 cfpilot-<版本>-darwin-{amd64,arm64}
// 输出：
//   packages/desktop/dist/CFPilot.app                     应用包（未压缩，调试用）
//   packages/desktop/dist/cfpilot-<版本>-macos-<架构>.dmg   分发包
//
// 两种架构都在时用 lipo 合成 universal，产物名里架构写 universal ——
// 用户不该为「我的 Mac 是 Intel 还是 Apple Silicon」做选择题。
//
// ⚠️ 只能在 macOS 上跑：iconutil / codesign / hdiutil / lipo 都是系统工具。
//    构建脚本已按宿主平台守卫，Windows / Linux 上不会走到这里。
//
// ⚠️ 签名策略：默认 ad-hoc（codesign -s -）。
//    ad-hoc 能让本机跑起来，但**过不了 Gatekeeper 首次校验**，也无法公证。
//    用户侧放行方式（macOS 15 起已取消右键→打开）：先双击一次让它被拦，
//    再去「系统设置 → 隐私与安全性」点「仍要打开」，管理员验证后即可正常使用。
//    要正式分发（无提示）得先有 Developer ID 证书，再设
//    CFPILOT_MAC_SIGN_IDENTITY，脚本会带 --options runtime --timestamp 签名；
//    公证（notarytool）需要 App Store Connect 凭据，不在本脚本范围内。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const desktopDir = join(repoRoot, 'packages', 'desktop')
const dist = join(desktopDir, 'dist')
const iconSource = join(desktopDir, 'build', 'AppIcon.iconset')

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const version = pkg.version

// bundle id 与安卓 applicationId 同源（com.xmwengxing.cfpilot）。
// 它同时决定 WKWebView 的网站数据目录 ~/Library/WebKit/<bundle id>，
// **改了它等于让所有用户的 Cookie 全部失效**，不要随手改。
const bundleID = 'com.xmwengxing.cfpilot'
const appName = 'CFPilot'

const identity = (process.env.CFPILOT_MAC_SIGN_IDENTITY || '').trim()
const skipDmg = process.argv.includes('--no-dmg')

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

if (process.platform !== 'darwin') {
  console.error('[macos] 只能在 macOS 上打包（需要 iconutil / codesign / hdiutil / lipo）')
  process.exit(1)
}

/** 找出本次构建出的 darwin 二进制，架构 → 路径。 */
function findBinaries() {
  // build-desktop.mjs 会告诉我本次到底编了哪几种架构。
  // 不能只看文件存不存在：dist 里可能残留上一次构建的另一种架构，
  // 那会把 --only darwin/amd64 误判成「两种都有」而打出 universal 包。
  const wanted = (process.env.CFPILOT_MAC_ARCHS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const arches = wanted.length ? wanted : ['amd64', 'arm64']

  const found = new Map()
  for (const arch of arches) {
    const path = join(dist, `cfpilot-${version}-darwin-${arch}`)
    if (existsSync(path)) found.set(arch, path)
  }
  return found
}

const binaries = findBinaries()
if (binaries.size === 0) {
  console.error(`[macos] 没找到 darwin 产物（期望 ${dist}/cfpilot-${version}-darwin-<arch>）`)
  console.error('[macos] 先跑：node scripts/build-desktop.mjs --only darwin')
  process.exit(1)
}

// ---- 1. 应用包骨架 ----
const stage = join(dist, '.macos-stage')
rmSync(stage, { recursive: true, force: true })

const appDir = join(dist, `${appName}.app`)
rmSync(appDir, { recursive: true, force: true })
const contents = join(appDir, 'Contents')
const macosDir = join(contents, 'MacOS')
const resourcesDir = join(contents, 'Resources')
mkdirSync(macosDir, { recursive: true })
mkdirSync(resourcesDir, { recursive: true })

// ---- 2. 可执行文件（多架构时合体）----
const execPath = join(macosDir, appName)
if (binaries.size > 1) {
  // lipo 的结果必须重新签名（合成后原签名必然失效），后面统一签一次。
  run('lipo', ['-create', '-output', execPath, ...['amd64', 'arm64'].map((a) => binaries.get(a))])
} else {
  copyFileSync([...binaries.values()][0], execPath)
}
run('chmod', ['755', execPath])
const archs = capture('lipo', ['-archs', execPath])
const archLabel = binaries.size > 1 ? 'universal' : [...binaries.keys()][0]
console.log(`[macos] 可执行文件：${archLabel}（${archs}）`)

// ---- 3. 图标 ----
// iconset 由 scripts/gen-desktop-icons.mjs 生成；缺了不致命，
// 只是 Finder 里显示成空白文档图标，因此降级为警告。
if (existsSync(iconSource)) {
  const icns = join(resourcesDir, 'AppIcon.icns')
  run('iconutil', ['-c', 'icns', iconSource, '-o', icns])
  console.log(`[macos] 图标：AppIcon.icns（${(statSync(icns).size / 1024).toFixed(0)} KB）`)
} else {
  console.warn(`[macos] 未找到 ${iconSource}，跳过图标（先跑一次 build-desktop.mjs 生成）`)
}

// ---- 4. Info.plist ----
//
// NSAllowsLocalNetworking：面板是 http://127.0.0.1 的明文回环地址。
// 没有这条，带 Info.plist 的正式 .app 里 WKWebView 会被 ATS 拦下来 ——
// 裸二进制跑不出这个问题（没有 bundle 就没有 ATS 约束），
// 只在打包后才复现，所以写在这里而不是代码里。
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${appName}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version.replace(/-.*$/, '')}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright © CFPilot Contributors</string>
</dict>
</plist>
`
writeFileSync(join(contents, 'Info.plist'), plist)

// ---- 5. 签名 ----
//
// 顺序不能反：先有 Info.plist 与可执行文件，签名才算数；
// 签名之后再改 bundle 里任何文件都会让签名失效。
if (identity) {
  console.log(`[macos] 使用 Developer ID 签名：${identity}`)
  run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, appDir])
} else {
  console.log('[macos] 未配置 CFPILOT_MAC_SIGN_IDENTITY，使用 ad-hoc 签名')
  run('codesign', ['--force', '--sign', '-', appDir])
}
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir])

// ---- 6. dmg ----
let dmgPath = ''
if (skipDmg) {
  console.log('[macos] --no-dmg：跳过磁盘映像')
} else {
  const dmgRoot = join(stage, 'dmg')
  mkdirSync(dmgRoot, { recursive: true })
  // ditto 保留权限、扩展属性与符号链接（cp -R 在旧版本上会丢 xattr）
  run('ditto', [appDir, join(dmgRoot, `${appName}.app`)])
  // 拖拽安装的惯例：/Applications 快捷方式。目标不存在时 hdiutil 仍能打包，
  // 但用户拖进去会发现拖不动，所以这里必须是真符号链接。
  symlinkSync('/Applications', join(dmgRoot, 'Applications'))

  dmgPath = join(dist, `cfpilot-${version}-macos-${archLabel}.dmg`)
  rmSync(dmgPath, { force: true })
  // 旧架构的 dmg（上一轮留下的 macos-amd64，或上轮的 universal）名字不同，
  // 不会阻碍本次生成，但发版时容易上传错包 —— 同版本只留一个 dmg。
  for (const name of readdirSync(dist)) {
    if (name.startsWith(`cfpilot-${version}-macos-`) && name.endsWith('.dmg') && join(dist, name) !== dmgPath) {
      rmSync(join(dist, name), { force: true })
      console.log(`[macos] 清理旧的 dmg：${name}`)
    }
  }
  run('hdiutil', ['create', '-volname', appName, '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmgPath])
  run('hdiutil', ['verify', dmgPath])

  // 挂载回读一遍：确认 dmg 里真的躺着可启动的 .app 与 Applications 链接。
  // 这一步比 verify 更有意义 —— verify 只校验镜像校验和，
  // 挂不上、或挂上后结构不对，用户装了才知道。
  const mountPoint = join(tmpdir(), `cfpilot-dmg-${process.pid}`)
  mkdirSync(mountPoint, { recursive: true })
  try {
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath])
    const mountedExec = join(mountPoint, `${appName}.app`, 'Contents', 'MacOS', appName)
    if (!existsSync(mountedExec)) {
      throw new Error(`dmg 里没有可执行文件：${mountedExec}`)
    }
    if (!existsSync(join(mountPoint, 'Applications'))) {
      throw new Error('dmg 里缺少 /Applications 链接')
    }
    run('codesign', ['--verify', '--strict', join(mountPoint, `${appName}.app`)])
    console.log('[macos] dmg 挂载校验通过（可执行文件 + Applications 链接 + 签名）')
  } finally {
    try {
      run('hdiutil', ['detach', mountPoint])
    } catch {
      // 卸载失败不影响产物本身，下一次 hdiutil create 会用 -ov 覆盖
    }
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

rmSync(stage, { recursive: true, force: true })

// ---- 7. 汇总 ----
const appMB = (Number(capture('du', ['-sk', appDir]).split(/\s+/)[0]) / 1024).toFixed(1)
console.log(`[macos] ✅ ${appName}.app (${appMB} MB，${archs})`)
if (dmgPath) {
  const dmgMB = (statSync(dmgPath).size / 1024 / 1024).toFixed(1)
  console.log(`[macos] ✅ ${dmgPath.split('/').pop()} (${dmgMB} MB)`)
}
if (!identity) {
  console.log('[macos] 提示：ad-hoc 签名未经 Apple 公证，到别的机器上首次打开会被拦。')
  console.log('[macos]       放行方式：双击一次 → 系统设置 → 隐私与安全性 → 「仍要打开」（需管理员验证）')
  console.log('[macos]       或命令行：xattr -dr com.apple.quarantine /Applications/CFPilot.app')
}

// 裸二进制保留：macOS 的自动更新已经改成拉 dmg 换整个 .app，
// 不再依赖裸二进制；留在 dist 里只是给它调试 / 手动部署用（比如从终端跑）。
// 更新器不会选它（见 internal/update 的 pickAssetFor：darwin 只认 dmg）。
const keep = readdirSync(dist).filter((n) => /^cfpilot-.*-darwin-(amd64|arm64)$/.test(n))
if (keep.length) console.log(`[macos] 保留裸二进制（调试 / 手动用，更新不依赖）：${keep.join(', ')}`)
