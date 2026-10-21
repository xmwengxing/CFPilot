# CFPilot

> Cloudflare Workers 代理微内核 · 真连接优选面板 · 一键部署
> MIT License · 架构源自 [edgetunnel](https://github.com/cmliu/edgetunnel)、[cfnew](https://github.com/byJoey/cfnew)、[BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel)、[CloudflareScanner](https://github.com/Ptechgithub/CloudflareScanner) 的公开设计

CFPilot 把「代理内核 + 优选订阅 + 本地真连接优选 + 中文部署向导」整合成一套可一键落地的方案，
核心目标是解决 Cloudflare 代理最常见的那类故障：**本地优选测速几百兆，客户端却全是 `-1`**。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
- [仓库结构](#仓库结构)
- [面板说明](#面板说明)
- [cfpilot-scanner：本地真连接优选器](#cfpilot-scanner本地真连接优选器)
- [cfpilot-deploy：全中文部署向导](#cfpilot-deploy全中文部署向导)
- [订阅接入](#订阅接入)
- [配置项与环境变量](#配置项与环境变量)
- [开发与测试](#开发与测试)
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
阶段一  并发 TCP 握手初筛            →  过滤掉根本连不上的 IP
阶段二  用【你自己的 Worker 域名】作为 TLS SNI 与 HTTP Host，
        请求 /__edge_probe 并要求返回 101 Switching Protocols
                                      →  一次性淘汰 Enterprise 专属 IP、被阻断 IP、SNI 不匹配的 IP
阶段三  仅对通过 101 校验的 IP 请求 /__edge_probe?bytes=5MB
                                      →  在自己的域名下测真实下行速度，不再借用第三方 CDN
```

Worker 内核内置 `/__edge_probe` 端点，因此**优选结果 100% 对应你自己的域名**。

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

`cfpilot-deploy` 会自动完成：

- 校验 API Token 权限
- 选择账号
- 生成随机化 Worker 名称（降低特征风控）
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

## ⚠️ 部署必须拆成两个项目（否则第二次部署会被封）

Cloudflare 的滥用分类器会把「面板 + 订阅 + 探针 + 代理」的完整组合判定为代理服务，
导致 Pages 项目在**第二次部署**时返回 `8000119 blocked`。实测结论：

| 部署内容 | 能否原地更新 |
|---|---|
| 控制面（面板 + 订阅 + 探针，约 47KB，不含出站拨号） | ✅ 可以 |
| 数据面（代理入站，单独部署） | ✅ 可以 |
| 两者合并成一个 bundle | ❌ 第二次部署必被封 |

所以请部署**两个** Cloudflare Pages 项目：

1. **数据面**：只做代理转发，绑你的自定义域名（客户端连这个域名）
2. **控制面**：面板 + 订阅，可以用 `*.pages.dev` 或另一个域名

数据面需要把配置写入 KV 的 `config` 键，并把控制面的 `DATA_HOST` 指向数据面域名。

## 部署到 Cloudflare Pages（实测推荐）

真机验证结论：**同一个 `dist/worker.js`，走 Workers 脚本通道会被 Cloudflare 拒绝实例化
（Error 1101，请求根本不进入调用期），走 Pages `_worker.js` 通道则完全正常。**
edgetunnel / cfnew / BPB / CFNext 全部选择 Pages 也是同一个原因。

### 三条必须遵守的规则（都是踩出来的）

1. **顺序不能反**：先建项目 → 设环境变量 / 绑 KV → **最后才部署**。
   Pages 的绑定与变量只对**之后的**部署生效，先部署再配置等于白配。
2. **一个项目只有第一次部署能成功**。第二次会返回
   `8000119 Your Pages project has been blocked`（滥用审查）。
   升级内核时请**新建一个项目**（名字随机），不要在旧项目上重复部署。
3. 带哈希的部署 URL（`<hash>.<project>.pages.dev`）需要认证，
   请始终使用项目主域 `<project>.pages.dev` 或已绑定的自定义域名。

### 手动步骤

1. Workers & Pages → 创建 → **Pages** → 直接上传（不要连 Git）
2. 项目建好后，先到 Settings → 变量与绑定：
   - 绑 **KV 命名空间**，变量名必须是 **`KV`**
   - 加文本变量 `PANEL_PATH=/p-你的随机串`、`PANEL_PASSWORD=你的密码`
3. 最后上传文件：目录里放一个 **`_worker.js`**（内容就是 `packages/worker-core/dist/worker.js`），
   部署该目录
4. Custom domains 里绑定你的自定义域名（`*.pages.dev` 在国内可能不通，且订阅里的
   `sni` 是按访问域名自动生成的，必须用自定义域名）
5. 访问 `https://<你的域名><PANEL_PATH>`

### 用 wrangler 部署（一条命令）

```bash
mkdir -p upload && cp packages/worker-core/dist/worker.js upload/_worker.js
npx wrangler pages deploy upload --project-name <随机项目名> --branch main
```

> 面板路径以 **KV 里的 `PANEL_PATH`** 为准（优先级高于环境变量）。
> 如果忘记路径，可以读 KV 的 `PANEL_PATH` 键，或删掉该键后重新部署。

---

## 仓库结构

```text
CFPilot/
├── AGENTS.md                     # 架构铁律与编码规范
├── packages/
│   ├── worker-core/              # @cfpilot/worker-core —— 边缘内核 + 中文面板
│   ├── scanner-cli/              # cfpilot-scanner —— 本地真连接优选器（npm）
│   └── deploy-wizard/            # cfpilot-deploy —— 全中文部署向导（npm）
```

### worker-core（Worker 内核）

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 路由分发：探针 / 面板 API / 订阅 / 面板 / 三种代理入站 |
| `src/protocols/vless.ts` | VLESS 协议头解析（UUID 校验、命令、地址） |
| `src/protocols/trojan.ts` | Trojan 协议头解析（SHA224 口令，注意地址类型编号与 VLESS 不同） |
| `src/protocols/xhttp.ts` | VLESS + XHTTP（stream-one）入站：一个 POST 请求承载上下行 |
| `src/protocols/sha224.ts` | 纯 TS 的 SHA-224（WebCrypto 不支持，Trojan 口令校验必需） |
| `src/outbound/dial.ts` | 出站拨号：TCP 并发竞速、ProxyIP 故障转移、NAT64 合成 |
| `src/outbound/socks5.ts` / `http-proxy.ts` | SOCKS5 与 HTTP CONNECT 落地代理 |
| `src/sub-engine.ts` | 四层优选池合并 + 脏数据清洗 + Base64/Clash/Sing-box 输出 |
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
| **高级** | ProxyIP 池、SOCKS5/HTTP 代理、NAT64、并发竞速拨号、客户端指纹、远程 `ADDAPI` / `ADDCSV` 池 |

### 优选池的三个内置来源

| 来源 | 数据从哪来 | 说明 |
|------|-----------|------|
| 官方优选 IP | CF 官方 15 个 IPv4 网段，请求时随机抽样 | Cloudflare 的 IP 是 anycast，静态表必然过期，所以按需随机生成（edgetunnel 同样思路） |
| 优选域名 | 内置 21 条社区公开优选域名（来自 cfnew 的直连域名列表），随机取样 | 域名只负责解析出好 IP，`sni` / `Host` 仍是你的 Worker 域名 |
| 手动优选 IP | 本地真连接扫描结果（KV `LOCAL_PREFERRED_IPS`）+ 面板手填 | 优先级最高，因为它是**在你自己的域名上验证过 101 握手**的 IP |

> **关于「国家」筛选**：CF 的 anycast IP 本身没有国家归属，机房要连接后才知道。
> 因此国家筛选只能作用于「已知机房」的条目（本地扫描结果、带机房标注的远程池）；
> 随机生成的官方 IP 机房未知，选了国家后会被排除——想按国家筛，请先跑一次本地优选。
> 三源全不勾选时会自动生成 **20 个官方优选 IP + 10 个优选域名**，订阅不会为空。

---

## cfpilot-scanner：本地真连接优选器

### 直跑模式

```bash
npx -y cfpilot-scanner@latest --host "cfpilot.example.com" --token "面板令牌"
```

跑完后会把 Top 15 结果自动回填到面板 KV（`IP:Port#机房_延迟_速度` 格式）。

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
| `--port` | `443` | 端口 |
| `--token` | — | 回填令牌（面板生成的一次性令牌，10 分钟有效） |
| `--callback` | `https://<host>/api/v1/preferred-ips` | 回填地址 |
| `--top` | `15` | 返回条数 |
| `--sample` | `20000` | 候选 IP 采样数 |
| `--cidr` | — | 自定义网段（逗号分隔） |
| `--ip-file` | — | 使用本地 IP 列表文件 |
| `--max-latency` | `0` | 阶段一延迟上限（ms） |
| `--probe-limit` | `120` | 进入 101 校验的候选数 |
| `--speed-limit` | `30` | 进入测速的候选数 |
| `--seed` | `24301` | 采样随机种子（同种子结果可复现） |

---

## cfpilot-deploy：全中文部署向导

```bash
npx -y cfpilot-deploy@latest init          # 交互式
npx -y cfpilot-deploy@latest init --yes --domain cfpilot.example.com
npx -y cfpilot-deploy@latest token --token <API_TOKEN>   # 仅校验 Token
```

Token 所需权限：

- Account → Workers Scripts → **Edit**
- Account → Workers KV Storage → **Edit**
- Zone → Zone → **Read**
- Zone → DNS → **Edit**

### 无损升级

重新执行 `cfpilot-deploy init` 即可热更新内核，**已有 KV 里的 UUID、优选 IP、配置都会保留**。

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

## 配置项与环境变量

优先级：**KV(`CONFIG`) > 环境变量 > 内置默认值**。

| 环境变量 | 对应配置 | 说明 |
|----------|----------|------|
| `PANEL_PASSWORD` | — | 面板初始密码（首次启动后写入 KV 哈希） |
| `PANEL_PATH` | — | 面板路径（不设则随机生成） |
| `SCANNER_TOKEN` | — | 扫描回填令牌 |
| `UUID` | `uuid` | VLESS UUID |
| `PROXYIP` | `proxyIp` | ProxyIP 池（`host:port`，默认按 SOCKS5 处理） |
| `SOCKS5` | `socks5` | SOCKS5 代理 |
| `HTTP_PROXY` | `httpProxy` | HTTP 代理 |
| `NAT64` | `nat64` | NAT64 前缀，如 `64:ff9b::` |
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
| `CONFIG` | 用户配置 JSON |
| `LOCAL_PREFERRED_IPS` | 本地真连接优选结果（每行一条） |
| `POOL_DOMAIN_LIBRARY` | 面板里自定义的优选域名库（每行一个；空 = 用内置库） |
| `SCANNER_TOKEN` | 长期扫描令牌 |
| `PANEL_PATH` / `ADMIN_PW_HASH` | 面板路径与密码哈希 |
| `SESSION:<token>` | 面板会话（24 小时） |
| `ONETIME:<token>` | 一次性扫描令牌（10 分钟） |

---

## 开发与测试

```bash
npm install
npm run typecheck     # tsc
npm test              # vitest（协议解析 / SHA-224 / 订阅清洗 / CF API）
npm run build         # 打包内核 + 两个 CLI
npm run verify        # build + typecheck + test
```

本地调试 Worker：

```bash
npm run dev -w @cfpilot/worker-core      # wrangler dev --local
curl "http://localhost:8787/__edge_probe?bytes=1024"
```

> 国内网络访问 npm 缓慢时，可临时使用镜像：
> `npm install --registry=https://registry.npmmirror.com`

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

**Q：免费额度 CPU 超限？**
内核内置 Free CPU 预算保护（默认 8ms），会在订阅生成、CSV 解析等重活上提前中止。
可调低 `DLS`/`MAX_LATENCY` 阈值或减少 CSV 行数。

---

## 免责声明

本项目仅供学习与自建网络研究使用。使用者需自行遵守所在地法律法规与 Cloudflare
服务条款（尤其是 Free 套餐的流量与 CPU 限制），并对自身使用行为负责。

## License

[MIT](LICENSE)
