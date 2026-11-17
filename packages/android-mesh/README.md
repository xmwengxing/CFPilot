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

前提：Go + gomobile、Android SDK（`ANDROID_HOME`）、JDK 17、Gradle wrapper。

```bash
# 1. 生成 Go AAR
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init
node scripts/build-android.mjs

# 2. 或用 Android Studio 打开 packages/android 直接构建 APK
```

`scripts/build-android.mjs` 会先 `gomobile bind -tags=mesh` 生成
`app/libs/mobile.aar`，再调用 gradlew assembleRelease（有 wrapper 时）。

## 说明

- Android 上地址 / 路由 / MTU 由 `VpnService.Builder` 下发（addAddress/addRoute/setMtu），
  不走 Linux 的 `ip` 命令，也不需要 root。
- 首次启动会弹系统 VPN 授权对话框，用户确认后才能建 TUN。
- 这是 9.5b 阶段的代码骨架；本机无 Android SDK，需在 CI（android runner）或装有 SDK 的环境构建验证。

