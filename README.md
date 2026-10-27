# CFPilot（CP面板）

> Cloudflare 代理微内核 · 真连接优选面板 · 一键部署
> MIT License · 数据面完全自研（无第三方内核依赖）

把「代理内核 + 优选订阅 + 本地真连接优选 + 中文部署向导」整合成一套方案，
解决 Cloudflare 代理最常见的那类故障：**本地优选测速几百兆，客户端却全是** **`-1`**。

***

## 目录

- [快速开始](#快速开始)

- [图形化工具（Windows）](#图形化工具windows)

- [使用须知](#使用须知)

- [订阅接入](#订阅接入)

- [常见问题](#常见问题)

- [技术实现](#技术实现)

- [配置项与环境变量](#配置项与环境变量)

- [免责声明](#免责声明)

***

## 快速开始

三步走完，全程不需要手动点 Cloudflare 控制台。

### 1. 部署

```bash
npx -y cfpilot-deploy@latest pages-split # Pages 双项目（推荐）
npx -y cfpilot-deploy@latest init        # Worker 单项目（实验阶段，不可用）
```

`init` 会依次引导你完成：填 API Token → 选账号 → 自动建 KV → 上传内核 → 绑定域名。
结束时会打印面板地址、管理密码、订阅地址，**存好它们**。

> ⚠️ **建议绑定自定义域名**。`*.workers.dev` / `*.pages.dev` 在部分网络环境下会被直接阻断，
> 优选再准也-1。

<details>
<summary><b>手动部署（不通过命令行，直接从本仓库下载压缩包上传）</b></summary>

<br>

如果命令行部署受阻，可以用本仓库根目录的两份压缩包，在 Cloudflare 控制台手动上传。

| 文件                                               | 用途         |
| ------------------------------------------------ | ---------- |
| [`CFPilot-dataplane.zip`](CFPilot-dataplane.zip) | 数据面（纯转发）   |
| [`CFPilot-control.zip`](CFPilot-control.zip)     | 控制面（面板与订阅） |

> 两份包随每次构建自动更新，与本仓库代码保持一致。

#### 第 1 步：创建 KV 命名空间

Cloudflare 控制台 → **存储和数据库 → KV** → 创建命名空间，记下**命名空间 ID**。

#### 第 2 步：部署数据面

1. **Workers 和 Pages → 创建 → Pages → 上传资产**

2. 项目名随意（建议用普通名称，如 `blog-assets-sync`）

3. 上传 `CFPilot-dataplane.zip`

4. 部署完成后**记下项目域名**（形如 `xxx.pages.dev`）

5. **设置 → 变量和密钥**，添加：

   | 名称              | 值                      |
   | --------------- | ---------------------- |
   | `UUID`          | 你自己的 UUID（任意 36 位标准格式） |
   | `WS_PATH`       | 自定义路径，如 `/abc123`      |
   | `ENABLE_TROJAN` | `true` 或 `false`       |
   | `ENABLE_XHTTP`  | `true` 或 `false`       |

6. **设置 → 函数 → KV 命名空间绑定**：变量名 `KV` → 第 1 步的命名空间

7. **重新上传一次**（绑定与变量只对之后的部署生效）

#### 第 3 步：部署控制面

1. 另建一个 Pages 项目，上传 `CFPilot-control.zip`

2. **设置 → 变量和密钥**，添加：

   | 名称               | 值                 |
   | ---------------- | ----------------- |
   | `UUID`           | 与数据面相同            |
   | `WS_PATH`        | 与数据面相同            |
   | `DATA_HOST`      | 第 2 步记下的**数据面域名** |
   | `PANEL_PATH`     | 面板路径，如 `/mypanel` |
   | `ADMIN_PASSWORD` | 面板登录密码            |

3. **设置 → 函数 → KV 命名空间绑定**：`KV` → 同一个命名空间

4. **重新上传一次**

#### 第 4 步：访问

打开 `https://<控制面域名><PANEL_PATH>`，用 `ADMIN_PASSWORD` 登录。
订阅地址：`https://<控制面域名>/sub/<UUID>`

#### 更新时

新建 Pages 项目 → 上传新版 zip → 把控制面的 `DATA_HOST` 改成新数据面域名 → 删除旧项目。

</details>

### 2. 本地优选

```bash
npx -y cfpilot-scanner@latest scan \
  --host "你的数据面域名" \
  --path "/部署时生成的WS路径" \
  --sample 6556 --top 10
```

跑完会得到一段可直接粘贴的 IP 列表，把它填进面板的「**手动优选 IP**」。

> ⚠️ **跑之前关掉所有代理工具**（含 TUN 模式与系统代理）。
> 优选测的是「本机直连该 IP」的真实质量，流量被代理接管会导致所有 IP 成绩趋同、导入后大量 `-1`。

### 3. 导入订阅

面板首页会给出三种订阅地址，**按 User-Agent 自动识别格式**：

| 客户端                             | 拿到的格式       |
| ------------------------------- | ----------- |
| Clash Verge / Clash / mihomo    | YAML        |
| sing-box                        | JSON        |
| v2rayN / Shadowrocket / NekoBox | Base64 分享链接 |

也可以显式指定：`?target=clash` / `?target=singbox` / `?target=base64`。

节点的关键约定：`server` = 优选出的 **IP**，`sni` / `Host` = **你的域名**（固定），端口 = `443`。

***

## 图形化工具

不想碰终端就用图形版。**只提供一个版本（Go 版），下载即用。**

### 为什么只有 Go 版

早期同时提供 Electron 版（78 MB 安装包），2026-10-27 起**停发**：

|            | Go 版                          |
| ---------- | ----------------------------- |
| Windows 体积 | **8.3 MB**                    |
| Linux 支持   | ✅ x64 / arm64                 |
| 界面形态       | 系统浏览器标签页                     |
| 托盘         | ✅ 状态 / 端口 / 启停                |
| 依赖         | **零**（静态单文件）                 |
| 下载文件       | `cfpilot-<版本>-windows-amd64.exe` |

Electron 版体积是 Go 版的 9 倍，功能完全一致 —— 没必要让用户下 78 MB。

> Electron 外壳源码保留在开发者本地用于实验，**不入库**。
> 界面源码在 [packages/ui](packages/ui)，由 Go 版复用。

### 用法

1. 到 [Releases](https://github.com/xmwengxing/CFPilot/releases) 下载对应平台文件
   （Windows `.exe` 直接双击；Linux 先 `chmod +x`）
2. 运行后托盘出现图标，系统浏览器自动打开管理界面
3. 首次使用：填 API Token → 自动检测账号 → 自动建 KV → 一键部署
4. 「优选」页点「**自动识别**」填好域名与 WS 路径 → 开始优选 → 点「回填面板」

右键托盘图标可查看**服务状态 / 端口 / 运行时长**，也能**复制地址、修改端口、启停服务、退出**。

服务只监听 `127.0.0.1`，需要一次性令牌换取的会话才能访问，
并校验 `Host` 与 `Origin` 防 DNS Rebinding 与跨站请求。

常用参数：

```bash
--port <n>      临时指定端口（不写入配置）
--no-browser    启动后不自动打开浏览器
--no-tray       不启托盘，只跑服务（服务器 / 无桌面环境）
--console       日志写入配置目录的 cfpilot.log
--check         只做自检（配置目录 / 端口可用性）
```

### 界面流程

界面分四个页签：凭据 / 部署 / 优选 / 说明，下方是常驻日志。

- **凭据页**：填 Token → 自动检测账号 → 自动列出 KV。KV 下拉框选完即保存。
  这里的「面板密码」**只用于修改已部署面板的登录密码**，不影响部署。
- **部署页**：全新部署时若无 KV 会**自动创建**。部署密码在此页填，
  留空 = 首次随机生成 / 更新沿用原密码。部署完成后日志会打印完整凭据
  （面板地址 / 密码 / UUID / WS 路径），也可随时点「查看面板凭据」再看。
- **优选页**：一次「自动识别」同时填好域名（数据面）与 WS 路径。
  跑完后点「回填面板」即可写入面板的「手动优选 IP」；
  不想回填就点「复制结果」自己粘。
- **说明页**：安全说明、Token 权限清单、常见问题。

令牌只存在本机 `~/.cfpilot-gui/secrets.json`，不上传。

***

## 使用须知

### API Token 权限

在 [Cloudflare 控制台 → API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建自定义 Token：

| 分类                 | 权限项                                                      | 用途               |
| ------------------ | -------------------------------------------------------- | ---------------- |
| Account            | **Account Settings** → Read                              | 读取账号列表           |
| Developer Platform | **Workers KV Storage** → Edit                            | 建 KV、读写配置        |
| Developer Platform | **Workers Scripts** → Edit                               | 上传内核             |
| Developer Platform | **Pages** → Edit                                         | `pages-split` 需要 |
| Zone               | **Zone** → Read、**DNS** → Edit、**Workers Routes** → Edit | 只有绑定自定义域名才需要     |

不想逐项勾就用 `Edit Cloudflare Workers` 预设模板。验证权限：

```bash
npx -y cfpilot-deploy@latest token --check --zone example.com
```

### 一个 KV 只能装一个实例

内核在 KV 里用的键是全局平铺的（`CONFIG` / `PANEL_PATH` / `SESSION:*` …），没有实例前缀。
两个实例共用一个 KV 会互相覆盖 UUID、WS 路径和面板密码 —— 所以向导写入前会校验归属，
目标 KV 属于别的实例时**直接中止**。

- 首次部署：自动新建 KV

- 更新实例：自动探测到唯一的实例并复用（UUID 与 WS 路径不变，订阅地址不用改）

- 多实例：`--kv <命名空间ID>` 明确指定

### 数据面出站能力边界

| 目标类型                            | 能否打通                                   |
| ------------------------------- | -------------------------------------- |
| 普通站点（baidu / qq / amazon 等）     | ✅ 直连                                   |
| Cloudflare 网段目标                 | ✅ 内置第三方反代入口（面板可自配）                     |
| Google / YouTube / GitHub 等 443 | ✅ 内置假活检测会自动切反代；若不通建议配 SOCKS5/HTTP 代理落地 |

***

## 订阅接入

节点形态在面板「入站配置」里选，默认只下发 **VLESS + WebSocket**（兼容性最好）。

| 形态                        | 支持        |
| ------------------------- | --------- |
| VLESS + WS                | 全部客户端     |
| VLESS + XHTTP（stream-one） | 仅 Xray 内核 |
| Trojan + WS               | 全部客户端     |

> Clash / sing-box 内核不支持 XHTTP，订阅这两种格式时会自动跳过该形态。

### ECH（Encrypted Client Hello）

ECH 把 TLS ClientHello 里的真实 SNI 加密，隐藏你访问的是哪个域名。
**这是客户端侧的能力** —— 内核只负责把参数写进订阅，由支持 ECH 的客户端
（mihomo / Clash Verge、sing-box 1.13+、v2rayN）实际执行；客户端不支持时参数被忽略，不影响连接。

**默认关闭**，在面板「出站与抗封锁」页勾选「启用 ECH 加密」后保存即可。
没有自定义域名时客户端连的是 `*.pages.dev`，ECH 的实际收益有限。

***

## 常见问题

**Q：优选结果全是** **`-1`？**
按顺序查：① 是否绑了自定义域名；② 客户端 `sni` 与 `Host` 是否都指向你的域名；
③ 优选时 `--host` 是否和实际部署一致；④ 端口是否是 443 等 TLS 端口；
⑤ 跑优选时是否关了代理工具。

**Q：配了 SOCKS5 代理但不生效？**
检查这几项：① 代理地址是否可公网访问（`127.0.0.1` / `192.168.x` 这类地址数据面连不到）；
② 代理是否支持 TLS 1.3（HTTPS 代理需要）；③ 代理服务器是否有 **IPv4** 公网地址
（数据面的出站只支持 IPv4）。

**Q：面板打不开 / 404？**
面板路径是部署时随机生成的，向导终端里打印过。忘了可以用
`npx wrangler kv key get --binding KV PANEL_PATH` 查回。

**Q：XHTTP 节点连不上？**
需要 Xray 内核（`type=xhttp`、`mode=stream-one`），Clash / sing-box 请改用 WS 节点。

**Q：免费额度 CPU 超限？**
内核内置 Free CPU 预算保护，可在面板调低 `DLS` / `MAX_LATENCY` 阈值，或减少远程 CSV 行数。

**Q：想看「为什么这个目标连不上」？**
自研数据面提供完整诊断端点：

```bash
curl https://<数据面域名>/__diag
```

返回最近 20 条完整出站诊断（失败类型 / 原始错误 / 候选 / 修复建议）——
WebSocket close frame 装不下这些（且超长会被边缘静默丢弃），所以单独开了个口子。

***

## 技术实现

### 优选器：三阶真连接校验

传统工具借第三方 CDN 测速，扫出来的 IP 填进节点几乎全 `-1`。CFPilot 的做法是
**每一步都带着你自己的域名**：

| 阶段 | 手段                                           | 拦掉什么                                         |
| -- | -------------------------------------------- | -------------------------------------------- |
| 一  | 并发 TCP 初筛 + **TLS 握手耗时排序**（候选按网段可用率加权采样）     | 连不上的 IP、握手慢的 IP                              |
| 二  | **WS 101 握手 + PING/PONG 响应体校验**              | Enterprise 专属 IP、SNI 阻断、「101 通但数据面不响应」的假活 IP |
| 三  | 仅对通过前两阶的 IP 请求 `/__edge_probe?bytes=N` 测真实下行 | —                                            |

为什么阶段一要单独测 TLS 握手：真机实测 TCP 延迟集中在 8~~40ms（无区分度），
而 TLS 握手耗时 768ms~~3531ms（相差 4.6 倍），**两者相关系数接近 0** ——
TCP 9ms 的 IP 握手可能要 3.5 秒，客户端超时就是 `-1`。

为什么候选要按可用率加权：Cloudflare 的 IPv4 空间大部分是区域/租户专用分配，
真机实测 6 个官方网段 **0% 可用**。按网段大小平均分配预算会让一半以上候选来自这些废段。

### 数据面

单一自研实现，无第三方内核依赖（产物 43KB）。

| 能力       | 支持情况                               |
| -------- | ---------------------------------- |
| 入站协议     | VLESS-WS / Trojan-WS / VLESS-XHTTP |
| 出站代理池    | SOCKS5 / HTTP / HTTPS 全支持          |
| DoH 优选解析 | 可开关                                |
| 反代入口     | 用户可自配 + 内置表                        |
| 故障诊断     | 失败分级 + `GET /__diag` 查看完整原因        |

### 仓库结构

```text
CFPilot/
├── HANDOVER.md            # 交接文档：真机结论与决策记录
├── AGENTS.md              # 开发规范（本地文件，不入库）
└── packages/
    ├── worker-core/       # 边缘内核 + 中文面板（Pages 产物）
    ├── scanner-cli/       # cfpilot-scanner —— 本地真连接优选器（npm 包）
    ├── deploy-wizard/     # cfpilot-deploy —— 全中文部署向导（npm 包）
    ├── ui/                # 界面源码（单一来源，Go 版复用）
    └── desktop/           # Go 桌面版（单二进制 + 托盘）
```

> 界面源码独立在 `packages/ui`：Go 版构建时把它的产物 `go:embed` 进 exe，
> 保证「一份界面、一处维护」。Electron 外壳已移出仓库（本地保留用于实验）。

更多实现细节（协议格式、出站选路、DoH 判定、TLS 约束等）见
[HANDOVER.md](HANDOVER.md) 的真机取证与决策记录。

***

## 配置项与环境变量

优先级：**KV(`CONFIG`) > 环境变量 > 内置默认值**。

### 常用环境变量

| 变量                                             | 说明                                                       |
| ---------------------------------------------- | -------------------------------------------------------- |
| `UUID`                                         | VLESS UUID                                               |
| `WS_PATH`                                      | WebSocket 路径（**值要带前导斜杠**；`PATH` 是 Pages 保留名，别用）          |
| `TROJAN_PASSWORD`                              | Trojan 密码                                                |
| `ENABLE_TROJAN` / `ENABLE_XHTTP`               | 入站开关                                                     |
| `DATA_HOST`                                    | 数据面域名（拆分部署时控制面用它生成订阅）                                    |
| `PANEL_PATH` / `PANEL_PASSWORD`                | 面板路径与初始密码                                                |
| `PROXYIP`                                      | ProxyIP 池（按直连落地语义解析）                                     |
| `SOCKS5` / `HTTP_PROXY`                        | 落地代理（仅自研数据面）。`https://` 前缀表示代理本身走 TLS，可用 `#sni=域名` 指定握手名 |
| `NAT64`                                        | NAT64 前缀，如 `64:ff9b::`                                   |
| `RELAY_POOL` / `USE_BUILTIN_RELAY`             | 自定义反代入口池 / 内置表开关                                         |
| `RESOLVE_PREFERRED`                            | 出站前自动 DoH 解析优选 IP（默认开）                                   |
| `SUB_VARIANTS`                                 | 下发的节点形态，逗号分隔，默认 `vless-ws`                               |
| `OFFICIAL_IP_COUNT` / `PREFERRED_DOMAIN_COUNT` | 内置来源数量（默认 20 / 10）                                       |
| `DLS` / `MAX_LATENCY`                          | 订阅池的最低速度 / 最高延迟阈值                                        |

### 常用 KV 键

| 键                     | 内容                                          |
| --------------------- | ------------------------------------------- |
| `CONFIG`              | 用户配置 JSON（含 uuid / wsPath / trojanPassword） |
| `CFP_DEPLOY_MANIFEST` | 部署清单，**判断 KV 归属的唯一依据**                      |
| `LOCAL_PREFERRED_IPS` | 本地优选结果                                      |
| `SCANNER_TOKEN`       | 扫描回填令牌                                      |

### scanner 常用参数

| 参数                     | 默认       | 说明                                                 |
| ---------------------- | -------- | -------------------------------------------------- |
| `--host`               | 必填       | 你的域名（作为 SNI / Host）                                |
| `--path`               | `/vless` | 目标项目的 WS 路径                                        |
| `--sample`             | `6556`   | 候选采样数                                              |
| `--top`                | `15`     | 返回条数                                               |
| `--countries`          | —        | 机房国家筛选，如 `HK,JP,SG`                                |
| `--token`              | —        | 回填令牌（不填则只输出不回填）                                    |
| `--no-verify`          | —        | 只做 101 握手，跳过响应体校验（对接非 CFPilot 项目时用）                |
| `--speed-mode`         | `auto`   | `probe`（走目标探针端点，最忠实）/ `url`（公开测速地址，任何项目可用）/ `auto` |
| `--cidr` / `--ip-file` | —        | 自定义网段 / 本地 IP 列表                                   |

完整参数见 `npx -y cfpilot-scanner@latest scan --help`。

***

## 免责声明

**本项目仅作学习交流使用**，用于查找资料、学习网络知识，**不鼓励、不支持任何违法行为**。

- 项目中涉及的所有方法与技术均来自互联网公开资料，仅供交流学习；

- 使用者需自行遵守所在地法律法规与 Cloudflare 服务条款（尤其是 Free 套餐的流量与 CPU 限制），并对自身使用行为负全部责任；

- 任何人因使用本项目产生的任何后果（包括但不限于账号封禁、服务中断、法律责任），**本项目及作者概不负责**；

- 如有侵权或不当之处，请联系仓库 issue / PR，将第一时间处理。

***

## License

[MIT](LICENSE)
