# CFPilot 桌面版（Go）

一个约 **7 MB** 的 Go 单二进制程序，提供 CFPilot 的图形化部署与优选能力。

## 为什么有 Go 版

Electron 版 exe 有 78 MB，其中 **268 MB（未压缩）是 Chromium + Node**，
而 CFPilot 自己的业务代码只有 **179.6 KB**，界面只用 DOM + CSS。
等于为了渲染一个表单页扛了一整台浏览器。

Go 版实测对比：

| | Electron 版 | Go 版 |
|---|---|---|
| Windows exe | 77.98 MB | **6.92 MB** |
| Linux | ❌ | 8.90 MB (amd64) / 8.31 MB (arm64) |
| 内存占用 | ~150 MB | ~25 MB |
| 启动速度 | 2~4 秒 | < 200 ms |

## 架构：不做浏览器，只做壳

```text
                    ┌─────────────────────────────┐
                    │  系统浏览器（用户自己的）      │
                    └──────────────┬──────────────┘
                                   │ HTTP (127.0.0.1)
                    ┌──────────────▼──────────────┐
                    │  Go 进程                     │
                    │  ├─ 托盘图标 / 菜单           │
                    │  ├─ 本地 HTTP 服务            │
                    │  └─ go:embed 内嵌界面资源     │
                    └─────────────────────────────┘
```

**界面与 Electron 版是同一份源码。**
`scripts/build-desktop.mjs` 把 `packages/gui/dist/renderer/` 的产物
拷进 `internal/server/assets/`，再用 `go:embed` 打进二进制。
这样两个版本永远渲染同一份 HTML/JS，Go 版界面不可能落后。

## 目录

```text
packages/desktop/
├── go.mod / go.sum
├── cmd/cfpilot/
│   ├── main.go           入口：参数解析、启动服务、打开浏览器
│   ├── msgbox.go         Windows 消息框（无控制台时也能看到错误）
│   └── msgbox_other.go   非 Windows 的 stderr 版本
└── internal/
    ├── config/           设置读写（~/.cfpilot-gui/desktop.json）
    ├── server/           本地 HTTP 服务 + 安全校验 + 端口管理
    └── tray/             托盘图标与菜单
```

## 安全模型

这个服务能读写 Cloudflare Token，是本地的高价值目标。四道防线：

| 防线 | 实现 | 防什么 |
|---|---|---|
| 只监听回环 | `config` 层强制 `Host = 127.0.0.1`，改不动 | 局域网扫描 |
| 一次性令牌 | 启动生成，拼在欢迎 URL 里，换 HttpOnly Cookie | 别的网页直接调 API |
| Host 校验 | 必须是 `127.0.0.1` / `localhost` | DNS Rebinding |
| Origin 校验 | 带 Origin 的请求必须同源 | 跨站请求伪造 |

全部有单元测试覆盖（`internal/server/server_test.go`）。

> ⚠️ **写测试时注意**：Go 的 `req.Header.Set("Host", ...)` **不生效**，
> `Host` 是特殊头，必须赋给 `req.Host`。踩过这个坑，导致
> 「Host 校验」测试曾经是假通过。

## 本地开发

```bash
cd packages/desktop

# 跑测试
go test ./...

# 直接跑（不启托盘，看日志）
go run ./cmd/cfpilot --no-browser --no-tray --port 19726

# 自检
go run ./cmd/cfpilot --check
```

## 构建

从仓库根目录执行（会先同步界面资源）：

```bash
npm run build -w @cfpilot/gui      # 先出界面产物
node scripts/build-desktop.mjs     # 再编三平台
```

产物在 `packages/desktop/dist/`：

```
cfpilot-<版本>-windows-amd64.exe
cfpilot-<版本>-linux-amd64
cfpilot-<版本>-linux-arm64
```

## 命令行参数

```
--port <n>       临时指定端口（不写入配置）
--no-browser     启动后不自动打开浏览器
--no-tray        不启托盘，只跑服务（服务器 / 无桌面环境）
--console        日志写入配置目录的 cfpilot.log
--check          只做自检（配置目录 / 端口可用性），不启动
--version        打印版本号
```

## 发布

```bash
npm run version:bump -- 0.5.6
git add -A && git commit -m "..." && git push origin main
git tag -a desktop-v0.5.6 -m "..."
git push origin desktop-v0.5.6
```

CI（`.github/workflows/release-desktop.yml`）在 `ubuntu-latest` 上
交叉编译三平台、**实跑 Linux 产物做冒烟测试**，然后自动发布 Release。

## 技术选型备注

**托盘库用 `energye/systray` 而不是 `getlantern/systray`。**
后者在 Linux 上依赖 CGO（GTK / appindicator），
`GOOS=linux CGO_ENABLED=0` 直接编译失败（`undefined: nativeLoop`）。
前者是纯 Go 实现（Linux 走 D-Bus StatusNotifierItem），
实测三平台交叉编译全部通过，且产物是静态二进制、不挑 glibc 版本。

**换端口必须先 flush 响应再后台执行。**
关旧监听会掐断「正在处理这次换端口请求」的那条连接：
- `Close()` 立刻断开 → 客户端报 `response ended prematurely`
- `Shutdown(ctx)` 会等本请求结束，而本请求正等 Shutdown 返回 → 死等到超时

所以 `handleServicePort` 先把响应写出去并 `Flush()`，
再 `go func()` 里延迟 250ms 执行真正的切换。

## 与 Electron 版的关系

- **凭据共用**：同一个 `~/.cfpilot-gui/secrets.json`，换版本不用重填 Token
- **界面共用**：同一份 `packages/gui/src/renderer/`
- **并行发布**：Go 版发满 3 个版本后停发 Electron 版 exe，源码永久保留
