# 本机 Android 构建工具链：设置环境并校验（可被任意会话 / agent 复用）
#
# 用法（PowerShell，dot-source 才会写进当前会话）：
#   . .\scripts\android-env.ps1
#
# 默认位置（已在本机备好，不再依赖 Temp 目录）：
#   %USERPROFILE%\tools\android\jdk17\<jdk-*>
#   %USERPROFILE%\tools\android\gradle-8.9
#   %LOCALAPPDATA%\Android\Sdk  (含 ndk\27.2.12479018、build-tools\34.0.0)
#
# 说明：gomobile 装在 %USERPROFILE%\go\bin（需 PATH 里能找到）。

$ErrorActionPreference = 'Stop'

function Find-Child($root, $pattern) {
  if (-not (Test-Path $root)) { return $null }
  $hit = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $pattern } | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $null
}

# ---- JDK 17 ----
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) {
  $jdkRoot = if ($env:CFPILOT_JAVA_HOME) { $env:CFPILOT_JAVA_HOME } else { Join-Path $env:USERPROFILE 'tools\android\jdk17' }
  $jdk = Find-Child $jdkRoot 'jdk-*'
  if (-not $jdk) { throw "找不到 JDK：请设置 JAVA_HOME 或把 JDK17 放到 $jdkRoot" }
  $env:JAVA_HOME = $jdk
}

# ---- Android SDK / NDK ----
if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) {
  $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}
if (-not (Test-Path $env:ANDROID_HOME)) {
  throw "找不到 Android SDK：请设置 ANDROID_HOME（当前 $env:ANDROID_HOME）"
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$ndk = Find-Child (Join-Path $env:ANDROID_HOME 'ndk') '27.*'
if (-not $ndk) { throw "找不到 NDK 27（gomobile 需要）：$env:ANDROID_HOME\ndk" }
$env:ANDROID_NDK_HOME = $ndk

# ---- Gradle ----
$gradleRoot = if ($env:CFPILOT_GRADLE_HOME) { $env:CFPILOT_GRADLE_HOME } else { Join-Path $env:USERPROFILE 'tools\android\gradle-8.9' }
if (-not (Test-Path (Join-Path $gradleRoot 'bin'))) {
  throw "找不到 Gradle：请设置 CFPILOT_GRADLE_HOME 或把 Gradle 8.9 放到 $gradleRoot"
}

# ---- gomobile ----
$gomobile = Join-Path $env:USERPROFILE 'go\bin\gomobile.exe'
if (-not (Test-Path $gomobile)) {
  throw "找不到 gomobile：go install golang.org/x/mobile/cmd/gomobile@latest 后应在 $gomobile"
}

# ---- 环境变量 ----
# gomobile 生成 Java 时会用 javac，默认 ACP/GBK 会让中文注释编译失败（本机实测）
$env:JAVA_TOOL_OPTIONS = '-Dfile.encoding=UTF-8'
$env:PATH = "$env:JAVA_HOME\bin;$gradleRoot\bin;$env:PATH"

Write-Host "[android-env] JAVA_HOME      = $env:JAVA_HOME"
Write-Host "[android-env] ANDROID_HOME   = $env:ANDROID_HOME"
Write-Host "[android-env] ANDROID_NDK_HOME = $env:ANDROID_NDK_HOME"
Write-Host "[android-env] GRADLE         = $gradleRoot"
Write-Host "[android-env] gomobile       = $gomobile"
Write-Host '[android-env] 已设置。接着跑: node scripts/build-android.mjs'
