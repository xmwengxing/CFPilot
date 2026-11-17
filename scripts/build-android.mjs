// 构建 CFPilot +mesh Android 版（APK）。
//
// 前提（本机需装，CI 用 android runner）：
//   - Go + gomobile：go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init
//   - Android SDK（ANDROID_HOME / ANDROID_SDK_ROOT）+ JDK 17
//   - Gradle（工程自带 gradlew 时可用 wrapper）
//
// 流程：
//   1. gomobile bind -target=android -tags=mesh -o packages/android/app/libs/mobile.aar
//      ./packages/desktop/mobile
//   2. cd packages/android && ./gradlew assembleRelease
//
// 不内置 Android SDK 下载 —— 那是 CI runner 的职责（setup-android action）。
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
  console.error('[android] 缺少 gomobile。先运行：go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init')
  process.exit(1)
}
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  console.error('[android] 未设置 ANDROID_HOME / ANDROID_SDK_ROOT')
  process.exit(1)
}

mkdirSync(libsDir, { recursive: true })
const aar = join(libsDir, 'mobile.aar')
console.log('[android] gomobile bind → mobile.aar …')
execFileSync('gomobile', [
  'bind', '-target=android', '-tags=mesh', '-o', aar,
  './packages/desktop/mobile',
], { cwd: repoRoot, stdio: 'inherit' })
console.log('[android] ✅ AAR 已生成')

const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
if (!existsSync(gradlew)) {
  console.log('[android] 未找到 gradlew wrapper，跳过 APK 构建（请在 Android Studio / CI 中构建）')
  process.exit(0)
}
console.log('[android] Gradle assembleRelease …')
execFileSync(gradlew, ['assembleRelease'], { cwd: androidDir, stdio: 'inherit' })
console.log('[android] ✅ APK 已生成：packages/android/app/build/outputs/apk/release/')
