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
// ---- Windows 安全软件误报的两道防线 ----
//
// 面板窗口用的第三方库把 WebView2Loader.dll 内嵌进 exe 并从内存加载，
// 行为特征与「DLL 反射加载」一致（会产生 MEM_PRIVATE 的可执行页）。
// 修法只有一条：让 DLL 在 exe 同目录，库就会先 LoadLibrary 磁盘文件。
// 因此必须同时保证「安装器带上它」与「构建产出便携包」。
check(
  'NSIS 安装器把 WebView2Loader.dll 落到安装目录',
  /File "WEBVIEW2LOADER_SOURCE_PLACEHOLDER"/.test(nsi) &&
    /Delete "\$INSTDIR\\WebView2Loader\.dll"/.test(nsi),
  '安装目录没有这个 DLL，面板窗口就会退回内存加载（安全软件报反射加载）'
)
check(
  '构建脚本产出便携包与官方 Loader 资产',
  /cfpilot-webview2loader-windows-\$\{t\.goarch\}\.dll/.test(desktop) &&
    /\+loader\.zip/.test(desktop),
  '新用户下载便携包（exe + WebView2Loader.dll）即可避开内存加载'
)
check(
  '安装器构建会随包复制 WebView2Loader.dll',
  /WEBVIEW2LOADER_SOURCE_PLACEHOLDER'/.test(
    readFileSync('scripts/build-installers.mjs', 'utf8')
  ),
  '模板占位符必须被真正替换，否则 nsisc 会因文件缺失而失败'
)

// ---- 代码签名与摘要清单的顺序 ----
//
// 签名改的是 exe 字节。签在清单之后 → 清单记的是签名前的哈希，
// 应用内更新一律校验失败（用户会看到「文件被改动过」）。
check(
  '代码签名排在生成摘要清单之前',
  workflow.indexOf('Windows 产物代码签名') > 0 &&
    workflow.indexOf('Windows 产物代码签名') < workflow.indexOf('生成桌面版摘要清单'),
  '签名必须在清单之前；便携包 zip 由签名脚本重打，顺序错了 zip 里就是未签名 exe'
)
check(
  '签名证书只经 secrets 传入',
  /CFPILOT_WIN_CERT_PFX_BASE64: \$\{\{ secrets\.WINDOWS_CERT_PFX_BASE64 \}\}/.test(workflow),
  'PFX 不能落仓库、不能进日志'
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
