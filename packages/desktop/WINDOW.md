# 桌面版面板窗口：设计取舍与验证记录

本文件记录「把面板从系统浏览器标签页搬进应用自己的窗口」的选型依据与实测结果。
改动 `packages/desktop/internal/shell/`、`packages/desktop/webui/adapter.js`
或 `scripts/build-desktop.mjs` / `scripts/build-installers.mjs` 前先读一遍。

## 1. 选型结论

| 方案 | 体积 | 构建链 | 结论 |
|---|---|---|---|
| Electron | 78 MB / ~150 MB 内存 | 宽松 | 已停发，倒退 |
| Wails v3 | ~15 MB | Go 1.26；Linux 必须 CGO + GTK4/WebKitGTK 6.0；arm64 交叉编译需 Docker | 推翻 CGO=0 与静态单文件不变量，未采用 |
| Tauri v2 | ~10 MB | Rust + Go sidecar | 多一套工具链与一层 IPC，收益为 0 |
| Fyne / Gio / walk | ~15 MB | 宽松 | 8000 行表单/表格/日志面板要重写，CJK/IME/表格体验倒退 |
| **薄壳 + 系统 WebView** | +2.6 MB（Win） | CGO=0 不变 | **采用** |

- Windows：`github.com/jchv/go-webview2`（纯 Go，Wails 内部同款）。
- Linux：`github.com/crgimenes/glaze`（purego，运行时 dlopen WebKitGTK）。

## 2. 两个产物（普通版 / +mesh）怎么区分

同一 tag、同一版本号，产物名与界面都要能一眼分开 —— 两者的功能集不同，
拿错了既没有组网能力，也会在日志里看到不该出现的组网请求。

| | 普通版 | +mesh 版 |
|---|---|---|
| 产物名 | `cfpilot-<v>-windows-amd64.exe`<br>`cfpilot-<v>-linux-{amd64,arm64}` | `cfpilot-<v>+mesh-windows-amd64-setup.exe`<br>`cfpilot-<v>+mesh-linux-amd64.deb` |
| 分发形态 | 单文件，双击即用 | **安装包**（NSIS 向导 / dpkg），落盘到自己的目录 |
| 额外文件 | 无 | `cfpilot-meshd.exe`（提权服务）+ `wintun.dll` → `$INSTDIR` |
| 界面 | 无「组网」页签，徽标 `v0.50.0` | 有「组网」页签，徽标 `v0.50.0 +mesh` |
| 组网 API | 不注册（`mesh_variant_stub.go`） | 转发到 `127.0.0.1:19727` 的 meshd |

- `+mesh` 必须是安装包：它要带 `wintun.dll`（TUN 驱动）与提权守护进程，
  两者都得落到**固定目录**才能注册服务、卸载时清理干净。裸 exe 做不到。
- `wintun.dll` 不随包分发（`ADR-0002`）：安装器提权调用
  `cfpilot --fetch-wintun "$INSTDIR"` 官方下载 + 双重 SHA256 校验，失败即中止安装。
- 界面靠 `/api/mesh/enabled` 判定变体：普通版连 `/api/mesh/*` 的**一个请求都不发**
  （否则日志每 2 秒一条 404）；`+mesh` 在守护进程没起来时状态接口回
  `200 {running:false, note:"…未运行…"}`，而不是 502 —— 未运行是正常状态，不是服务器错误。

## 3. 已在本机验证（Windows 11 / DPI 192 = 200%）

| 项 | 结果 |
|---|---|
| `go build ./...`（宿主平台） | 通过 |
| `go vet ./...` | 通过（仅 mesh 既有 `unsafe.Pointer` 提示） |
| `go test ./...` | 26 个包全部通过 |
| `go build -tags mesh ./...` | 通过 |
| `exe --version` / `exe --check` | 退出码 0，文案正常 |
| Windows 普通版体积 | 10.88 MB |
| Windows +mesh 体积 / NSIS 安装包 | 11.76 MB / 8.06 MB |
| Linux 图形产物 | 12.68 MB amd64 / 11.75 MB arm64 |
| 容器静态产物 | amd64 12.36 MB / arm64 11.44 MB，**无 `.dynamic` 段** |
| 图形产物 `DT_NEEDED` | `libdl.so.2, libpthread.so.0, libc.so.6`（无 webkit/gtk） |
| `cfpilot --fetch-wintun <目录>` | 下载成功，`wintun.dll` 落到指定目录 |

### 3.1 窗口运行时（普通版 exe，真实鼠标/消息驱动）

| 项 | 结果 |
|---|---|
| 窗口样式 | `class=webview`，`style=0x140f0000`：**无 `WS_CAPTION`**、有 `WS_THICKFRAME`（无边框 + 可缩放 + DWM 阴影） |
| 初始尺寸 | 1180×820（请求值），居中于 850,400 |
| 自绘标题栏 | 截图可见「CFPilot ＋ 最小化/最大化/关闭」，且与页面内容不重叠 |
| 点「关闭」（自绘按钮） | 窗口隐藏、**进程存活**、托盘宿主窗口 `SystrayClass` 仍在 |
| 二次启动 | 隐藏的窗口被唤回前台，第二个进程 exit 0，日志「已有实例在运行，已唤醒它的面板窗口」 |
| 点「最小化」 | `IsIconic=true` |
| 点「最大化」 | `IsZoomed=true`，占满 2904×1644 |
| 拖动标题栏 | 光标 +225/+120，窗口位移 +225/+120（`WM_NCLBUTTONDOWN(HTCAPTION)` 生效） |
| 外部链接 | 点「点此创建」后默认浏览器（Edge）被拉起（19 个新进程） |
| 普通版界面 | 无「组网」页签，徽标 `v0.50.0`，日志中**零** `/api/mesh/*` 请求 |
| +mesh 界面 | 有「组网」页签，徽标 `v0.50.0 +mesh`；meshd 未装时状态显示「未运行」，日志不再刷 502 |

### 3.2 Linux 回退（WSL2 Ubuntu，glibc 2.43，**未装 WebKitGTK**）

| 场景 | 结果 |
|---|---|
| `cfp_gui` 产物，无 `DISPLAY` / `WAYLAND_DISPLAY` | 日志「内嵌窗口不可用，回退系统浏览器：…没有图形会话」，服务照常监听 |
| `cfp_gui` 产物，`DISPLAY=:99`（有显示环境但缺库） | 日志「…webview: none of [libwebkit2gtk-4.1.so.0 libwebkit2gtk-4.0.so.37] could be loaded…」，回退浏览器 |
| 容器静态产物 | `ldd` → `not a dynamic executable`；`--version` / `--check` 正常；`--no-tray --no-browser` 下 `curl /` 返回 HTTP 200 |

## 4. 必须知道的构建事实

purego 通过 `//go:cgo_import_dynamic` 实现 `dlopen`，因此**只要编入
glaze，Linux 产物就会链接 glibc**（`libc.so.6` / `libdl` / `libpthread`）。
容器镜像是 Alpine（musl），这种产物在 `exec` 阶段直接失败。

所以 Linux 有两种构建，不能合并：

| 产物 | 构建标签 | 用途 | 校验 |
|---|---|---|---|
| `cfpilot-<版本>-linux-*` | `cfp_gui` | 用户下载的图形版 | `DT_NEEDED` 不得含 `libwebkit*` / `libgtk-*` |
| `docker/dist/<arch>/cfpilot` | 无 | Alpine 容器 | 必须没有 `.dynamic` 段 |

两条校验都写在 `scripts/build-desktop.mjs`，构建失败即终止。

## 5. 本轮验证中发现并修掉的缺陷

1. **普通版仍有「组网」页签**：`nav.tabs button { display:inline-flex }` 盖过了
   `[hidden]`（规格里 `[hidden]` 只有 `display:none`，任何显式 display 都能覆盖）。
   已在 `packages/ui/src/index.html` 增加
   `nav.tabs button[hidden], .subtabs button[hidden], .btn[hidden] { display:none !important }`。
2. **普通版日志每 2 秒刷 404**：`/api/mesh/status` 轮询与身份/候选源加载
   不看构建变体。现在所有 `/api/mesh/*` 请求都以 `meshVariantReady`
   为前提（`packages/ui/src/renderer.ts`）。
3. **双击已运行的 exe 弹出「端口被占用」错误框**：新进程先 `srv.Start()`
   再检查单实例，端口冲突在检查之前就发作了。现在启动失败时先
   `shell.ActivateExisting(panelTitle)`：找到窗口就唤醒并安静退出
   （Windows 实现；Linux 无按标题找窗口的能力，返回 false）。
4. **+mesh 未装服务时刷 502**：状态接口改为回 `200 {running:false}`，
   「组网」页照常显示「未运行」和原因。

## 6. 尚未验证（需要在目标环境补测）

1. Linux **有 WebKitGTK 的桌面**：窗口能否正常创建、GTK 原生标题栏是否与面板冲突；
2. GTK 窗口关闭后（窗口被销毁）托盘「打开面板」回退系统浏览器；
3. Windows 10 与 100% / 125% / 150% DPI（本机只覆盖 200%）；
4. 托盘图标**本身**的点击（本轮用「二次启动唤醒」覆盖了同一个 `showWindow` 代码路径）；
5. 最大化状态下再点标题栏「最大化」是否还原（本轮只验证了系统级 `SW_RESTORE`）；
6. 真正安装 `+mesh` 安装包（注册 meshd 服务）后的组网连通性；
7. 窗口内 SSE 实时日志与长任务的界面流畅度。

## 7. 回滚

`internal/shell` 与主流程解耦：

- `CFPILOT_PANEL=browser` 或 `--browser`：完全回到「系统浏览器标签页」；
- 删除 `main.go` 里的 `shell.New` 调用即恢复旧行为（`--no-tray` 容器路径不受影响）。
