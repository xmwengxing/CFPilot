# CFPilot（CP面板）

> Cloudflare 代理微内核 · 真连接优选面板 · 一键部署
> MIT License · 架构设计参考 [CFNext](https://github.com/PAICNI/CFNext)

把「代理内核 + 优选订阅 + 本地真连接优选 + 中文部署向导」整合成一套方案，
解决 Cloudflare 代理最常见的那类故障：**本地优选测速几百兆，客户端却全是 `-1`**。

---

## 目录

- [快速开始](#快速开始)
- [图形化工具（Windows）](#图形化工具windows)
- [使用须知](#使用须知)
- [订阅接入](#订阅接入)
- [常见问题](#常见问题)
- [技术实现](#技术实现)
- [配置项与环境变量](#配置项与环境变量)
- [免责声明](#免责声明)

---

## 快速开始

三步走完，全程不需要手动点 Cloudflare 控制台。

### 1. 部署

```bash
npx -y cfpilot-deploy@latest init        # Worker 单项目
npx -y cfpilot-deploy@latest pages-split # Pages 双项目（推荐）
```

`init` 会依次引导你完成：填 API Token → 选账号 → 自动建 KV → 上传内核 → 绑定域名。
结束时会打印面板地址、管理密码、订阅地址，**存好它们**。

> ⚠️ **务必绑定自定义域名**。`*.workers.dev` / `*.pages.dev` 在部分网络环境下会被直接阻断，
> 优选再准也救不回来。

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

| 客户端 | 拿到的格式 |
|--------|-----------|
| Clash Verge / Clash / mihomo | YAML |
| sing-box | JSON |
| v2rayN / Shadowrocket / NekoBox | Base64 分享链接 |

也可以显式指定：`?target=clash` / `?target=singbox` / `?target=base64`。

节点的关键约定：`server` = 优选出的 **IP**，`sni` / `Host` = **你的域名**（固定），端口 = `443`。

---

## 图形化工具（Windows）

不想碰终端就用图形版：

1. 到 [Releases](https://github.com/xmwengxing/CFPilot/releases) 下载
   `CFPilot-<版本>-x64.exe`（安装版）或 `-portable.exe`（免安装）
2. 双击运行，**不需要预先装 Node.js**
3. 「Cloudflare 凭据」页填 API Token → 检测账号 → 刷新 KV 列表
4. 「部署」页选一个 KV → 开始部署
5. 「优选」页点「**自动识别域名**」填数据面域名 + WS 路径 → 开始优选 → 复制结果到面板

界面分四个页签：凭据 / 部署 / 优选 / 说明，下方是常驻日志。
「优选」页的一键优选通过本地桥接服务（`127.0.0.1:19527`）调用 scanner，**不需要单独开终端**。
令牌只存在本机 `~/.cfpilot-gui/secrets.json`，不上传。详见 [packages/gui/README.md](packages/gui/README.md)。

---

## 使用须知

### API Token 权限

在 [Cloudflare 控制台 → API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建自定义 Token：

| 分类 | 权限项 | 用途 |
|------|--------|------|
| Account | **Account Settings** → Read | 读取账号列表 |
| Developer Platform | **Workers KV Storage** → Edit | 建 KV、读写配置 |
| Developer Platform | **Workers Scripts** → Edit | 上传内核 |
| Developer Platform | **Pages** → Edit | `pages-split` 需要 |
| Zone | **Zone** → Read、**DNS** → Edit、**Workers Routes** → Edit | 只有绑定自定义域名才需要 |

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

| 目标类型 | 能否打通 |
|----------|----------|
| 普通站点（baidu / qq / amazon 等） | ✅ 直连 |
| Cloudflare 网段目标 | ⚠️ 需第三方反代入口（面板可自配） |
| Google / YouTube / GitHub 等 443 | ⚠️ Workers 出口可能「TCP 通但 0 字节」，内置假活检测会自动切反代；仍不通建议配 SOCKS5/HTTP 代理落地 |

---

## 订阅接入

节点形态在面板「入站配置」里选，默认只下发 **VLESS + WebSocket**（兼容性最好）。

| 形态 | 支持 |
|------|------|
| VLESS + WS | 全部客户端 |
| VLESS + XHTTP（stream-one） | 仅 Xray 内核 |
| Trojan + WS | 全部客户端 |

> Clash / sing-box 内核不支持 XHTTP，订阅这两种格式时会自动跳过该形态。

### ECH（Encrypted Client Hello）

ECH 把 TLS ClientHello 里的真实 SNI 加密，隐藏你访问的是哪个域名。
**这是客户端侧的能力** —— 内核只负责把参数写进订阅，由支持 ECH 的客户端
（mihomo / Clash Verge、sing-box 1.13+、v2rayN）实际执行；客户端不支持时参数被忽略，不影响连接。

**默认关闭**，在面板「出站与抗封锁」页勾选「启用 ECH 加密」后保存即可。
没有自定义域名时客户端连的是 `*.pages.dev`，ECH 的实际收益有限。

---

## 常见问题

**Q：优选结果全是 `-1`？**
按顺序查：① 是否绑了自定义域名；② 客户端 `sni` 与 `Host` 是否都指向你的域名；
③ 优选时 `--host` 是否和实际部署一致；④ 端口是否是 443 等 TLS 端口；
⑤ 跑优选时是否关了代理工具。

**Q：配了 SOCKS5 代理但不生效？**
那是数据面走了 vendor 实现（只读 `PROXYIP`）。部署时加 `--dataplane self` 切回自研即可
（自研是默认，只有显式切过才会这样）。

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

---

## 技术实现

### 优选器：三阶真连接校验

传统工具借第三方 CDN 测速，扫出来的 IP 填进节点几乎全 `-1`。CFPilot 的做法是
**每一步都带着你自己的域名**：

| 阶段 | 手段 | 拦掉什么 |
|------|------|----------|
| 一 | 并发 TCP 初筛 + **TLS 握手耗时排序**（候选按网段可用率加权采样） | 连不上的 IP、握手慢的 IP |
| 二 | **WS 101 握手 + PING/PONG 响应体校验** | Enterprise 专属 IP、SNI 阻断、「101 通但数据面不响应」的假活 IP |
| 三 | 仅对通过前两阶的 IP 请求 `/__edge_probe?bytes=N` 测真实下行 | — |

为什么阶段一要单独测 TLS 握手：真机实测 TCP 延迟集中在 8~40ms（无区分度），
而 TLS 握手耗时 768ms~3531ms（相差 4.6 倍），**两者相关系数接近 0** ——
TCP 9ms 的 IP 握手可能要 3.5 秒，客户端超时就是 `-1`。

为什么候选要按可用率加权：Cloudflare 的 IPv4 空间大部分是区域/租户专用分配，
真机实测 6 个官方网段 **0% 可用**。按网段大小平均分配预算会让一半以上候选来自这些废段。

### 数据面：两套实现

| 实现 | 说明 | 代理池 | DoH 优选 | 反代入口 |
|------|------|--------|----------|----------|
| **self**（默认） | 本项目自研 | SOCKS5 / HTTP / HTTPS 全支持 | 可开关 | 用户可自配 + 内置表 |
| **vendor** | 复用 CFNext 的 `wsHandler` | 仅 `PROXYIP` | vendor 内部 | 硬编码第三方表 |

自研另有失败分级诊断、可配置反代入口、竞速顺序可复现等能力。切换：
部署时加 `--dataplane vendor`，或在数据面项目设 `DATAPLANE=vendor`。

### 仓库结构

```text
CFPilot/
├── AGENTS.md              # 架构铁律与编码规范（改代码前必读）
├── HANDOVER.md            # 交接文档：真机结论与决策记录
└── packages/
    ├── worker-core/       # 边缘内核 + 中文面板（Pages/Workers 产物）
    ├── scanner-cli/       # cfpilot-scanner —— 本地真连接优选器
    ├── deploy-wizard/     # cfpilot-deploy —— 全中文部署向导
    └── gui/               # Electron 图形化工具
```

更多实现细节（协议格式、出站选路、DoH 判定、TLS 约束等）见
[AGENTS.md](AGENTS.md) 的 29 条架构铁律，真机取证过程见 [HANDOVER.md](HANDOVER.md)。

---

## 配置项与环境变量

优先级：**KV(`CONFIG`) > 环境变量 > 内置默认值**。

### 常用环境变量

| 变量 | 说明 |
|------|------|
| `UUID` | VLESS UUID |
| `WS_PATH` | WebSocket 路径（**值要带前导斜杠**；`PATH` 是 Pages 保留名，别用） |
| `TROJAN_PASSWORD` | Trojan 密码 |
| `ENABLE_TROJAN` / `ENABLE_XHTTP` | 入站开关 |
| `DATA_HOST` | 数据面域名（拆分部署时控制面用它生成订阅） |
| `PANEL_PATH` / `PANEL_PASSWORD` | 面板路径与初始密码 |
| `PROXYIP` | ProxyIP 池（按直连落地语义解析） |
| `SOCKS5` / `HTTP_PROXY` | 落地代理（仅自研数据面）。`https://` 前缀表示代理本身走 TLS，可用 `#sni=域名` 指定握手名 |
| `NAT64` | NAT64 前缀，如 `64:ff9b::` |
| `RELAY_POOL` / `USE_BUILTIN_RELAY` | 自定义反代入口池 / 内置表开关 |
| `DATAPLANE` | `self`（默认）/ `vendor` |
| `RESOLVE_PREFERRED` | 出站前自动 DoH 解析优选 IP（默认开） |
| `SUB_VARIANTS` | 下发的节点形态，逗号分隔，默认 `vless-ws` |
| `OFFICIAL_IP_COUNT` / `PREFERRED_DOMAIN_COUNT` | 内置来源数量（默认 20 / 10） |
| `DLS` / `MAX_LATENCY` | 订阅池的最低速度 / 最高延迟阈值 |

### 常用 KV 键

| 键 | 内容 |
|----|------|
| `CONFIG` | 用户配置 JSON（含 uuid / wsPath / trojanPassword） |
| `CFP_DEPLOY_MANIFEST` | 部署清单，**判断 KV 归属的唯一依据** |
| `LOCAL_PREFERRED_IPS` | 本地优选结果 |
| `SCANNER_TOKEN` | 扫描回填令牌 |

### scanner 常用参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--host` | 必填 | 你的域名（作为 SNI / Host） |
| `--path` | `/vless` | 目标项目的 WS 路径 |
| `--sample` | `6556` | 候选采样数 |
| `--top` | `15` | 返回条数 |
| `--countries` | — | 机房国家筛选，如 `HK,JP,SG` |
| `--token` | — | 回填令牌（不填则只输出不回填） |
| `--no-verify` | — | 只做 101 握手，跳过响应体校验（对接非 CFPilot 项目时用） |
| `--speed-mode` | `auto` | `probe`（走目标探针端点，最忠实）/ `url`（公开测速地址，任何项目可用）/ `auto` |
| `--cidr` / `--ip-file` | — | 自定义网段 / 本地 IP 列表 |

完整参数见 `npx -y cfpilot-scanner@latest scan --help`。

---

## 免责声明

**本项目仅作学习交流使用**，用于查找资料、学习网络知识，**不鼓励、不支持任何违法行为**。

- 项目中涉及的所有方法与技术均来自互联网公开资料，仅供交流学习；
- 使用者需自行遵守所在地法律法规与 Cloudflare 服务条款（尤其是 Free 套餐的流量与 CPU 限制），并对自身使用行为负全部责任；
- 任何人因使用本项目产生的任何后果（包括但不限于账号封禁、服务中断、法律责任），**本项目及作者概不负责**；
- 如有侵权或不当之处，请联系仓库 issue / PR，将第一时间处理。

---

## License

[MIT](LICENSE)
