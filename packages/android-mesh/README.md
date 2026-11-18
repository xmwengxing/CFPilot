# CFPilot Mesh Android 版（9.5b）

CFPilot +mesh 的 Android 客户端。组网协议栈（帧 / Noise IKpsk2 / AEAD / 打洞 / 选路 / 降级）
是纯 Go（CGO=0），通过 gomobile 绑定成 AAR 供 Android 调用；TUN 由 Android `VpnService` 建立，
fd 经 JNI 传给 Go，**不需要 root**。

## 架构

```
Kotlin MainActivity / MeshVpnService
        ↓ VpnService.Builder.establish() 拿 fd
gomobile AAR (packages/desktop/mobile)
        ↓ NewAndroidTun(fd) → mesh.Lifecycle
Go mesh 协议栈 (packages/desktop/internal/mesh)
        ↕  UDP / WSS 收发
远端节点
```

- `packages/desktop/mobile/mesh.go` —— gomobile 绑定门面（JSON 配置 + fd + 状态）
- `packages/desktop/internal/mesh/tun_android.go` —— VpnService fd → TunDevice
- `app/src/main/java/com/cfpilot/mesh/MeshVpnService.kt` —— VPN 服务（建 TUN / 下发地址路由 / 保活）
- `app/src/main/java/com/cfpilot/mesh/MainActivity.kt` —— 配置与启动界面

## 构建

### 一条命令（本机工具链已备好）

```powershell
. .\scripts\android-env.ps1      # 设置 JAVA_HOME / ANDROID_HOME / NDK / Gradle / PATH
node scripts/build-android.mjs   # gomobile AAR → Gradle APK →（可选）签名
```

`scripts/build-android.mjs` 会**自动探测工具链**（环境变量优先，其次本机约定位置），
不需要手动 export 一堆变量；缺哪一项会直接说明缺什么。

### 本机工具链位置（不再依赖临时目录）

| 组件 | 位置 |
|---|---|
| JDK 17 | `%USERPROFILE%\tools\android\jdk17\jdk-17.0.21+9` |
| Gradle 8.9 | `%USERPROFILE%\tools\android\gradle-8.9` |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（platform 34 / build-tools 34.0.0 / NDK 27.2.12479018） |
| gomobile | `%USERPROFILE%\go\bin\gomobile.exe` |

这四样都是**机器级、可被任意会话/agent 复用**的；仓库只提供探测与调用逻辑。

### 签名（可选）

```powershell
$env:CFPILOT_ANDROID_KEYSTORE='<keystore>'
$env:CFPILOT_ANDROID_KEY_ALIAS='cfpilot'
$env:CFPILOT_ANDROID_STORE_PASS='<口令>'
$env:CFPILOT_ANDROID_KEY_PASS='<口令>'
node scripts/build-android.mjs
# 产物：app/build/outputs/apk/release/cfpilot-<版本>+mesh-android.apk
```

不设置则只出 unsigned APK，脚本会打印需要手动 `apksigner`。

### 已踩过的坑（脚本已内置处理，别删）

1. `gomobile bind` 必须 `-androidapi=26`（默认 API 16 会报 unsupported）。
2. Windows 中文 locale 下 javac 按 GBK 读生成的 `Mobile.java` 会报「GBK 不可映射字符」
   ⇒ 必须 `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8`。
3. Go 1.27 要求 `golang.org/x/mobile` 在**当前模块**的 tool graph 里（否则
   "missing golang.org/x/mobile dependency"）⇒ 脚本临时 `go get -tool` 后**必定还原**
   `desktop/go.mod` / `go.sum`，不把这条约束固化进仓库。
4. Node 20+/26 在 Windows 不能直接 spawn `.bat`（EINVAL）⇒ 脚本用 `cmd /c` 包装。
5. gradlew 在 `~/.gradle` 无发行版缓存时会去下载（离线环境会挂）⇒ 脚本只在缓存
   非空时用 wrapper，否则回落到本机 Gradle。

## 说明

- Android 上地址 / 路由 / MTU 由 `VpnService.Builder` 下发（addAddress/addRoute/setMtu），
  不走 Linux 的 `ip` 命令，也不需要 root。
- 虚拟 IP 必须与对端**同一 /24 网段、只改最后一段**；`MeshVpnService` 会用配置里的
  `virtualIp` 同时设置接口地址与同网段路由。
- 首次启动会弹系统 VPN 授权对话框，用户确认后才能建 TUN。
- CI 的 `android-mesh` job 产的是 unsigned APK；正式分发的签名由发布流程处理。

