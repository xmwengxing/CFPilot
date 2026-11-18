// 构建 CFPilot +mesh Android 版（APK）。
//
// 前提：
//   - Go + gomobile（Go 1.24+ 需 tool 依赖，见下方说明）
//   - Android SDK（ANDROID_HOME / ANDROID_SDK_ROOT，需 platform 34 / build-tools 34 / NDK 27）
//   - JDK 17（JAVA_HOME）
//   - Gradle wrapper（工程自带，gradlew / gradlew.bat）
//
// 2026-11-18 本机实测要点（已成功产出签名 APK 60MB）：
//   - gomobile bind 必须加 -androidapi=26（否则 gomobile 默认 API 16 报 "unsupported API version 16"）
//   - Windows 中文 locale 下 javac 按 GBK 读生成的 Mobile.java 会报「GBK 不可映射字符」，
//     需设 JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8
//   - Go 1.27 要求 gomobile 依赖在当前模块的 tool graph 中：
//     `go get -tool golang.org/x/mobile/cmd/gobind`。注意该命令会升级 go 指令与依赖，
//     **不要**对 desktop/go.mod 执行（会破坏 go 1.24 约束）——
//     用一个独立的临时模块（replace 指向 desktop）跑 bind。
//   - APK 签名用 apksigner（SDK build-tools 里）+ 自建 keystore。
//
// 不内置 SDK/NDK/JDK 下载 —— 那是 CI runner 的职责（setup-android action）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const androidDir = join(repoRoot, 'packages', 'android-mesh')
const libsDir = join(androidDir, 'app', 'libs')

function hasCmd(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true } catch { return false }
}

if (!hasCmd('gomobile')) {
  console.error('[android] 缺少 gomobile。见本文件顶部说明（Go 1.27 需 tool 依赖）。')
  process.exit(1)
}
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  console.error('[android] 未设置 ANDROID_HOME / ANDROID_SDK_ROOT')
  process.exit(1)
}

mkdirSync(libsDir, { recursive: true })
const aar = join(libsDir, 'mobile.aar')
console.log('[android] gomobile bind → mobile.aar …')
// 注意：Go 1.27 下必须在含 x/mobile tool 依赖的模块里运行（独立临时模块，
// 不要污染 desktop/go.mod）。此处假定调用方已切到该模块或 GOFLAGS 已配置。
execFileSync('gomobile', [
  'bind', '-target=android', '-androidapi=26', '-tags=mesh', '-o', aar,
  'github.com/xmwengxing/cfpilot/packages/desktop/mobile',
], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8' },
})
console.log('[android] ✅ AAR 已生成')

const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
if (!existsSync(gradlew)) {
  console.error('[android] 未找到 gradlew wrapper')
  process.exit(1)
}
console.log('[android] Gradle assembleRelease …')
execFileSync(gradlew, ['assembleRelease', '--no-daemon'], {
  cwd: androidDir,
  stdio: 'inherit',
  env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8' },
})
console.log('[android] ✅ APK 已生成：packages/android-mesh/app/build/outputs/apk/release/')
console.log('[android] 提示：release APK 未签名，需 apksigner 签名后才能安装（见顶部说明）。')
