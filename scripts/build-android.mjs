// 构建 CFPilot +mesh Android 版（APK），并可选签名。
//
// 工具链解析顺序（**不依赖临时目录**）：
//   1. 环境变量 JAVA_HOME / ANDROID_HOME / ANDROID_NDK_HOME
//   2. 本机约定位置：%USERPROFILE%\tools\android\jdk17、%LOCALAPPDATA%\Android\Sdk
//   3. Gradle：工程 wrapper（若 ~/.gradle 已有发行版缓存）→ PATH 里的 gradle
//
// 用法：
//   . .\scripts\android-env.ps1        # PowerShell 里先设置环境（可选，脚本能自动探测）
//   node scripts/build-android.mjs
//
// 可选签名（不设则只出 unsigned，需手动 apksigner）：
//   CFPILOT_ANDROID_KEYSTORE=<keystore 路径>
//   CFPILOT_ANDROID_KEY_ALIAS=cfpilot
//   CFPILOT_ANDROID_STORE_PASS=<口令>     CFPILOT_ANDROID_KEY_PASS=<口令>
//   签名产物：packages/android-mesh/app/build/outputs/apk/release/cfpilot-<ver>+mesh-android.apk
//
// ## 本机实测过的三个坑（别删）
//
// 1. `gomobile bind` 必须加 `-androidapi=26`（否则默认 API 16 报 unsupported）。
// 2. Windows 中文 locale 下 javac 按 GBK 读 gomobile 生成的 Mobile.java 会报
//    「GBK 不可映射字符」⇒ 必须 `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8`。
// 3. Go 1.27 要求 `golang.org/x/mobile` 在**当前模块**的 tool graph 里，否则报
//    "missing golang.org/x/mobile dependency"。这里用「临时注入 + finally 还原」
//    处理 desktop/go.mod，绝不把它固化进仓库（会破坏 go 1.24 约束）。
//    gomobile 必须在 packages/desktop 目录里跑（从仓库根跑会找不到模块）。
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const desktopDir = join(repoRoot, 'packages', 'desktop')
const androidDir = join(repoRoot, 'packages', 'android-mesh')
const libsDir = join(androidDir, 'app', 'libs')
const apkDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release')
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version

const isWin = process.platform === 'win32'
const log = (m) => console.log(`[android] ${m}`)
const fail = (m) => { console.error(`[android] ${m}`); process.exit(1) }

function hasCmd(cmd) {
  try { execFileSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true } catch { return false }
}

/**
 * 运行外部命令。
 *
 * ⚠️ Node 20+/26 在 Windows 上**不能**直接 spawn `.bat/.cmd`（EINVAL，CVE 修复后
 * 强制走 shell），必须用 cmd.exe 包装。gradlew.bat / gradle.bat / apksigner.bat 都走这里。
 */
function runTool(cmd, args, opts) {
  if (isWin && /\.(bat|cmd)$/i.test(cmd)) {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], opts)
  }
  return execFileSync(cmd, args, opts)
}

function firstChildDir(root, pattern) {
  if (!existsSync(root)) return null
  const re = new RegExp(pattern)
  const hit = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory() && re.test(e.name))
  return hit ? join(root, hit.name) : null
}

// ---- 工具链解析 ----
function resolveJdk() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, isWin ? 'bin/javac.exe' : 'bin/javac'))) return process.env.JAVA_HOME
  const root = process.env.CFPILOT_JAVA_HOME || join(process.env.USERPROFILE || process.env.HOME || '', 'tools', 'android', 'jdk17')
  return firstChildDir(root, '^jdk-')
}

function resolveSdk() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (env && existsSync(env)) return env
  const fallback = join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')
  return existsSync(fallback) ? fallback : null
}

function resolveGradleBin() {
  const home = process.env.CFPILOT_GRADLE_HOME || join(process.env.USERPROFILE || '', 'tools', 'android', 'gradle-8.9')
  const bin = join(home, 'bin', isWin ? 'gradle.bat' : 'gradle')
  return existsSync(bin) ? bin : (hasCmd('gradle') ? 'gradle' : null)
}

const javaHome = resolveJdk()
if (!javaHome) fail('找不到 JDK 17：设置 JAVA_HOME，或放到 %USERPROFILE%\\tools\\android\\jdk17')
const sdk = resolveSdk()
if (!sdk) fail('找不到 Android SDK：设置 ANDROID_HOME')
const ndk = process.env.ANDROID_NDK_HOME || firstChildDir(join(sdk, 'ndk'), '^27\\.')
if (!ndk) fail('找不到 NDK 27（gomobile 需要）')
if (!hasCmd('gomobile')) fail('找不到 gomobile：go install golang.org/x/mobile/cmd/gomobile@latest')

const baseEnv = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ANDROID_NDK_HOME: ndk,
  JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8',
  PATH: `${javaHome}/bin${isWin ? ';' : ':'}${process.env.PATH || ''}`,
  // ⚠️ 必须写进全局 env：gomobile 内部还会再跑 `go mod tidy`，
  // 只给外层 `go get` 设 GOPROXY 的话，它仍会走系统默认 proxy.golang.org
  // （本机 IPv6 到不了，报 dial tcp ... connectex timeout）。
  GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,direct',
}
log(`JAVA_HOME=${javaHome}`)
log(`ANDROID_HOME=${sdk}`)
log(`NDK=${ndk}`)

// ---- 1) gomobile bind（临时注入 tool 依赖，finally 还原）----
mkdirSync(libsDir, { recursive: true })
const aar = join(libsDir, 'mobile.aar')
const goMod = join(desktopDir, 'go.mod')
const goSum = join(desktopDir, 'go.sum')
const modBak = `${goMod}.cfpilot-android-bak`
const sumBak = `${goSum}.cfpilot-android-bak`
copyFileSync(goMod, modBak)
copyFileSync(goSum, sumBak)
const proxy = process.env.GOPROXY || 'https://goproxy.cn,direct'

try {
  log('注入 golang.org/x/mobile tool 依赖（临时，用完还原）…')
  execFileSync('go', ['get', '-tool', 'golang.org/x/mobile/cmd/gobind'], {
    cwd: desktopDir, stdio: 'inherit',
    env: { ...baseEnv, GOPROXY: proxy },
  })
  log('gomobile bind → mobile.aar …')
  execFileSync('gomobile', [
    'bind', '-target=android', '-androidapi=26', '-tags=mesh', '-o', aar,
    'github.com/xmwengxing/cfpilot/packages/desktop/mobile',
  ], { cwd: desktopDir, stdio: 'inherit', env: baseEnv })
  log('✅ AAR 已生成')
} finally {
  copyFileSync(modBak, goMod)
  copyFileSync(sumBak, goSum)
  rmSync(modBak, { force: true })
  rmSync(sumBak, { force: true })
  log('go.mod / go.sum 已还原')
}

// ---- 2) Gradle assembleRelease ----
// 有 wrapper 且发行版已缓存时优先用 wrapper（与 CI 一致）；否则用本机 Gradle。
const gradlew = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew')
// ⚠️ 目录存在 ≠ 发行版已缓存：空目录时 gradlew 会去下载 Gradle（离线环境直接挂）。
// 只认「dists 里真的有内容」。
let wrapperCached = false
try {
  wrapperCached = readdirSync(join(process.env.USERPROFILE || '', '.gradle', 'wrapper', 'dists')).length > 0
} catch { /* 没有缓存目录 */ }
// 本机优先用**本机 Gradle**：wrapper 会在 ~/.gradle 里尝试下载发行版，
// 国内网络下经常卡住/失败，而本机 Gradle 已装好且版本一致。
// CI 上仍用 wrapper（setup-gradle 会预置缓存）。
const useWrapper = process.env.CI === 'true' && existsSync(gradlew) && wrapperCached
const gradleCmd = useWrapper ? gradlew : resolveGradleBin()
if (!gradleCmd) fail('找不到 Gradle：装 Gradle 8.9 或先跑 gradlew 下载一次')
log(`Gradle assembleRelease（${gradleCmd}）…`)
runTool(gradleCmd, ['assembleRelease', '--no-daemon'], {
  cwd: androidDir, stdio: 'inherit', env: baseEnv,
})
log('✅ APK 已生成（unsigned）')

// ---- 3) 可选签名 ----
const ks = process.env.CFPILOT_ANDROID_KEYSTORE
if (ks && existsSync(ks)) {
  // 口令为空时 apksigner 会以一个空口令去解密 PKCS12，报「keystore password was incorrect」——
  // 这是最容易误判成「keystore 坏了」的情况，先在这里拦住。
  if (!process.env.CFPILOT_ANDROID_STORE_PASS) {
    fail('已设置 CFPILOT_ANDROID_KEYSTORE 但缺少 CFPILOT_ANDROID_STORE_PASS')
  }
  const bt = firstChildDir(join(sdk, 'build-tools'), '^34\\.') || firstChildDir(join(sdk, 'build-tools'), '^\\d+\\.')
  if (!bt) fail('找不到 build-tools（apksigner）')
  const apksigner = join(bt, isWin ? 'apksigner.bat' : 'apksigner')
  const unsigned = join(apkDir, 'app-release-unsigned.apk')
  const signed = join(apkDir, `cfpilot-${version}+mesh-android.apk`)
  const args = [
    'sign', '--ks', ks,
    '--ks-pass', `pass:${process.env.CFPILOT_ANDROID_STORE_PASS || ''}`,
    '--key-pass', `pass:${process.env.CFPILOT_ANDROID_KEY_PASS || ''}`,
    '--min-sdk-version', '26', '--out', signed, unsigned,
  ]
  const alias = process.env.CFPILOT_ANDROID_KEY_ALIAS
  if (alias) args.splice(3, 0, '--ks-key-alias', alias)
  log(`签名 → ${signed}`)
  runTool(apksigner, args, { stdio: 'inherit', env: baseEnv })
  runTool(apksigner, ['verify', '--print-certs', signed], { stdio: 'inherit', env: baseEnv })
  log('✅ 已签名并校验')
} else {
  log('未设置 CFPILOT_ANDROID_KEYSTORE，跳过签名（需 apksigner 手动签名后才能安装）')
}


