# CFPilot 项目交接文档

> 最后更新：2026-10-27，对应版本 **0.6.5**
>
> 本文只保留**当前仍然成立**的事实与决策。
> 历史排查过程见文末「历史档案」，那些结论大多已被推翻，仅供追溯。

---

## 1. 项目现状

### 1.1 一句话

CFPilot 是一个 **Cloudflare Pages 双项目代理工具**：控制面提供面板 / 订阅 / 探针，
数据面提供 VLESS-WS / Trojan-WS / VLESS-XHTTP 代理，两者共用同一个 KV。
配套本地真连接优选器（CLI + 图形版），解决「优选 IP 填进客户端全是 -1」的问题。

### 1.2 交付物（全部就绪）

| 路径 | 状态 | 入口 |
|---|---|---|
| **Go 桌面版** | ✅ 唯一图形版本 | `cfpilot-<版本>-windows-amd64.exe`（8.3 MB）<br>`cfpilot-<版本>-linux-{amd64,arm64}` |
| CLI 优选器 | ✅ npm 已发布 0.6.5 | `npx -y cfpilot-scanner@latest scan --host <数据面域名> --panel <控制面域名>` |
| CLI 部署向导 | ✅ npm 已发布 0.6.5 | `npx -y cfpilot-deploy@latest`（默认 pages-split） |
| 线上部署 | ✅ 运行中 | 控制面 `cpmanager.pages.dev`，数据面 `cpdata-efj9-byq5.pages.dev` |

**Electron 版已于 2026-10-27 停发**（78 MB vs Go 版 8.3 MB，功能完全一致）。
外壳源码不入库，开发者本地保留在 `../CFPilot-electron-local` 供实验。

### 1.3 版本体系（单一版本源）

- **所有包同版本**：root / worker-core / scanner-cli / deploy-wizard / ui / desktop。
- 根 `package.json` 的 `version` 是**唯一版本源**，当前 **0.6.5**。
- 升级唯一入口：`npm run version:bump -- <版本>`（自动同步全部 workspace）。
- 手改子包 `package.json` 或 `src/version.ts` = 违规。
- 内核 `BUILD_VERSION` = `<git短hash>-<源码内容哈希8位>`，与包版本无关。

### 1.4 仓库结构

```
packages/
├── worker-core/      边缘内核（控制面 control.js / 数据面 dataplane.js / 面板）
├── scanner-cli/      cfpilot-scanner —— 本地真连接优选器（npm 包）
├── deploy-wizard/    cfpilot-deploy —— 部署向导（npm 包）
├── ui/               界面源码（唯一来源，Go 版复用）
└── desktop/          Go 桌面版（单二进制 + 托盘）
```

### 1.5 测试基线

```
Go:              175 项 PASS + 15 项 SKIP（8 个包）
界面 / CLI:       542 项 PASS（46 个文件）
校验脚本:          5 个（适配层契约 19 / 外壳结构 20 / 三方集成 4 类 / 日志栏 20 / 版本哈希 8）
typecheck / gofmt / vet: 干净
```

> 15 项 SKIP 是真机测试（`TestLive*`），需要环境变量
> `CFPILOT_LIVE_TOKEN` 等才会执行，CI 上正常跳过。

---

## 2. 架构铁律

### 2.1 部署形态唯一 = Pages 双项目

Workers 双脚本形态曾作实验（提交 `3c0fa3c`），2026-10-24 全线归档
（`archive/workers-deploy/`）：数据面在 Workers 上 522 无解，
**且实验用干净账号在少量部署后被封禁**。禁止重新引入。

### 2.2 数据面 100% 自研

历史第三方实现（CFNext 的 `wsHandler`，351.7 KB）已于 2026-10-25 完全移除。
数据面只剩 `protocols/websocket-self.ts` 一套实现，**没有回退开关**。

移除后体积：`dataplane.js` 43.4 KB / `control.js` 61.1 KB / `worker.js` 95.5 KB。

### 2.3 一个 KV 命名空间 = 一个实例

内核在 KV 里的键**全局平铺、无实例前缀**：

```
CONFIG / PANEL_PATH / ADMIN_PW_HASH / LOCAL_PREFERRED_IPS /
SESSION:* / SCANNER_TOKEN / CFP_DEPLOY_MANIFEST
```

两个实例共用一个 KV 会互相覆盖 UUID / WS 路径 / 面板密码 / 会话。

**归属判定五分支**（三端必须一致）：

| verdict | 含义 | 阻断 |
|---|---|---|
| `empty` | 空命名空间 | 否 |
| `owned` | 清单属于本实例 | 否 |
| `occupied` | 清单属于另一实例 | 是（force 可越） |
| `foreign` | 含 CFNext 的小写 `config` 键 | **是（force 不可越）** |
| `stale` | 含 `CONFIG` 但无清单 | 是（force 可越） |

### 2.4 绝不写小写 `config` 键

小写 `config` 是 CFNext 原版的配置键，写入会改坏共栖项目。
CFPilot 数据面只读**大写 `CONFIG`**。

### 2.5 8000119 平台行为（实测，不要臆测）

| 场景 | 行为 |
|---|---|
| 控制面原地重部署 | 无限制 |
| **数据面原地重部署** | **持久性拒绝**（实测 4/4）→ 必须新建项目 + 切 `DATA_HOST` |
| 新项目首次部署 | 间歇性拒绝，**原样重试通常可过** |

向导已自动化：同项目重试 3 次 → 换名重建 → 同步 `DATA_HOST` → 清理被淘汰项目。

### 2.6 Worker 不能连回 Cloudflare Anycast

`1.1.1.1` / `cloudflare.com` / `104.16.0.1` 一律 `TCP Loop detected`。
CF 网段目标只能靠**第三方反代入口按 SNI 转发**打通。
⚠️ 域名直连也算 —— 解析到 CF 网段时同样被拒。

### 2.7 配置优先级

`KV (CONFIG) > 环境变量 > 内置默认值`

例外：**面板路径与密码 env 优先** —— 否则复用 KV 时新凭据会被旧哈希挡住，
表现为「拿着新密码登不进去」。

### 2.8 协议实现要点

**VLESS**
```
0      版本（0x00）
1..16  UUID 原始 16 字节
17     Addons 长度 M
18..   Addons（M 字节 protobuf）
18+M   命令 0x01=TCP 0x02=UDP
+1..2  端口（大端）
+3     地址类型 1=IPv4 2=域名 3=IPv6
+4..   地址
```
响应头：`版本(1) + Addons 长度(1) + Addons`

**Trojan**
```
0..55  hex(SHA224(password)) —— 56 个 ASCII 十六进制字符
56..57 CRLF
58     命令 0x01=CONNECT 0x03=UDP
59     地址类型 1=IPv4 3=域名 4=IPv6   ← 与 VLESS 不同！
60..   地址
+2     端口（大端）
+2     CRLF
```
SHA-224 无法用 WebCrypto，必须用 `protocols/sha224.ts` 的纯 TS 版本。

**XHTTP（stream-one）**
一个 POST 承载上行与下行，请求体首字节为 VLESS 头，响应为流式体。
不支持 UDP。

### 2.9 其它硬约束

- **WebSocket close reason 必须截断到 123 字节**（RFC 6455 §5.5.1）。
  超长时 Cloudflare 边缘会静默丢弃整个 close frame，客户端表现为「一直连着但永不关闭」。
- **协议响应头必须在出站建连之前回**。否则 workerd 报
  `detected that your Worker's code had hung`。
- **socket 的写流不能 `close()`**，只 `releaseLock()`。否则目标站收 RST。
- **ReadableStream 的 `start` 不能 async 承载数据流**，数据在 `pull` 里读。
- **代理候选与直连候选必须互斥**，同池竞速会静默绕过代理。
- **优选网段必须按「大小 × 可用率」加权采样**，按大小分配会有一半来自 0% 可用网段。
- **`162.159.0.0/16` 是 CF 管理网段**，实测大面积 403，权重必须为 0。
- **Cloudflare `connect()` 不支持 IPv6 出站**，代理服务器必须有 IPv4。
- **DoH 优选库必须整体判定**，否则 SPF 里的 `ip4:1.2.3.4` 会被误当优选 IP。

---

### 2.10 能力清单（供接手者快速了解范围）

### worker-core（边缘内核）

**入站**：VLESS-WS / Trojan-WS（SHA-224 纯 TS 实现）/ VLESS-XHTTP(stream-one)。
协议响应头先回，出站后台进行。

**出站**：直连 TCP、并发竞速拨号、ProxyIP 池故障转移、NAT64 前缀合成、
SOCKS5 / HTTP CONNECT / HTTPS 代理池（`#sni=` 显式 SNI）、
反代入口池（`relayPool` 可自配、colo 优先、30s 缓存、`USE_BUILTIN_RELAY` 可关）、
CF 网段候选降权（含域名直连降权）。

**诊断**：`GET /__diag` 返回最近 20 条完整出站诊断。
（close reason 装不下多行诊断，且有 123 字节上限。）

**探针 `/__edge_probe`**：
- `Upgrade: websocket` → 返回 101 并回传 `cf.colo`
- `?bytes=N` → 流式输出（上限 15 MB，默认 2 MB）用于真实下行测速

**订阅**：`/sub/<UUID>`；格式按 **URL 参数 > User-Agent > 默认 base64** 协商；
节点形态由 `subVariants` 多选（默认只 `vless-ws`）；
订阅名称可改（`subName`）；端口多选（`subPorts`）；ECH 参数可注入（默认关闭）。

**优选池四层**：
- L1 本地真连接结果（KV `LOCAL_PREFERRED_IPS`）
- L2 `ADD` 手动
- L3 `ADDAPI` 远程 TXT
- L4 `ADDCSV` 远程 CSV（支持 `DLS` / `MAX_LATENCY` 阈值）

**脏数据容错**：裸 IP、`IP:Port`、`IP:Port#备注`、`[IPv6]:Port#备注`、优选域名、
CloudflareSpeedTest 风格 CSV 原文 —— 清洗集中在 `sub-engine.ts`。

**版本端点**：`GET /__cfp_version`（别名 `/__version`）返回构建版本号，
供部署向导判断是否需更新。

### scanner-cli（本地真连接优选器）

- **三阶扫描**：TCP 握手初筛 → WS 101 真连接校验 → 真实下行测速（滑动窗口峰值）
- **国家筛选**：`--countries`（多选，不选跑全量）
- **候选采样**：`--sample N`（默认 6556）按「大小 × 可用率」加权分配
- **回填**：`--panel` + `--panel-password` 自动取令牌并写面板；
  `--no-callback` 只输出
- **对接任意 VLESS-WS 项目**：`--path /<该项目路径>`
- **可复制输出**：`IP:端口#机房`，一行一个
- **桥接模式**：`serve` 在 `127.0.0.1:19527` 提供 `/status` `/start-scan` `/events` `/results`
- **网络环境检测**：`net-env.ts` 检测系统代理 / TUN fake-ip / MSYS 路径污染

### deploy-wizard（部署向导）

- `pages-split` —— Pages 双项目（**唯一通道**）：
  建项目 → 配 KV 与环境变量 → **先部署数据面再部署控制面**
  （顺序不可调换：绑定只对之后的部署生效）
- **同源项目识别**：清单写 KV `CFP_DEPLOY_MANIFEST`
  （项目名、域名、构建版本、凭据），更新部署自动读取，**用户不需记项目名**
- **KV 归属校验**：越界写入一律中止；`--list-kv` / `--new-kv` / `--kv <id>`
- **版本跳过**：构建版本一致时跳过部署
- **沿用凭据**：更新时默认沿用原 UUID / WS 路径 / 面板凭据
- **8000119 重试**：同项目重试 3 次 → 换名 → 同步 `DATA_HOST` → 清理被淘汰项目
- 支持 `--yes` 非交互与 `--dry-run`；零运行时依赖

---

## 3. 开发顺序（必须遵守）

```
worker-core（内核）
      ↓
scanner-cli（优选器 CLI）  +  deploy-wizard（部署 CLI）
      ↓
packages/ui（界面源码）
      ↓
desktop（Go 版，唯一的图形外壳）
```

**两个 CLI 包是权威实现**，不是附属工具。改动时先在 CLI 层把语义定下来跑通，
再让 Go 版按同一份语义实现，最后确认界面跟上。

⚠️ **绝不接受「图形版先改、CLI 后补」** —— CLI 会长期落后，
而它恰恰是最容易被用户拿去做自动化脚本的入口。

### 3.1 提交前检查

```bash
# 1. 内核
npm run build -w @cfpilot/worker-core
npm run build -w cfpilot-deploy          # 同步 assets/cfpilot-worker.js

# 2. CLI 实跑（不要只看 typecheck）
npm run build -w cfpilot-scanner
node packages/scanner-cli/dist/cli.js scan --help
node packages/scanner-cli/dist/cli.js scan --host <真实数据面> \
     --panel <真实控制面> --panel-password <密码> --sample 200

# 3. Go 版
cd packages/desktop && go test ./...
cd ../.. && node scripts/build-desktop.mjs

# 4. 界面
npm run build -w @cfpilot/ui
```

### 3.2 两处极易搞错的域名语义

| 场景 | 用哪个域名 |
|---|---|
| 优选的 SNI / Host | **数据面**（`cpdata-*.pages.dev` 或自定义域名） |
| 面板登录 / 回填 / 取令牌 | **控制面**（`cpmanager.pages.dev`） |

数据面没有面板 API（实测返回 Pages 的 Welcome HTML）。
CLI 的 `--host` 是数据面，`--panel` 是控制面，**不能互换**。

### 3.3 版本号陷阱

内核 `BUILD_VERSION` 的源码哈希**必须排除 `.generated.ts`**
（`ui/panel.generated.ts` 是 panel.html 的构建中间产物）。

不排除会导致：改了面板 UI 版本号不变 → 用户永远看到「已是最新」；
且版本号在不同构建间反复横跳。

`scripts/check-build-version.mjs` 已覆盖此点。

---

## 4. 发布流程

### 4.1 打 tag

```bash
npm run version:bump -- 0.6.6
npm run build
git add -A && git commit -m "release: 0.6.6"
git push origin main

git tag -a v0.6.6 -m "0.6.6"           # → npm 发布
git tag -a desktop-v0.6.6 -m "0.6.6"   # → GitHub Release
git push origin v0.6.6 desktop-v0.6.6
```

### 4.2 三个工作流

| 工作流 | 触发 | 产出 |
|---|---|---|
| `ci.yml` | push main | typecheck / test / build / 资产一致性 |
| `release-desktop.yml` | `desktop-v*` | GitHub Release（3 个平台产物） |
| `publish-npm.yml` | `v*` | npm 两包 → **推送到暂存区** |

### 4.3 npm 需人工批准（2026 令牌政策收紧）

npm 现在只发 **Staged Publish** 类型令牌，直接 `npm publish` 会报
`403 This token can only publish to a staging area`。

流程：CI `npm stage publish` → 你在本地 `npm stage approve <id>` 输 2FA。

```bash
npm login
npm stage list
npm stage approve <stage-id>
npm run verify:npm
```

> CI 里必须用 **npm@11**（Node 20 自带 npm 10 无 `stage` 命令；
> npm@12 要求 Node 22+ 会 EBADENGINE）。

### 4.4 Release 说明

正文从仓库根目录的 `RELEASE_NOTES.md` 读取（`body_path`）。
每次发版更新该文件即可，不用动工作流。

---

## 5. 图形版

### 5.1 形态与体积

| | Go 版 |
|---|---|
| Windows x64 | 8.27 MB |
| Linux x64 | 10.21 MB |
| Linux arm64 | 9.50 MB |
| 界面 | 系统浏览器标签页 |
| 通信 | `fetch('/api/...')` + SSE |
| 依赖 | 零（静态单文件） |

### 5.2 架构

```
packages/ui（界面源码，唯一来源）
      ↓ npm run build -w @cfpilot/ui
   dist/index.html + dist/renderer.js     ← 外壳无关，不注入 adapter
      ↓ scripts/build-desktop.mjs（注入 adapter.js）
packages/desktop/internal/server/assets/  → go:embed 进 exe
```

**铁律**：

1. 界面只改 `packages/ui/src/`，不许在 desktop 里放第二份 HTML/JS。
2. `packages/ui/dist/index.html` **不注入 adapter.js** —— 那是 Go 版专属，
   由 `build-desktop.mjs` 拷贝时插入。保持外壳无关。
3. `window.cfpilot` 是界面唯一依赖契约（`packages/ui/src/globals.d.ts`）。
   改契约必须同步 Go 版适配层，`check-adapter-contract.mjs` 会校验。

### 5.3 安全四道防线

1. 一次性启动令牌（URL `?t=`）
2. HttpOnly Session Cookie（`SameSite=Lax`，Strict 会让地址栏打开时丢 Cookie）
3. Host 头校验（防 DNS Rebinding）
4. Origin 同源校验

服务只监听 `127.0.0.1`。改动 `server.go` 必须补 `server_test.go` 用例。

### 5.4 常见坑

- **测试里设 Host 头必须用 `req.Host`**，`req.Header.Set("Host", ...)` 会被 Go 忽略。
- **换端口必须先 flush 响应再后台执行**，`Close()` 会让客户端拿到
  `response ended prematurely`。
- **托盘库用 `energye/systray`**（`getlantern/systray` 在 Linux 上要 CGO）。
- **Windows 托盘图标必须用 ICO**，PNG 不报错但显示为透明。
- **内核产物用 `go:embed` 内嵌**，不放 exe 旁边（否则分发漏文件就不可用）。

### 5.5 凭据

`~/.cfpilot-gui/secrets.json`，v2 格式（v1 自动迁移）。
Go 版与历史 Electron 版共用，用户换版本不用重填 Token。

**部署密码与「修改已部署面板密码」是两个独立字段**：

| 字段 | 用途 |
|---|---|
| `DeployPanelPassword` | 部署时设置的密码（部署页填） |
| `PanelPassword` | 登录已部署面板改密码（凭据页填） |

早期混用同一字段，导致在凭据页改密码会连带改变下次部署的密码，
而云端变量加密，用户完全不知情。

---

## 6. 界面流程速览

界面四个页签，下方常驻日志。

**凭据页**：填 Token → 自动检测账号 → 自动列出 KV（选完即保存）。
此页的面板密码**只用于改已部署面板的密码**，不影响部署。

**部署页**：
- 全新部署无 KV 时**自动创建**
- 面板密码留空 = 首次随机 / 更新沿用原密码
- 部署完成日志打印完整凭据（地址 / 密码 / UUID / WS 路径）
- 可随时点「查看面板凭据」再看

**优选页**：
- 「自动识别」一次填好域名（数据面）与 WS 路径
- 跑完点「回填面板」写入面板的「手动优选 IP」；
  不想回填就点「复制结果」
- 令牌在点回填时才申请（10 分钟有效，不会因优选耗时而过期）

**说明页**：安全说明、Token 权限清单、常见问题。

---

## 7. 常用命令

```bash
# 开发
npm run build && npm run typecheck && npm run test
npm run verify                    # 全量校验（含 5 个检查脚本）

# Go 版
cd packages/desktop
gofmt -l . && go vet ./... && go test ./...
cd ../.. && node scripts/build-desktop.mjs

# 版本
npm run version:bump -- 0.6.6

# npm 发布后校验
npm run verify:npm

# 部署（CLI）
npx -y cfpilot-deploy@latest                          # 默认 pages-split
npx -y cfpilot-deploy@latest --new-kv                 # 部署第 2+ 个实例
npx -y cfpilot-deploy@latest token --check            # 检查 Token 权限

# 优选（CLI）
npx -y cfpilot-scanner@latest scan \
  --host <数据面域名> --panel <控制面域名> --panel-password <密码>
```

---

## 8. 当前线上环境

**账号**：`70ec011b12cd621609a8412a4d0c1668`（32724941@qq.com's Account）

| 类型 | 名称 | 备注 |
|---|---|---|
| Pages | `cpmanager` | 控制面（面板 / 订阅 / 探针） |
| Pages | `cpdata-efj9-byq5` | 数据面（代理入站） |
| Pages | `cfnext` | 不属于本项目，**不要动** |
| KV | `cfpilot-gui-a50q30qu` | CFPilot 实例（`ed017c97...`） |
| KV | `cfnext` | **foreign，界面禁用** |

---

## 9. 已知缺口

| 缺口 | 优先级 | 说明 |
|---|---|---|
| exe 代码签名 | P3 | 未签名，Windows SmartScreen 会提示 |
| DoH TXT 优选库真机验证 | P3 | 需要特定域名，普通域名 TXT 是 SPF/验证记录 |
| 多实例管理 UI | P3 | 目前靠 CLI `--new-kv` |

### 设计上不支持（非 bug）

- 单个 KV 承载多个实例（架构限制）
- Workers 部署形态（封号风险）
- IPv6-only 代理服务器（Cloudflare `connect()` 限制）
- XHTTP 的 UDP（协议限制）

---

## 10. 安全须知

- **不要提交密钥**：Cloudflare Token、面板密码、扫描令牌一律走环境变量或 KV。
- 本地调试凭据在 `packages/worker-core/.dev.vars`（已 gitignore）。
- `AGENTS.md` 是本地开发规范，**不入库**（已 gitignore）。
- 面板密码在 Cloudflare 云端是**加密的**，部署后必须从日志 / 界面记录，
  否则无法找回。

---

## 11. 历史档案

以下章节记录的是**已被推翻或已归档**的结论，仅供追溯当时的排查思路。

<details>
<summary>Workers 双形态归档（2026-10-24）</summary>

数据面在 Workers 上部署后必然 522，原因未获平台确认。
实验用干净账号在少量部署后被封禁。
归档位置 `archive/workers-deploy/`，禁止重新引入。

</details>

<details>
<summary>第三方数据面（vendor）移除（2026-10-25）</summary>

CFNext 的 `wsHandler` 占数据面产物 77%（351.7 KB）。
移除后 250 KB → 43.4 KB，且自研实现在真机对照中持平或更好。
自 2026-10-23 起自研已是默认，2026-10-25 彻底删除回退开关。

**注意**：本文旧版曾写「必须用 CFNext 数据面、不要改回自研」，该结论已作废。

</details>

<details>
<summary>早期误判记录（2026-10-21 ~ 10-22）</summary>

- 「静态 import sockets 会导致 1101」—— 错误，已推翻
- 「8000119 由内容决定」—— 错误，实际是流量项目持久性拒绝
- workers.dev 通道 —— 不可依赖，已放弃

详细的排查过程与推翻依据已从本文移除（价值仅在于避免重复踩坑，
而结论已固化到 §2 的铁律里）。

</details>

<details>
<summary>Electron 版停发（2026-10-27）</summary>

体积 78 MB 是 Go 版的 9 倍，功能完全一致。
`release-gui.yml` 已删除，`gui-v*` tag 不再产包。
外壳源码移出仓库（本地保留 `../CFPilot-electron-local`）。

</details>

---

## 12. 免责

本项目仅供学习研究。使用代理工具请遵守当地法律法规。
自行部署产生的一切后果由使用者承担。
