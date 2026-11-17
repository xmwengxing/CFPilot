// 生成 +mesh 版安装包（Windows 提权安装 zip / Linux deb）。
//
// 输入：build-desktop.mjs --mesh 的产物 packages/desktop/dist/cfpilot-<ver>+mesh-*
// 输出（同样落进 dist，随 Release 自动上传）：
//   cfpilot-<ver>+mesh-windows-amd64-setup.zip   含 exe + install-mesh.ps1
//   cfpilot-<ver>+mesh-linux-amd64.deb           dpkg 包
//
// 不引入 NSIS/Inno 等外部依赖 —— Windows 用 PowerShell 安装脚本（用户双击），
// Linux 用系统自带 dpkg-deb（CI runner 预装）。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const dist = join(repoRoot, 'packages', 'desktop', 'dist')
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const stage = join(dist, '.installer-stage')

function has(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

/** 找 makensis：PATH → 常见安装路径（Windows）。找不到返回 null。 */
function findMakensis() {
  if (has('makensis')) return 'makensis'
  for (const p of [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return null
}

// ---------- Windows 安装包（NSIS 安装器 exe，双击即装）----------
const winExeName = `cfpilot-${version}+mesh-windows-amd64.exe`
const winExe = join(dist, winExeName)
const makensis = findMakensis()
if (existsSync(winExe) && makensis) {
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  copyFileSync(winExe, join(stage, winExeName))
  const tpl = readFileSync(join(here, 'install-mesh.nsi.template'), 'utf8')
  const setupName = `cfpilot-${version}+mesh-windows-amd64-setup.exe`
  const setupOut = join(dist, setupName)
  const nsi = tpl
    .replace('APP_VERSION_PLACEHOLDER', version)
    .replace('EXE_NAME_PLACEHOLDER', winExeName)
    .replace('EXE_SOURCE_PLACEHOLDER', join(stage, winExeName))
    .replace('SETUP_OUT_PLACEHOLDER', setupOut)
  // 内置中文语言文件复制到 stage（模板用 !addincludedir 引用，
  // 避免依赖系统 NSIS 是否带 Contrib/Language files —— CI/本机行为一致）
  const langSrc = join(here, 'nsis-lang')
  const langDst = join(stage, 'nsis-lang')
  if (existsSync(langSrc)) {
    mkdirSync(langDst, { recursive: true })
    for (const f of ['SimpChinese.nlf', 'SimpChinese.nsh']) {
      copyFileSync(join(langSrc, f), join(langDst, f))
    }
  }
  const nsiPath = join(stage, 'install.nsi')
  // NSIS 按 ACP 读脚本；含中文的 Unicode 脚本必须带 UTF-8 BOM，
  // 否则报 "Bad text encoding"（真机踩到）。
  writeFileSync(nsiPath, '\uFEFF' + nsi, 'utf8')
  execFileSync(makensis, [nsiPath], { cwd: stage, stdio: 'inherit' })
  console.log(`[installers] ✅ ${setupName} (${(statSync(setupOut).size/1024/1024).toFixed(2)} MB)`)
  // 裸 exe 仅作中间产物：安装包已内嵌它，发版时不单独上传（避免用户下错）
  rmSync(winExe, { force: true })
} else if (!existsSync(winExe)) {
  console.log(`[installers] 跳过 Windows（未找到 ${winExeName}，需先 --mesh 构建）`)
} else {
  console.log('[installers] 跳过 Windows 安装器（未找到 makensis；CI 需在 Windows runner 或有 NSIS 的环境）')
}

// ---------- Linux deb ----------
const linBin = join(dist, `cfpilot-${version}+mesh-linux-amd64`)
if (existsSync(linBin) && has('dpkg-deb')) {
  rmSync(stage, { recursive: true, force: true })
  const debRoot = join(stage, 'cfpilot-mesh')
  mkdirSync(join(debRoot, 'DEBIAN'), { recursive: true })
  mkdirSync(join(debRoot, 'usr', 'bin'), { recursive: true })
  mkdirSync(join(debRoot, 'usr', 'share', 'applications'), { recursive: true })
  copyFileSync(linBin, join(debRoot, 'usr', 'bin', 'cfpilot-mesh'))
  writeFileSync(join(debRoot, 'DEBIAN', 'control'), [
    'Package: cfpilot-mesh',
    `Version: ${version}`,
    'Section: net',
    'Priority: optional',
    'Architecture: amd64',
    'Maintainer: CFPilot <noreply@cfpilot.local>',
    'Description: CFPilot mesh networking node',
    ' CFPilot +mesh variant: Cloudflare proxy deployment with site-to-site',
    ' mesh networking (Noise IKpsk2, UDP P2P with WSS fallback).',
    ' Requires CAP_NET_ADMIN for TUN creation (setcap or run as root).',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(debRoot, 'usr', 'share', 'applications', 'cfpilot-mesh.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=CFPilot Mesh',
    'Comment=CFPilot mesh networking node',
    'Exec=/usr/bin/cfpilot-mesh',
    'Terminal=false',
    'Categories=Network;',
    '',
  ].join('\n'), 'utf8')
  const debOut = join(dist, `cfpilot-${version}+mesh-linux-amd64.deb`)
  execFileSync('dpkg-deb', ['--build', debRoot, debOut], { stdio: 'inherit' })
  console.log(`[installers] ✅ ${debOut.split(/[\\/]/).pop()} (${(statSync(debOut).size/1024/1024).toFixed(2)} MB)`)
} else {
  console.log('[installers] 跳过 Linux deb（缺二进制或 dpkg-deb，CI runner 上会生成）')
}

rmSync(stage, { recursive: true, force: true })
console.log('[installers] 完成')
