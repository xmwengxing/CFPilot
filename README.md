# CFPilot（CP面板）

> Cloudflare Workers 代理微内核 · 真连接优选面板 · 一键部署
> MIT License · 架构设计参考 [CFNext](https://github.com/PAICNI/CFNext)项目

CFPilot 把「代理内核 + 优选订阅 + 本地真连接优选 + 中文部署向导」整合成一套方案，
核心目标是解决 Cloudflare 代理最常见的那类故障：**本地优选测速几百兆，客户端却全是 `-1`**。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
- [图形化工具（Windows）](#图形化工具windows)
- [技术约束](#技术约束)
- [仓库结构](#仓库结构)
- [面板说明](#面板说明)
- [cfpilot-scanner：本地真连接优选器](#cfpilot-scanner本地真连接优选器)
- [cfpilot-deploy：全中文部署向导](#cfpilot-deploy全中文部署向导)
- [订阅接入](#订阅接入)
- [配置项与环境变量](#配置项与环境变量)
- [常见问题](#常见问题)
- [免责声明](#免责声明)

---

## 它解决什么问题

传统「优选 IP」工具用 `cdn.cloudflare.com` / `speed.cloudflare.com` 之类的第三方 CDN 测速，
扫出来的 IP 填进节点后客户端几乎全是 `-1`。根因通常有 5 个：

| # | 根因 | 说明 |
|---|------|------|
| 1 | Enterprise 专属 IP | 能跑满带宽，但你的 **Free 套餐 Worker 自定义域名** 在这些 IP 上没有路由权限，直接 403 / Error 1003 |
| 2 | SNI / Upgrade 定向阻断 | TCP 握手能通、TLS 也能通，但 `SNI` 是陌生域名或请求带 `Upgrade: websocket` 时被丢包 / RST |
| 3 | 未绑定自定义域名 | 直接用 `*.workers.dev` / `*.pages.dev`，该域名特征被主干网识别，换任何 IP 都在握手阶段超时 |
| 4 | 端口协议错配 | 扫的是 `80` 端口，节点却按 `443 TLS` 使用 |
| 5 | 脏数据 | CSV 原文直填、IPv6 未加方括号，订阅解析崩溃 |

CFPilot 的解法是**「三阶真连接握手校验」**：

```
阶段一  并发 TCP 初筛 + TLS 握手筛选（候选按网段可用率加权采样）
                                       →  过滤掉根本连不上的 IP，
                                         并优先保留 TLS 握手快的 IP
阶段二  WS 101 握手 + 响应体内容校验（发 PING 验 PONG）
         用【你自己的 Worker 域名】作为 TLS SNI 与 HTTP Host
                                       →  拦掉「101 通但数据面不响应」的假活 IP
阶段三  仅对通过两层校验的 IP 请求 /__edge_probe?bytes=5MB
                                      →  在自己的域名下测真实下行速度，不再借用第三方 CDN
```

Worker 内核内置 `/__edge_probe` 端点，因此**优选结果 100% 对应你自己的域名**。

### 为什么阶段一要测 TLS 握手

真机实测（电信千兆，多个网络环境结论一致）：**TCP 延迟集中在 8~40ms，
几乎没有区分度；而 TLS 握手耗时从 768ms 到 3531ms，相差 4.6 倍，
两者相关系数接近 0** —— TCP 9ms 的 IP，握手可能要 3.5 秒。

客户端建立连接必须做完整 TLS 握手。只按 TCP 延迟排序会选出一批
「TCP 快但 TLS 慢」的 IP，导入客户端后大面积 `-1`。
因此阶段一以 **TLS 握手耗时为主排序键**，TCP 延迟只作次键。

> 这也是候选采样数建议 **3000 起**的原因：握手快慢与 TCP 延迟几乎无关，
> 采样小了根本碰不到握手快的 IP。
>
> 另外 Cloudflare 的 IPv4 空间大部分是区域/租户专用分配 ——
> 真机实测 6 个官方网段 0% 可用，因此候选会**按网段可用率加权采样**
> （0% 可用的网段直接不采）。加权后有效候选密度更高，3000 采样通常能选出 100+ 个可用 IP。

---

## 快速开始

```bash
# 1. 部署（需要 Cloudflare API Token）
npx -y cfpilot-deploy@latest init

# 2. 本地优选（需要 Node.js 18+）
npx -y cfpilot-scanner@latest --host "你的Worker域名" --token "面板里生成的令牌"

# 3. 导入订阅
#    面板首页会给出 Base64 / Clash / Sing-box 三种订阅地址
```

> **订阅格式按 User-Agent 自动识别**，导入时不用手动加参数：
> Clash Verge / Clash / mihomo 拿到 **YAML**，
> sing-box 拿到 **JSON**，
> v2rayN / Shadowrocket / NekoBox 等拿到 **Base64 分享链接**。
> 也可以显式指定：`?target=clash` / `?target=singbox` / `?target=base64`。

`cfpilot-deploy` 会自动完成：

- 校验 API Token 权限
- 选择账号
- 生成随机化 Worker 名称
- **自动创建并绑定 KV 命名空间**（不用手动点控制台）
- 生成随机面板路径、管理密码、扫描令牌
- 上传内核并绑定自定义域名（失败时自动回退到 Route 方式）

部署完成后终端会输出：

```
  面板地址   ：https://cfpilot.example.com/p-a1b2c3d4
  管理密码   ：cfp-xxxxxxxxxxxxxx
  订阅地址   ：https://cfpilot.example.com/sub/<UUID>
```

> ⚠️ **务必绑定自定义域名**。`workers.dev` 域名在部分网络环境下会被直接阻断，
> 优选再准也救不回来。

---

## 图形化工具（Windows）

不想碰终端的话，用图形版：

1. 到 [Releases](https://github.com/xmwengxing/CFPilot/releases) 下载
   `CFPilot-<版本>-x64.exe`（安装版）或 `CFPilot-<版本>-portable.exe`（便携版）
2. 双击运行，**不需要预先安装 Node.js**
3. 在「Cloudflare 凭据」页填 API Token 并保存 → 点「检测账号」→ 点「刷新 KV 列表」
4. 在 KV 下拉框里选一个（带 ● 的是你已有的实例，空的可用于部署新实例），点「开始部署」
5. 在「本地真连接优选」页点「**自动识别域名**」填入数据面域名
   （有自定义域名优先填它，没有才填 pages.dev），填上 WS 路径，
   需要按国家筛选时在多选框里选（不选 = 全量），跑一次优选，把结果粘贴到面板的「手动优选 IP」

界面分四个页签：凭据 / 部署 / 优选 / 说明，下方是常驻运行日志。
优选页端口固定 **443**（Pages 的 HTTPS 入口；2053 等端口在部分网络会被阻断，故不提供选择）。

**令牌只保存在本机** `~/.cfpilot-gui/secrets.json`，不会上传，也不随安装包分发。
详见 [packages/gui/README.md](packages/gui/README.md)。

---

## 技术约束

部署前请了解以下平台限制，它们决定了本项目的部署形态与能力边界。

### 部署形态：控制面与数据面分离

内核拆成两个可独立部署的产物：

| 产物 | 内容 | 用途 |
|------|------|------|
| `dist/control.js` | 面板 + 订阅 + 优选池 + 探针 | 管理界面，**不含出站拨号代码** |
| `dist/dataplane.js` | VLESS / Trojan-WS 代理入站 | 客户端实际连接的转发层 |

两者共用同一个 KV 命名空间，面板改配置对数据面立即生效。控制面通过 `DATA_HOST`
环境变量指定数据面域名，生成订阅时用它作为节点地址。

```bash
# 首次部署：自动新建 KV 命名空间
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --yes

# 更新已有实例：自动探测到唯一的实例并复用（UUID 与 WS 路径不变，订阅地址不用改）
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --yes

# 查看账号下已有哪些实例
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --list-kv

# 部署第二个实例：新建独立 KV
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --new-kv --yes

# 账号下有多个实例时，用 --kv 明确指定要部署哪一个
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --kv <命名空间ID> --yes

# 改用 CFNext 原版数据面（默认已是自研）
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --dataplane vendor --yes

# 关闭出站前的自动 DoH 解析优选 IP（只用手工配置的优选 IP）
npx -y cfpilot-deploy@latest pages-split --account <账号ID> --resolve-preferred=false --yes
```

部署完成后两个项目都能原地更新。

> **一个 KV 命名空间只能承载一个 CFPilot 部署实例。**
> 内核在 KV 里用的键是全局平铺的（`CONFIG` / `PANEL_PATH` / `SESSION:*` …），没有实例前缀，
> 两个实例共用一个 KV 会互相覆盖 UUID、WS 路径与面板密码。
> 因此向导在写入前会校验归属：目标 KV 若属于另一个实例，**部署会被中止**并提示新建。
> 这是有意为之——写坏别人的线上项目比部署失败严重得多。

### Pages 通道的三条规则

1. **顺序不能反**：先建项目 → 设环境变量 / 绑 KV → **最后才部署**。
   Pages 的绑定与变量只对**之后的**部署生效，先部署再配置等于白配。
2. **合并包在同一个项目上重复部署可能被平台拒绝**。因此升级内核时请新建项目，
   或直接使用上面的拆分部署（两个项目都能原地更新）。
3. 带哈希的部署 URL（`<hash>.<project>.pages.dev`）需要认证，
   请始终使用项目主域 `<project>.pages.dev` 或已绑定的自定义域名。

### 出站拨号依赖 `cloudflare:sockets`

数据面的出站 TCP 依赖该内置模块。不同 Cloudflare 账号 / 区域下它的可用性存在差异，
若部署后代理不可用，建议先用一个最小 Worker 验证 `connect()` 是否能正常建立连接，
再排查本项目代码。

### 数据面实现说明

数据面的 WebSocket 入站有两套实现，通过数据面环境变量 `DATAPLANE` 选择：

| 实现 | 说明 | 代理池 | DoH 优选 IP | 反代入口 |
|------|------|--------|------------|---------|
| **self**（默认） | 本项目自研，失败可诊断，见 [docs/self-developed-dataplane-design.md](docs/self-developed-dataplane-design.md) | ✅ SOCKS5 / HTTP / HTTPS 全部支持 | ✅ `RESOLVE_PREFERRED=false` 可关闭 | ✅ 用户可自配，`USE_BUILTIN_RELAY=false` 可关内置表 |
| **vendor** | 复用 [CFNext](https://github.com/PAICNI/CFNext) 的 `wsHandler`（源码见 `packages/worker-core/src/vendor/`） | ⚠️ **只有 `PROXYIP` 生效**，SOCKS5 / HTTP 代理池不会传进去 | ✅（vendor 内部实现） | ⚠️ 只能用硬编码的第三方表 |

切换方式：部署时加 `--dataplane vendor`，或直接在数据面项目设置环境变量 `DATAPLANE=vendor`。

> **2026-10-23 起默认改为自研**：同环境对照实验（真实 Cloudflare、真实 TLS 客户端首包、
> 交替采样）确认两者可用性持平 —— 非 Cloudflare 网段目标均 100%，
> Cloudflare 网段目标自研 67%~100%、vendor 73%~100%（第三方反代池本身波动）。
> 自研另有失败分级诊断、完整代理池、可配置反代入口等能力。

#### 出站诊断端点（自研专有）

自研数据面提供 `GET /__diag`，返回最近 20 条**完整**的出站诊断
（失败类型 / 原始错误 / 候选 / 多行修复建议）：

```bash
curl https://<数据面域名>/__diag
```

```json
{
  "ok": true,
  "impl": "self",
  "recent": [{
    "at": 1792728772297,
    "target": "example.com:443",
    "failures": [{ "kind": "blocked", "message": "...", "candidate": "直连 example.com:443" }],
    "summary": "出站被 Cloudflare 拒绝（...）：...\n  常见原因：...\n  → 换一个第三方 IP，或改用代理落地。"
  }]
}
```

> 为什么需要它：WebSocket close frame 的 reason 最多 123 字节，装不下完整诊断；
> 超长还会被 Cloudflare 边缘**静默丢弃整个 close frame**。
> vendor 则把异常吞成「目标不可达」，什么都不留。

---

## 仓库结构

```text
CFPilot/
├── AGENTS.md                     # 架构铁律与编码规范
├── packages/
│   ├── worker-core/              # @cfpilot/worker-core —— 边缘内核 + 中文面板
│   ├── scanner-cli/              # cfpilot-scanner —— 本地真连接优选器（npm）
│   ├── deploy-wizard/            # cfpilot-deploy —— 全中文部署向导（npm）
│   └── gui/                      # @cfpilot/gui —— 图形化部署与维护工具（Electron）
```

### worker-core（Worker 内核）

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 路由分发：探针 / 面板 API / 订阅 / 面板 / 代理入站 |
| `src/routes/control.ts` | 控制面路由（面板 + 订阅 + 探针） |
| `src/routes/data.ts` | 数据面路由（代理入站） |
| `src/protocols/vless.ts` | VLESS 协议头解析（UUID 校验、命令、地址） |
| `src/protocols/trojan.ts` | Trojan 协议头解析（SHA224 口令，地址类型编号与 VLESS 不同） |
| `src/protocols/xhttp.ts` | VLESS + XHTTP（stream-one）入站：一个 POST 请求承载上下行 |
| `src/protocols/sha224.ts` | 纯 TS 的 SHA-224（WebCrypto 不支持，Trojan 口令校验必需） |
| `src/outbound/dial.ts` | 出站拨号：并发竞速、ProxyIP 故障转移、NAT64 合成 |
| `src/outbound/route.ts` | 出站选路：CF 网段降权、代理/直连分组、失败分级诊断 |
| `src/outbound/doh.ts` | DoH 解析优选 IP（TXT 优选库 → A → AAAA，严格判定 + 缓存） |
| `src/outbound/socks5.ts` / `http-proxy.ts` | SOCKS5 与 HTTP CONNECT 落地代理 |
| `src/protocols/websocket-self.ts` | 自研 WS 数据面（`DATAPLANE=self` 时启用） |
| `src/sub-engine.ts` | 优选池合并 + 脏数据清洗 + Base64/Clash/Sing-box 输出 |
| `src/probe.ts` | `/__edge_probe`：WS 101 握手 + 流式下行测速 |
| `src/auth.ts` | 面板密码 + KV 会话 + 一次性扫描令牌 |
| `src/ui/panel.html` | 内嵌中文管理面板（单文件、零框架） |

---

## 面板说明

面板路径是部署时生成的随机路径（形如 `/p-a1b2c3d4`），配合密码 + HttpOnly 会话 Cookie 使用。

| 页签 | 能做什么 |
|------|----------|
| **概览** | Worker 域名、边缘机房、本地优选 IP 数量、当前订阅的来源构成 |
| **节点来源** | 三个可勾选来源：**官方优选 IP**（数量 + 国家/机房多选）、**优选域名**（数量 + 自定义域名库）、**手动优选 IP**（本地真连接池 + 手填）。三源全不勾时自动 20+10；底部内嵌一键本地真连接优选 |
| **订阅** | 三种订阅地址一键复制 + 节点预览（按来源分组） |
| **入站配置** | UUID、Trojan 密码、三条路径、订阅域名/协议/传输方式 |
| **高级** | ProxyIP 池、SOCKS5/HTTP/HTTPS 代理、自定义反代入口池 + 内置表开关、NAT64、并发竞速拨号、自动 DoH 解析优选 IP、客户端指纹、远程 `ADDAPI` / `ADDCSV` 池 |
| **入站配置** | 订阅下发的**节点形态**（VLESS+WS / VLESS+XHTTP / Trojan，可多选，默认只勾 VLESS+WS）、Trojan / XHTTP 入站开关、WS / Trojan / XHTTP 路径 |

> **节点形态选择**：订阅里每个节点会按勾选的形态各生成一份。
> 默认只勾 VLESS+WebSocket，节点数与优选池一致；
> 勾选多种才会展开成多份。
> XHTTP 形态只有 Xray 内核支持，Clash / mihomo / sing-box 不认这个传输 ——
> 用这些客户端订阅时会自动跳过 XHTTP 形态。
> 对应的入站没启用时（如 XHTTP 入站关闭），该形态也不会出现在订阅里。

### 优选池的三个内置来源

| 来源 | 数据从哪来 | 说明 |
|------|-----------|------|
| 官方优选 IP | CF 官方 IPv4 网段，请求时随机抽样 | Cloudflare 的 IP 是 anycast，静态表必然过期，所以按需随机生成 |
| 优选域名 | 内置社区公开优选域名，随机取样 | 域名只负责解析出好 IP，`sni` / `Host` 仍是你的 Worker 域名 |
| 手动优选 IP | 本地真连接扫描结果（KV `LOCAL_PREFERRED_IPS`）+ 面板手填 | 优先级最高，因为它是**在你自己的域名上验证过 101 握手**的 IP |

> **关于「国家」筛选**：CF 的 anycast IP 本身没有国家归属，机房要连接后才知道。
> 因此国家筛选只能作用于「已知机房」的条目（本地扫描结果、带机房标注的远程池）；
> 随机生成的官方 IP 机房未知，选了国家后会被排除——想按国家筛，请先跑一次本地优选。
> 三源全不勾选时会自动生成 **20 个官方优选 IP + 10 个优选域名**，订阅不会为空。

---

## cfpilot-scanner：本地真连接优选器

> ⚠️ **运行前请关闭所有代理工具**（Clash / Mihomo / v2rayN / sing-box / Surge 等），
> 包括 **TUN 模式**与**系统代理**。
>
> 优选测的是「本机直连该 IP」的真实质量。流量一旦被代理接管，测出来的就是
> 到代理的延迟而不是到目标 IP 的延迟 —— 结果看起来正常，但所有 IP 成绩趋于一致，
> **导入客户端后大量 -1**。
>
> 工具会在扫描前自动检测（本地代理端口 / 系统代理 / fake-ip DNS）并打印提醒，
> 但不会阻断扫描。如果必须开着代理，请把本程序加入直连/绕过名单。

### 直跑模式

```bash
npx -y cfpilot-scanner@latest scan --host "cfpilot.example.com" --path /vless --no-callback
```

结果会附上一段可直接复制的输出，方便粘贴到同类项目的自定义 IP 输入框：

```
104.17.242.168:443#LAX
104.19.73.179:443#LAX
104.16.59.243:443#LAX
```

对接任意 VLESS-WS 项目时，用 `--path` 指定它的 WS 路径即可，不依赖 CFPilot 自己的探针端点。
路径**必须与实际一致**（CFNext 常见是 `/vless` 或 UUID，有些项目是根路径 `/`），
填错不会产生假结果，只会一个都选不出来。

### 测速支持任意项目

测速**只对通过两层校验的 IP 生效** —— 这是避免「速度快但导入客户端全是 -1」的关键。

| 测速方式 | 适用 | 说明 |
|---------|------|------|
| `probe` | 目标有 CFPilot 探针端点 | 走项目自身路径，最忠实 |
| `url` | **任何项目** | 公开测速地址，用候选 IP 拨号下载 |

默认 `--speed-mode auto` 会自动选择，**因此对接第三方项目时速度不再永远是 0**。

测速精度上做了三件事：取**滑动窗口峰值**（丢弃 TCP 慢启动样本，
实测同一 IP 峰值 51.7 MB/s 而总平均仅 16.4 MB/s）、默认 **3 条并发连接**、
以及**测速地址可用性预检**。

### 桥接模式（面板一键调用）

```bash
npx -y cfpilot-scanner@latest serve
```

在 `127.0.0.1:19527` 启动本地服务，提供：

| 接口 | 说明 |
|------|------|
| `GET /status` | 面板探测是否在线 |
| `POST /start-scan` | 下发扫描任务 |
| `GET /events` | SSE 实时进度（`stage` / `progress` / `result` / `done` / `error`） |
| `GET /results` | 最近一次结果 |

### 常用参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--host` | 必填 | 你的 Worker 自定义域名（作为 SNI / Host） |
| `--path` | `/vless` | 目标项目的 WS 路径 |
| `--port` | `443` | 端口 |
| `--token` | — | 回填令牌（面板生成的一次性令牌，10 分钟有效） |
| `--callback` | `https://<host>/api/v1/preferred-ips` | 回填地址 |
| `--no-callback` | — | 只扫描不回填 |
| `--top` | `15` | 返回条数 |
| `--sample` | `20000` | 候选 IP 采样数（按地址族分别分配预算，小样本时严格按比例收敛） |
| `--countries` | — | 机房国家筛选，逗号分隔（如 `HK,JP,SG`）。只作用于已通过两层校验的候选；不传 = 全量 |
| `--cidr` | — | 自定义网段（逗号分隔） |
| `--ip-file` | — | 使用本地 IP 列表文件 |
| `--max-latency` | `0` | 阶段一延迟上限（ms） |
| `--no-verify` | — | 阶段二只做 101 握手，跳过响应体内容校验（对接非 CFPilot 项目时用） |
| `--probe-limit` | `120` | 进入 101 校验的候选数 |
| `--speed-limit` | `30` | 进入测速的候选数 |
| `--seed` | `24301` | 采样随机种子（同种子结果可复现） |

---

## cfpilot-deploy：全中文部署向导

```bash
npx -y cfpilot-deploy@latest init                              # Worker 单项目
npx -y cfpilot-deploy@latest pages-split                       # Pages 双项目（推荐）
npx -y cfpilot-deploy@latest token --token <API_TOKEN>        # 仅校验 Token
npx -y cfpilot-deploy@latest token --check --zone example.com # 逐项探测权限
```

### API Token 权限

在 [Cloudflare 控制台 → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
创建自定义 Token，按下面勾选。

**必需（两种部署方式都要）**

| 分类 | 权限项 | 用途 |
|---|---|---|
| Account | **Account Settings** → Read | 读取账号列表 |
| Developer Platform | **Workers KV Storage** → Edit | 创建 KV、读写配置 |
| Developer Platform | **Workers Scripts** → Edit | 上传内核、开 workers.dev 路由、开 Workers Logs |

**`pages-split` 额外需要**

| 分类 | 权限项 | 用途 |
|---|---|---|
| Developer Platform | **Pages** → Edit | 创建项目、配置变量、触发部署 |

**只有绑定自定义域名才需要**（只用 `*.pages.dev` / `*.workers.dev` 可跳过）

| 分类 | 权限项 | 用途 |
|---|---|---|
| Zone | **Zone** → Read | 列出账号下的域名供选择 |
| Zone | **DNS** → Edit | 检测冲突记录、创建 CNAME |
| Zone | **Workers Routes** → Edit | 自定义域名不可用时降级 Route + CNAME |

> 控制台新版把权限按「Developer Platform / Zone / DNA & Zone」分类。
> 其中 **DNA & Zone** 分类下的 Account DNS Settings、DNS Firewall、DNS View、
> Registrar Domains、Registrar Sandbox Domains 本项目**都不需要**——
> 它们分别管账号级 DNS 默认设置、DNS 防火墙规则、内部 DNS 视图和域名注册。

**不想逐项勾选**：可以直接用 `Edit Cloudflare Workers` / `Edit Cloudflare Pages`
这类预设模板，权限范围更大但能跑通。

**验证权限是否够**：

```bash
npx -y cfpilot-deploy@latest token --check --zone example.com
```

会逐项探测并输出「权限项 / 状态 / 缺失后果」。

---

## 订阅接入

| 客户端 | 订阅类型 |
|--------|----------|
| Clash Verge / Mihomo / FlClash | `?target=clash` |
| sing-box 1.12+ | `?target=singbox` |
| v2rayNG / Hiddify / Nekoray | `?target=base64` |

生成节点的关键约定：

- `server` = 优选出来的 **IP**
- `sni` / `servername` / `Host` = **你的 Worker 域名**（固定不变）
- 端口 = `443`（Cloudflare 支持的 TLS 端口：`443 / 2053 / 2083 / 2087 / 2096 / 8443`）

> Clash / Sing-box 内核目前不支持 XHTTP 传输，这两种格式只输出 WebSocket 节点；
> Base64 分享链接会同时包含 `type=ws` 与 `type=xhttp&mode=stream-one` 两种。

---

## ECH（Encrypted Client Hello）

ECH 让客户端把 TLS ClientHello 里的真实 SNI 加密，隐藏你访问的是哪个域名。

**这是客户端侧的能力**：CFPilot 内核只负责把 ECH 参数写进订阅，
由支持 ECH 的客户端（mihomo / Clash Verge、sing-box 1.13+、v2rayN 等）实际执行。
客户端不支持时该参数会被忽略，不影响连接。

**默认关闭。** 在面板「出站与抗封锁」页勾选「启用 ECH 加密」后保存即可：

| 字段 | 说明 | 默认 |
|------|------|------|
| ECH 服务器名 | 对外隐藏的 SNI | `cloudflare-ech.com` |
| ECH DNS | 解析 ECH 配置用的 DoH | 留空用客户端默认 |

开启后订阅里会出现：

- **Clash / mihomo**：每个节点带 `ech-opts: { enable: true, query-server-name: … }`，
  并在 `dns.nameserver-policy` 里把 ECH 服务器名指向 DoH
- **Base64 分享链接**：URL 带 `&ech=<SNI>+<DoH>`（沿用 edgetunnel 的约定）
- **Sing-box**：出站 `tls.ech = { enabled: true, query_server_name: … }`

> ECH 需要客户端能通过 DoH 查到目标域名的 ECH 记录。
> 没有自定义域名时，客户端连的是 `*.pages.dev`，ECH 的实际收益有限。

---

## 配置项与环境变量

优先级：**KV(`CONFIG`) > 环境变量 > 内置默认值**。

| 环境变量 | 对应配置 | 说明 |
|----------|----------|------|
| `PANEL_PASSWORD` | — | 面板初始密码（首次启动后写入 KV 哈希） |
| `PANEL_PATH` | — | 面板路径（不设则随机生成） |
| `SCANNER_TOKEN` | — | 扫描回填令牌 |
| `DATA_HOST` | — | 数据面域名（拆分部署时控制面用它生成订阅） |
| `UUID` | `uuid` | VLESS UUID |
| `WS_PATH` / `PATH` | `wsPath` | WebSocket 路径 |
| `TROJAN_PASSWORD` | `trojanPassword` | Trojan 密码 |
| `ENABLE_TROJAN` / `TROJAN` | `enableTrojan` | 是否启用 Trojan 入站 |
| `ENABLE_XHTTP` / `XHTTP` | `enableXhttp` | 是否启用 XHTTP 入站 |
| `ECH` | `ech` | 是否在订阅节点里启用 ECH（客户端侧能力，默认关闭） |
| `ECH_HOST` | `echHost` | ECH 查询用服务器名（默认 `cloudflare-ech.com`） |
| `ECH_DNS` | `echDns` | 自定义 ECH DNS（DoH 地址，留空用客户端默认） |
| `PROXYIP` | `proxyIp` | ProxyIP 池（`host:port`，按直连落地语义解析） |
| `SOCKS5` | `socks5` | SOCKS5 代理（仅自研数据面生效） |
| `HTTP_PROXY` | `httpProxy` | HTTP 代理（仅自研数据面生效）。支持 `https://` 前缀表示**代理服务器本身走 TLS**；可用 `#sni=域名` 显式指定 TLS 握手用的 SNI（代理地址只能写 IP 时用） |
| `NAT64` | `nat64` | NAT64 前缀，如 `64:ff9b::` |
| `DATAPLANE` | — | 数据面实现：`self`（默认，自研）/ `vendor`（CFNext 原版） |
| `RESOLVE_PREFERRED` | `resolvePreferred` | 出站前自动 DoH 解析优选 IP（仅自研数据面，默认开启） |
| `RELAY_POOL` | `relayPool` | 自定义反代入口池，每行一条（`IP` / `IP:端口` / `域名`） |
| `USE_BUILTIN_RELAY` | `useBuiltinRelay` | 是否启用内置反代入口表（仅自研数据面，默认开启） |
| `SUB_VARIANTS` | `subVariants` | 订阅下发的节点形态，逗号分隔（`vless-ws` / `vless-xhttp` / `trojan`），默认 `vless-ws` |
| `ADD` | `add` | 手动优选池 |
| `ADDAPI` | `addApi` | 远程 TXT 接口 |
| `ADD_CSV` | `addCsv` | 远程 CSV |
| `OFFICIAL_IP` | `poolOfficial` | 是否启用内置「官方优选 IP」 |
| `OFFICIAL_IP_COUNT` | `officialCount` | 官方优选 IP 数量（默认 20，上限 200） |
| `PREFERRED_DOMAIN` | `poolDomain` | 是否启用内置「优选域名」 |
| `PREFERRED_DOMAIN_COUNT` | `domainCount` | 优选域名数量（默认 10，上限 100） |
| `MANUAL_IP` | `poolManual` | 是否启用手动优选 IP（本地池 + `ADD`） |
| `POOL_COUNTRIES` | `poolCountries` | 国家 / 地区筛选，如 `HK,JP,SG` |
| `DLS` | `dls` | 最低下载速度（MB/s） |
| `MAX_LATENCY` | `maxLatency` | 最高延迟（ms） |
| `TCP_CONCURRENT_DIAL` | `concurrentDial` | 并发竞速拨号 |

KV 键：

| 键 | 内容 |
|----|------|
| `CONFIG` | 用户配置 JSON（含部署凭据 uuid / wsPath / trojanPassword） |
| `CFP_DEPLOY_MANIFEST` | 部署清单：项目名、域名、版本、凭据。**判断 KV 归属的唯一依据** |
| `LOCAL_PREFERRED_IPS` | 本地真连接优选结果（每行一条） |
| `POOL_DOMAIN_LIBRARY` | 面板里自定义的优选域名库（每行一个；空 = 用内置库） |
| `SCANNER_TOKEN` | 长期扫描令牌 |
| `PANEL_PATH` / `ADMIN_PW_HASH` | 面板路径与密码哈希 |
| `SESSION:<token>` | 面板会话（24 小时） |
| `ONETIME:<token>` | 一次性扫描令牌（10 分钟） |

---

## 常见问题

**Q：面板打不开 / 404？**
面板路径是随机生成的，部署向导终端里会打印。如果忘了，可以用
`npx wrangler kv key get --binding KV PANEL_PATH` 查回。

**Q：优选结果全是 `-1`？**
按顺序排查：① 是否绑定了自定义域名；② 客户端里 `sni` 与 `Host` 是否都指向你的域名；
③ 优选时 `--host` 传的域名是否和实际部署一致；④ 端口是否为 443 等 TLS 端口。

**Q：XHTTP 节点连不上？**
XHTTP 需要客户端使用 Xray 内核（`type=xhttp`、`mode=stream-one`）。
Clash / sing-box 内核不支持 XHTTP，请改用 WS 节点。

**Q：数据面配了 SOCKS5 代理但不生效？**
默认的 vendor 数据面只读取 `PROXYIP`，面板里的 SOCKS5 / HTTP 代理池不会传进去。
切到自研数据面（`--dataplane self`）即可生效，详见[数据面实现说明](#数据面实现说明)。

**Q：HTTPS 代理（`https://` 前缀）连不上，报「TLS 握手失败」？**
Cloudflare 边缘的 TLS 握手**会校验证书链与主机名**，
而且运行时**不提供指定自有 CA 的入口**（只有 `expectedServerHostname` 用于 SNI 与主机名校验）。
所以 HTTPS 代理必须满足三条：

1. **用域名配置**（不能只写 IP）——证书是签给域名的，用 IP 连接会报
   `remote error: tls: bad certificate`；
2. **证书由公信 CA 签发** —— 自签证书必然报
   `remote error: tls: unknown certificate authority`；
3. **SNI 与证书里的域名一致**。

代理地址只能写 IP 时，用 `#sni=` 显式指定握手名：

```
https://user:pass@1.2.3.4:8443#sni=proxy.example.com
```

域名形式（`https://user:pass@proxy.example.com:8443`）会自动把域名用作 SNI。

> ⚠️ 这三条约束来自 2026-10-23 的真机实测，
> 详细取证见 [HANDOVER.md §0.20.13](HANDOVER.md)。

**Q：免费额度 CPU 超限？**
内核内置 Free CPU 预算保护（默认 8ms），会在订阅生成、CSV 解析等重活上提前中止。
可调低 `DLS`/`MAX_LATENCY` 阈值或减少 CSV 行数。

---

## 免责声明

**本项目仅作学习交流使用**，用于查找资料、学习网络知识，**不鼓励、不支持任何违法行为**。

- 项目中涉及的所有方法与技术均来自互联网公开资料，仅供大家交流学习使用；
- 使用者需自行遵守所在地法律法规与 Cloudflare 服务条款（尤其是 Free 套餐的流量与 CPU 限制），并对自身使用行为负全部责任；
- 任何人因使用本项目产生的任何后果（包括但不限于账号封禁、服务中断、法律责任），**本项目及作者概不负责**；
- 如有侵权或不当之处，请联系仓库 issue / PR，将第一时间处理。

---

## License

[MIT](LICENSE)