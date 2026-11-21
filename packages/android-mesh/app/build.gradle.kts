import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val rootPkg = JsonSlurper().parse(file("../../../package.json")) as Map<*, *>
val appVersionName = rootPkg["version"].toString()
val appVersionParts = Regex("""^(\d+)\.(\d+)\.(\d+)""").find(appVersionName)?.groupValues
val appVersionCode = if (appVersionParts != null) {
    appVersionParts[1].toInt() * 10000 + appVersionParts[2].toInt() * 100 + appVersionParts[3].toInt()
} else {
    1
}

android {
    namespace = "com.cfpilot.mesh"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cfpilot.mesh"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    buildTypes {
        release {
            // 与普通版一致：侧载分发包默认带 debug 签名，避免产出未签名 APK 无法安装
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // gomobile bind 生成的 AAR（由 scripts/build-android.mjs 放入 libs/）
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}


