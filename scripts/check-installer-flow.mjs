/**
 * 构建流程完整性自检（2026-11-20 立）。
 *
 * 防什么：+mesh 构建流程退化成「只出裸 exe、不出安装包」。
 *
 * 防止 Mesh 裸程序或旧安装包被误当成最新发布产物。
 * 主程序必须只进入暂存目录，安装包构建失败必须令整个构建失败。
 */
import { readFileSync } from 'node:fs'

let bad = 0
const check = (label, ok, desc) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} —— ${desc}`)
  if (!ok) bad++
}

const desktop = readFileSync('scripts/build-desktop.mjs', 'utf8')
const workflow = readFileSync('.github/workflows/release-desktop.yml', 'utf8')
const nsi = readFileSync('scripts/install-mesh.nsi.template', 'utf8')

console.log('=== +mesh 安装包构建流程 ===\n')

check(
  'Mesh 主程序只写入隐藏暂存目录',
  /const buildDir = meshVariant \? meshBuildDir : outDir/.test(desktop) &&
    /const outPath = join\(buildDir, t\.out\)/.test(desktop),
  '+mesh 二进制不能作为单文件程序出现在 dist 根目录'
)
check(
  'Mesh 构建必须自动调用安装器',
  /buildMeshInstallers\(\)/.test(desktop) &&
    /build-installers\.mjs/.test(desktop) &&
    /if \(meshVariant && !assetsOnly\) \{\s*buildMeshInstallers\(\)/.test(desktop),
  '--mesh 不能通过 --no-installer 跳过安装包构建'
)
check(
  '安装器拒绝从 dist 根目录打包裸 Mesh 程序',
  /if \(!process\.env\.CFPILOT_MESH_BUILD_DIR\)/.test(readFileSync('scripts/build-installers.mjs', 'utf8')),
  '只有 build-desktop 提供的隐藏暂存目录可作为 Mesh 安装输入'
)
check(
  '重建前清空旧安装包',
  /function cleanStaleInstallers\(\)/.test(desktop) &&
    /cfpilot-\.\+\\\+mesh-/.test(desktop) &&
    /cleanStaleInstallers\(\)/.test(desktop),
  'dist 里的旧 Mesh 安装包、裸程序和中间守护进程必须先清理'
)
check(
  '安装包产物存在性校验',
  /未生成 \$\{packageName\}/.test(desktop) &&
    /检测到不应分发的 Mesh 单文件程序/.test(desktop) &&
    /Windows \+mesh 必须生成 NSIS 安装包/.test(readFileSync('scripts/build-installers.mjs', 'utf8')) &&
    /Linux \+mesh 必须生成 \.deb/.test(readFileSync('scripts/build-installers.mjs', 'utf8')),
  'Windows 必须产出 setup.exe、Linux 必须产出 .deb，缺少工具或产物时构建失败'
)
check(
  'release 工作流不重复调用 build-installers',
  !/node scripts\/build-installers\.mjs/.test(workflow),
  'build-desktop 已自动构建，工作流里再跑一次会拿到已被吸收的裸 exe'
)
check(
  'NSIS 安装器把 wintun.dll 落到安装目录',
  /--fetch-wintun "\$INSTDIR"/.test(nsi),
  '只有安装过程提权下载 DLL 到 $INSTDIR，wintun.dll 才有正确落点（ADR-0002）'
)
check(
  '桌面构建自动重建 UI',
  /execFileSync\(process\.execPath, \[uiBuildScript\]/.test(desktop) &&
    /packages', 'ui', 'scripts', 'build\.mjs'/.test(desktop),
  '只复制 packages/ui/dist 会把旧 renderer.js 打进新 exe'
)
check(
  '安装器结束所有旧 CFPilot 进程',
  /taskkill \/F \/IM "cfpilot\.exe"/.test(nsi) &&
    /taskkill \/F \/IM "\$\{EXE_NAME\}"/.test(nsi),
  '普通版或旧版本号进程会占住端口并让新 exe 只唤醒旧窗口'
)

console.log(bad === 0 ? '\n全部通过：+mesh 构建流程会自动交付可安装的安装包。' : `\n${bad} 项不一致。`)
process.exit(bad ? 1 : 0)
