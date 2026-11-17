// CFPilot +mesh Android 工程根构建脚本。
// gomobile 绑定 AAR 由 scripts/build-android.mjs 生成后放到 app/libs/。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
}
