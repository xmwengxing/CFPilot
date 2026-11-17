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

// ---------- Windows 安装包（zip + install.ps1）----------
const winExe = join(dist, `cfpilot-${version}+mesh-windows-amd64.exe`)
if (existsSync(winExe)) {
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  copyFileSync(winExe, join(stage, `cfpilot-${version}+mesh-windows-amd64.exe`))
  const tpl = readFileSync(join(here, 'install-mesh.ps1.template'), 'utf8')
  writeFileSync(join(stage, 'install-mesh.ps1'),
    tpl.replace('EXE_NAME_PLACEHOLDER', `cfpilot-${version}+mesh-windows-amd64.exe`), 'utf8')
  const zipOut = join(dist, `cfpilot-${version}+mesh-windows-amd64-setup.zip`)
  if (has('zip')) {
    execFileSync('zip', ['-q', '-r', zipOut, '.'], { cwd: stage })
  } else {
    // Windows 本机无 zip 命令时用 PowerShell Compress-Archive
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipOut}' -Force`], { stdio: 'inherit' })
  }
  console.log(`[installers] ✅ ${zipOut.split(/[\\/]/).pop()} (${(statSync(zipOut).size/1024/1024).toFixed(2)} MB)`)
} else {
  console.log(`[installers] 跳过 Windows（未找到 ${winExe.split(/[\\/]/).pop()}，需先 --mesh 构建）`)
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
