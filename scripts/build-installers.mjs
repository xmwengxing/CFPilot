// 生成 +mesh 版安装包（Windows NSIS setup.exe / Linux deb）。
//
// 输入：build-desktop.mjs --mesh 写入的隐藏暂存目录。
// 输出（同样落进 dist，随 Release 自动上传）：
//   cfpilot-<ver>+mesh-windows-amd64-setup.exe   NSIS 安装包
//   cfpilot-<ver>+mesh-linux-amd64.deb           dpkg 包
//
// Windows 需要 NSIS，Linux 需要 dpkg-deb；缺少对应工具时构建失败。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const dist = join(repoRoot, 'packages', 'desktop', 'dist')
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const stage = join(dist, '.installer-stage')
if (!process.env.CFPILOT_MESH_BUILD_DIR) {
  throw new Error('[installers] 请通过 node scripts/build-desktop.mjs --mesh 构建 Mesh 安装包')
}
const meshBuildDir = process.env.CFPILOT_MESH_BUILD_DIR
const requestedTargets = (process.env.CFPILOT_MESH_BUILD_TARGETS || 'windows,linux-amd64,linux-arm64')
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean)

function has(cmd, args = ['--version']) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true } catch { return false }
}

function hasDpkgDeb() {
  if (process.env.CFPILOT_DPKG_DEB_WSL === '1') {
    try {
      execFileSync('wsl.exe', ['--', 'dpkg-deb', '--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  return has('dpkg-deb')
}

function buildDeb(debRoot, debOut) {
  if (process.env.CFPILOT_DPKG_DEB_WSL !== '1') {
    execFileSync('dpkg-deb', ['--root-owner-group', '--build', debRoot, debOut], { stdio: 'inherit' })
    return
  }

  const toWslPath = (path) => execFileSync('wsl.exe', ['--', 'wslpath', '-a', path.replaceAll('\\', '/')], { encoding: 'utf8' }).trim()
  const linuxRoot = toWslPath(debRoot)
  const linuxOut = toWslPath(debOut)
  const runWsl = (command, args) => execFileSync('wsl.exe', ['--', command, ...args], { stdio: 'inherit' })
  const linuxTemp = execFileSync('wsl.exe', ['--', 'mktemp', '-d'], { encoding: 'utf8' }).trim()
  try {
    runWsl('mkdir', ['-p', `${linuxTemp}/root`])
    runWsl('cp', ['-a', `${linuxRoot}/.`, `${linuxTemp}/root/`])
    runWsl('find', [`${linuxTemp}/root`, '-type', 'd', '-exec', 'chmod', '755', '{}', '+'])
    runWsl('find', [`${linuxTemp}/root`, '-type', 'f', '-exec', 'chmod', '644', '{}', '+'])
    runWsl('chmod', [
      '755',
      `${linuxTemp}/root/DEBIAN/postinst`,
      `${linuxTemp}/root/DEBIAN/prerm`,
      `${linuxTemp}/root/usr/bin/cfpilot-mesh`,
      `${linuxTemp}/root/usr/bin/cfpilot-meshd`,
    ])
    runWsl('dpkg-deb', ['--root-owner-group', '--build', `${linuxTemp}/root`, `${linuxTemp}/package.deb`])
    runWsl('cp', [`${linuxTemp}/package.deb`, linuxOut])
  } finally {
    try { runWsl('rm', ['-rf', linuxTemp]) } catch {}
  }
}

/** 找 makensis：PATH → 常见安装路径（Windows）。找不到返回 null。 */
function findMakensis() {
  // NSIS 3.x 的版本参数是 -VERSION（单横线大写），不是 --version；
  // Linux 下传 --version 返回非零退出码，会误判未找到 makensis。
  if (has('makensis', ['-VERSION']) || has('makensis', ['/VERSION'])) return 'makensis'
  for (const p of [
    '/usr/bin/makensis',
    'C:/Program Files (x86)/NSIS/makensis.exe',
    'C:/Program Files/NSIS/makensis.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return null
}

/** 编译当前安装包需要的提权守护进程 meshd。 */
function ensureMeshd(name, goarch = 'amd64') {
  const out = join(meshBuildDir, name)
  // ⚠️ 每次构建安装包都**重新编译**，不复用 dist 里的旧 meshd：
  // 服务不随安装包更新（旧版 --install 发现服务已存在就返回），
  // 复用旧产物会造成「装了新包、跑的还是旧代码」且极难察觉。
  const isWin = name.endsWith('.exe')
  const env = { ...process.env, CGO_ENABLED: '0', GOOS: isWin ? 'windows' : 'linux', GOARCH: goarch }
  console.log(`[installers] 编译 meshd (${env.GOOS}/${env.GOARCH}) → ${name} …`)
  execFileSync('go', ['build', '-trimpath', '-tags=mesh', '-ldflags=-s -w -X main.version=' + version, '-o', out, './cmd/cfpilot-meshd'],
    { cwd: join(repoRoot, 'packages', 'desktop'), stdio: 'inherit', env })
}

// ---------- Windows 安装包（NSIS 安装器 exe，双击即装）----------
const winExeName = `cfpilot-${version}+mesh-windows-amd64.exe`
const winExe = join(meshBuildDir, winExeName)
const makensis = findMakensis()
if (requestedTargets.includes('windows') && existsSync(winExe) && makensis) {
  try {
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    copyFileSync(winExe, join(stage, winExeName))
    const meshdName = 'cfpilot-meshd.exe'
    const meshdSrc = join(meshBuildDir, meshdName)
    ensureMeshd(meshdName)
    if (!existsSync(meshdSrc)) {
      throw new Error('缺少 cfpilot-meshd.exe')
    }
    copyFileSync(meshdSrc, join(stage, meshdName))
    const tpl = readFileSync(join(here, 'install-mesh.nsi.template'), 'utf8')
    const setupName = `cfpilot-${version}+mesh-windows-amd64-setup.exe`
    const setupOut = join(dist, setupName)
    const nsi = tpl
      .replace('APP_VERSION_PLACEHOLDER', version)
      .replace('EXE_NAME_PLACEHOLDER', winExeName)
      .replace('EXE_SOURCE_PLACEHOLDER', join(stage, winExeName))
      .replace('MESHD_SOURCE_PLACEHOLDER', join(stage, meshdName))
      .replace('MESHD_NAME_PLACEHOLDER', meshdName)
      .replace('SETUP_OUT_PLACEHOLDER', setupOut)
    const langSrc = join(here, 'nsis-lang')
    const langDst = join(stage, 'nsis-lang')
    if (existsSync(langSrc)) {
      mkdirSync(langDst, { recursive: true })
      for (const f of ['SimpChinese.nlf', 'SimpChinese.nsh']) {
        copyFileSync(join(langSrc, f), join(langDst, f))
      }
    }
    const nsiPath = join(stage, 'install.nsi')
    writeFileSync(nsiPath, '\uFEFF' + nsi, 'utf8')
    execFileSync(makensis, [nsiPath], { cwd: stage, stdio: 'inherit' })
    console.log(`[installers] ✅ ${setupName} (${(statSync(setupOut).size/1024/1024).toFixed(2)} MB)`)
    rmSync(winExe, { force: true })
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
} else if (!existsSync(winExe)) {
  if (requestedTargets.includes('windows')) {
    throw new Error(`[installers] 未找到 ${winExeName}（${meshBuildDir}），需先构建 Windows +mesh 程序`)
  }
} else if (requestedTargets.includes('windows')) {
  throw new Error('[installers] Windows +mesh 必须生成 NSIS 安装包；未找到 makensis')
}

// ---------- Linux deb（支持 amd64 与 arm64）----------
// dpkg 版本号对预发布后缀用 ~（0.60.0~beta.1 < 0.60.0），保证后续升级正式版顺畅。
const debVersion = version.replace("-", "~")
const { chmodSync } = await import("node:fs")

for (const arch of ["amd64", "arm64"]) {
  const targetKey = `linux-${arch}`
  if (!requestedTargets.includes(targetKey)) continue
  const linBin = join(meshBuildDir, `cfpilot-${version}+mesh-linux-${arch}`)
  if (!existsSync(linBin)) {
    throw new Error(`[installers] 未找到 Linux +mesh 程序：${linBin}`)
  }
  if (!hasDpkgDeb()) {
    throw new Error("[installers] Linux +mesh 必须生成 .deb；请安装 dpkg-deb，或设置 CFPILOT_DPKG_DEB_WSL=1")
  }
  rmSync(stage, { recursive: true, force: true })
  const debRoot = join(stage, `cfpilot-mesh-${arch}`)
  mkdirSync(join(debRoot, "DEBIAN"), { recursive: true })
  mkdirSync(join(debRoot, "usr", "bin"), { recursive: true })
  mkdirSync(join(debRoot, "usr", "share", "applications"), { recursive: true })
  copyFileSync(linBin, join(debRoot, "usr", "bin", "cfpilot-mesh"))
  const meshdName = `cfpilot-meshd-linux-${arch}`
  const linMeshd = join(meshBuildDir, meshdName)
  ensureMeshd(meshdName, arch)
  if (!existsSync(linMeshd)) {
    console.error(`[installers] 缺少 ${meshdName}`)
    process.exit(1)
  }
  copyFileSync(linMeshd, join(debRoot, "usr", "bin", "cfpilot-meshd"))
  mkdirSync(join(debRoot, "lib", "systemd", "system"), { recursive: true })
  writeFileSync(join(debRoot, "lib", "systemd", "system", "cfpilot-mesh.service"), [
    "[Unit]",
    "Description=CFPilot Mesh Daemon",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=/usr/bin/cfpilot-meshd",
    "Restart=on-failure",
    "RestartSec=3",
    "NoNewPrivileges=false",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join(String.fromCharCode(10)), "utf8")
  writeFileSync(join(debRoot, "DEBIAN", "postinst"), [
    "#!/bin/sh",
    "set -e",
    "systemctl daemon-reload",
    "systemctl enable cfpilot-mesh.service",
    "systemctl start cfpilot-mesh.service",
    "exit 0",
  ].join(String.fromCharCode(10)), "utf8")
  writeFileSync(join(debRoot, "DEBIAN", "prerm"), [
    "#!/bin/sh",
    "set -e",
    "systemctl stop cfpilot-mesh.service || true",
    "systemctl disable cfpilot-mesh.service || true",
    "exit 0",
  ].join(String.fromCharCode(10)), "utf8")
  writeFileSync(join(debRoot, "DEBIAN", "control"), [
    "Package: cfpilot-mesh",
    `Version: ${debVersion}`,
    "Section: net",
    "Priority: optional",
    `Architecture: ${arch}`,
    "Maintainer: CFPilot <noreply@cfpilot.local>",
    "Description: CFPilot mesh networking node",
    " CFPilot +mesh variant: Cloudflare proxy deployment with site-to-site",
    " mesh networking (Noise IKpsk2, UDP P2P with WSS fallback).",
    " Requires CAP_NET_ADMIN for TUN creation (setcap or run as root).",
    "",
  ].join(String.fromCharCode(10)), "utf8")
  writeFileSync(join(debRoot, "usr", "share", "applications", "cfpilot-mesh.desktop"), [
    "[Desktop Entry]",
    "Type=Application",
    "Name=CFPilot Mesh",
    "Comment=CFPilot mesh networking node",
    "Exec=/usr/bin/cfpilot-mesh",
    "Terminal=false",
    "Categories=Network;",
    "",
  ].join(String.fromCharCode(10)), "utf8")
  chmodSync(join(debRoot, "DEBIAN", "postinst"), 0o755)
  chmodSync(join(debRoot, "DEBIAN", "prerm"), 0o755)
  const debOut = join(dist, `cfpilot-${version}+mesh-linux-${arch}.deb`)
  buildDeb(debRoot, debOut)
  console.log(`[installers] ✅ ${debOut.split(/[\/]/).pop()} (${(statSync(debOut).size/1024/1024).toFixed(2)} MB)`)
}

rmSync(stage, { recursive: true, force: true })
console.log("[installers] 完成")
