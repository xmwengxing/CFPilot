https://github.com/cmliu/edgetunnel

https://github.com/byJoey/cfnew

https://github.com/bia-pain-bache/BPB-Worker-Panel

https://github.com/Ptechgithub/CloudflareScanner

https://github.com/PoemMisty/CFData-WEB

### 一、 四大开源项目深度解构与优劣势对比

将 `edgetunnel`、`cfnew`、`BPB-Worker-Panel` 与 `CloudflareScanner`（含 `CFData-WEB`）放在同一技术坐标系下拆解，可以清晰看到它们各自解决的核心问题及架构短板：

| 项目名称 | 核心架构定位 | 核心技术优势（取长处） | 架构局限与痛点（补短处） |
| --- | --- | --- | --- |
| **cmliu/edgetunnel** | 多协议聚合与动态订阅转换中心 | 1. **强大的订阅生成器**：支持 `ADD`（混合输入）、`ADDAPI`（远程 TXT）、`ADDCSV`（远程测速 CSV + `DLS` 速度阈值过滤）。<br>

<br>2. **动态出站路由**：支持 URL Path 动态指定 `ProxyIP`、`SOCKS5`、`HTTP` 及 `NAT64` 自动合成。<br>

<br>3. **并发竞速拨号**：内置 `TCP_CONCURRENT_DIAL` 提升首包连接速度。 | 环境变量多达数十个，手动创建 Worker、绑定 KV 与配置变量极易出错（高频触发 Error 1101）。 |
| **byJoey/cfnew** | 极简微内核 (`core-only`) + 独立面板 + 在线部署器 | 1. **控制面与数据面分离**：代理内核精简至约 37KB（体积减少 92%），极大降低 Worker 冷启动与内存开销。<br>

<br>2. **Free CPU 保护 (`freeCpu`)**：针对免费版 10ms CPU 限制设计主动断连保护，防大流量崩溃。<br>

<br>3. **抗 QoS 协议**：支持 `VLESS XHTTP (stream-one)` 规避运营商对 WebSocket 的限速。<br>

<br>4. **API 自动部署 (`cfnew-deployer`)**：支持填 API Key 自动创 KV、绑自定义域并写 CNAME。 | 面板在线优选测试由面板服务器发起，显示的是**服务端视角延迟**而非用户本地真实延迟；分离架构对自建闭环有一定割裂感。 |
| **BPB-Worker-Panel** | 全功能 GUI 面板 + 深度抗封锁 + 跨平台安装向导 | 1. **BPB-Wizard 安装向导**：提供 Web 与 Go CLI 双版本，一键生成唯一随机 Worker Hash（防特征风控）并自动完成部署。<br>

<br>2. **抗封锁特化**：原生支持 **TLS Fragment（分片抗 SNI 阻断）**、私有 DoH、Warp 链式出站。<br>

<br>3. **客户端规则引擎**：直接生成带分流规则的 Sing-box / Mihomo 完整配置。 | 原生面向海外（伊朗/俄语区）抗审查场景，缺乏中文向导；缺乏国内三网 `ADDAPI` / `ADDCSV` 动态订阅聚合生态。 |
| **CloudflareScanner** / **CFData-WEB** | 本地客户端视角的 CF Anycast IP 扫描测速工具 | 1. **本地真实路由测试**：运行在用户终端，支持 CIDR 并发 TCPing/HTTPing、丢包率过滤、机房三字码 (`cfcolo`) 筛选。<br>

<br>2. **CFData-WEB 交互**：基于 Go 提供本地 Web 界面与非标端口测试能力。 | **仅验证公共 CDN 连通性，未验证用户自身 Worker 域名的 TLS SNI 与 WebSocket 握手**，导致扫出的高分 IP 填入面板后大量 `-1` 无法连接。 |

---

### 二、 核心痛点排查：为什么 `CloudflareScanner` 优选出的高速 IP 写入节点后延迟全部为 `-1`？

你遇到的「本地优选测速几百兆、延迟极低，但填入三个项目后客户端测试全部 `-1`（超时/连接失败）」是 Cloudflare 边缘代理开发中最典型的技术陷阱。根本原因有以下 **5 个层面**：

#### 1. 原因一：扫出了「Enterprise 企业版专属 IP」或「回源 IP」（占 70% 以上故障）

* **底层机制**：`CloudflareScanner` 默认的 `ip.txt` 包含大量 Cloudflare 公开 CIDR 段。当扫描器执行下载测速时，默认请求的测速地址是 `cdn.cloudflare.steamstatic.com` 或 `speed.cloudflare.com` 等 **Cloudflare Enterprise（企业级）客户域名**。
* **致命冲突**：许多优质 IP 段（如特定 `172.64.x.x`、`104.18.x.x` 子网或 SaaS 接入段）允许访问 Enterprise 域名并能跑满带宽，但**普通 Free 计划的 Workers / Pages 自定义域名在这些 IP 上根本没有路由权限**！当你把这些 IP 作为节点地址 (`address`)，并带上你自己的 Worker 域名作为 `SNI / Host` 发起访问时，Cloudflare 边缘直接拦截并返回 `HTTP 403 Forbidden`、`Error 1003` 或 `Error 1034`，WebSocket 握手瞬间失败，客户端测试结果必为 `-1`。

#### 2. 原因二：TCPing 假阳性与 SNI / WebSocket Upgrade 专项阻断

* **底层机制**：扫描器默认使用 `TCPing`（只发 SYN 包测试 443 端口三次握手）或针对白名单域名的普通 HTTP GET 请求。
* **致命冲突**：国内部分运营商省网出口存在策略——对某段 CF IP 的 TCP 握手放行，甚至普通 HTTPS 网页浏览也放行，但**一旦检测到 TLS ClientHello 中的 `SNI` 是陌生域名（尤其是 `.workers.dev` 或 `.pages.dev`），或者 HTTP 请求头包含 `Upgrade: websocket**`，立刻丢包或发送 TCP RST。

#### 3. 原因三：未绑定自定义域名（直接使用 `workers.dev` / `pages.dev`）

* 优选 IP **只能改变客户端连接的入口路由 IP**，节点内部的 `SNI` 和 `Host` 依然保持为你的 Worker 域名。如果 Worker 未绑定自定义域名（Custom Domain），而是使用默认的 `*.workers.dev`，由于该后缀已在主干网被强特征识别阻断，换任何优选 IP 都会在 TLS 握手阶段直接超时（`-1`）。

#### 4. 原因四：端口协议错配（TLS 端口 vs 非 TLS 端口）

* Cloudflare 仅支持特定端口：
* **HTTPS (TLS) 必须使用**：`443, 2053, 2083, 2087, 2096, 8443`
* **HTTP (非 TLS) 必须使用**：`80, 8080, 8880, 2052, 2082, 2086, 2095`


* 若扫描器用 `-tp 80` 扫出的 IP 被面板生成为 `443 TLS` 节点，或扫描了不支持 TLS 的非标端口直接套用 VLESS+TLS，连接必定返回 `-1`。

#### 5. 原因五：CSV 脏数据或 IPv6 格式未清洗

* 将 `result.csv` 的内容未加清洗直接填入面板，或者 IPv6 地址未包裹方括号（如写成 `2606:4700::1:443` 而非 `[2606:4700::1]:443`），会导致订阅链接 URI 解析崩溃。

#### 🛠️ 代码级根治方案：「三阶真连接握手校验法 (True-WS Probe)」

为了 100% 杜绝 `-1` 节点，我们在新项目的 Worker 内核与本地扫描器之间建立**端到端专属探针协议**：

1. **Worker 内核新增 `/__edge_probe` 端点**：
* 当收到带 `Upgrade: websocket` 的请求时，立即返回 `101 Switching Protocols` 并回复 `{"status":"ok","colo":request.cf.colo}`（验证该 IP 对当前用户的免费版自定义域名是否真正支持 WebSocket 升级！）。
* 当收到 `GET /__edge_probe?bytes=5242880` 时，流式输出 5MB 随机二进制流（用于在当前用户自己的 Worker 域名下测试真实下行速度，彻底告别借用 Steam CDN 测速导致的假阳性！）。


2. **本地优选器强制绑定用户 Worker 域名作为 `SNI` 与 `Host**`：
* 扫描器不再拿公共 CDN 做判断，而是：**阶段一（并发 TCP 握手初筛） ➔ 阶段二（携带用户自己的 Worker 域名作为 TLS `servername (SNI)` 发起 `/__edge_probe` 的 WebSocket 101 真连接握手校验） ➔ 阶段三（仅对通过 101 握手的 IP 进行真下行测速）**。
* 凡是通不过阶段二 WebSocket 101 握手的 IP（无论是 Enterprise 专属 IP 还是被阻断 IP），在本地扫描阶段就会被 100% 剔除！



---

### 三、 需求 4 架构方案：独立 NPM 优选项目与 Web 面板一键联动机制

由于 Cloudflare Worker 运行在云端边缘，无法获取用户本地宽带路由；而浏览器沙盒又禁止前端 JS 伪造 TLS `SNI` 和 `Host` 头。因此，**将本地优选工具发布为独立 NPM 包（例如命名为 `cf-edge-scanner`），并与面板通过「本地 Loopback 桥接 + 远程 Token 回调」双模式联动**，是最完美的工程解法。

#### 联动工作流设计（支持两种丝滑交互）：

```
[用户在浏览器打开 Web 面板]
       │
       ├── 模式 A（一键协议唤醒 / 本地守护桥接）：
       │     1. 点击面板【⚡ 一键本地真连接优选】按钮
       │     2. 前端检测 http://127.0.0.1:19527/status 是否在线
       │     3. 若在线 -> 直接 POST 下发当前 Worker 域名与一次性 Token
       │               -> 面板通过 SSE 实时渲染本地终端扫描进度条与测速表格
       │               -> 扫描完成自动调用面板 API 写入 KV 并刷新节点！
       │
       └── 模式 B（免安装单行命令自动回填，首次使用零门槛）：
             1. 若检测到本地未启动桥接服务，面板自动弹窗生成专属单行命令：
                npx -y cf-edge-scanner@latest --host "你的Worker域名" --token "临时签名Token"
             2. 用户复制命令在本地 CMD / PowerShell / 终端粘贴回车
             3. NPM 包自动拉取 IP 库 -> 执行【TCP + 自定义SNI + WS 101 真连接校验 + 测速】
             4. 优选出的 Top 15 IP 通过 HTTPS POST 自动回传至面板 KV 数据库
             5. 面板网页通过轮询或 WebSocket 感知更新，自动将结果填入【优选 IP 列表】！

```

---

### 四、 四合一新项目（代号：`EdgeNexus`）功能整合蓝图

我们将新项目规划为四个核心模块的深度融合：

1. **全中文可视化安装向导（融合 `BPB-Wizard` + `cfnew-deployer`）**：
* 提供 **Web 引导部署器** 与 **本地 `npx edgenexus-init` 中文交互向导**。
* 用户只需输入 Cloudflare API Token（或邮箱 + Global API Key）：
* 自动校验权限，拉取 Account ID 与账号下的可用域名列表；
* 自动创建并绑定 KV 命名空间（无需手动在控制台点选绑定）；
* 自动生成随机化 Worker 名称与代码特征混淆 Hash（借鉴 `BPB-Wizard` 防风控机制，规避 Error 1101）；
* 自动将用户选定的二级域名绑定为 Worker Custom Domain 或 Pages CNAME；
* 支持**无损一键升级**：保留已有 KV 内的自定义 IP、UUID 和配置，仅热更新内核代码。




2. **多源优选订阅生成引擎（融合 `edgetunnel` 精髓）**：
* 面板内设 4 层优先级合并池，并带自动去重与格式纠错器：
* **L1 本地真连接优选池 (`LOCAL_IPS`)**：由 `cf-edge-scanner` 实测并验证过 WS 101 握手的 IP（最高优先级）。
* **L2 手动自定义池 (`ADD`)**：支持 `IP:Port#备注`、`[IPv6]:Port#备注`、优选 CNAME 域名。
* **L3 远程动态 API 池 (`ADDAPI`)**：支持填入多个第三方 TXT 优选 API 链接，在拉取订阅时实时并发获取。
* **L4 远程 CSV 测速筛选池 (`ADDCSV`)**：支持填入在线 `result.csv` 地址，配合面板设定的 `DLS`（最低下载速度，如 `10` MB/s）与 `MAX_LATENCY`（最高延迟，如 `150` ms）动态过滤生成节点。




3. **全协议与抗封锁微内核（融合 `edgetunnel` + `cfnew` + `BPB`）**：
* **入站协议**：`VLESS + WS`、`Trojan + WS`、`VLESS + XHTTP (stream-one)`。
* **出站与加速**：内置 `edgetunnel` 的 `TCP_CONCURRENT_DIAL`（双路并发竞速拨号） + 动态 `ProxyIP` 池自动故障转移 + `NAT64` 自动转换（当直连 IPv4 失败时自动利用 NAT64 前缀转为 IPv6 访问） + `SOCKS5 / HTTP` 链式落地代理。
* **抗封锁与稳定性**：内置 `cfnew` 的 `Free CPU` 预算保护（达到 CPU 阈值优雅重置流，防整个 Worker 503） + `BPB` 的客户端 **TLS Fragment（分片参数）** 与私有 **DoH** 自动下发。



---

### 五、 面向 OpenCode / DeepSeek Harness 的执行方案与核心代码规范

为了让你直接用 `OpenCode` 或 `DeepSeek Harness` 高效推进开发，以下提供**标准化的 Monorepo 架构规范**、**解决 `-1` 痛点的核心代码实现**以及**分阶段 Agent 执行指令（Prompts）**。

#### 1. 项目 Monorepo 目录结构设计

```text
edgenexus/
├── AGENTS.md                     # Agent 全局上下文与架构约束规范
├── package.json                  # Monorepo 根配置 (npm workspaces / pnpm)
├── packages/
│   ├── worker-core/              # [核心层] Cloudflare Worker/Pages 精简微内核 + 面板 API
│   │   ├── src/
│   │   │   ├── index.ts          # 路由分发入口 (WS 代理 / 探针 / 面板 / 订阅)
│   │   │   ├── protocols/        # VLESS-WS, Trojan-WS, VLESS-XHTTP 解析器
│   │   │   ├── outbound/         # TCP 并发拨号、ProxyIP 故障转移、NAT64、SOCKS5
│   │   │   ├── probe.ts          # /__edge_probe 真连接 WS 101 握手与流式测速端点
│   │   │   ├── sub-engine.ts     # ADD / ADDAPI / ADDCSV 聚合器与 Clash/Sing-box 生成器
│   │   │   └── ui/               # 内嵌轻量化中文管理面板 (SPA 单文件打包)
│   │   └── wrangler.toml
│   ├── scanner-cli/              # [独立 NPM 包] 本地真连接优选工具 (发布至 npm: cf-edge-scanner)
│   │   ├── package.json          # bin: { "cf-edge-scanner": "./dist/cli.js" }
│   │   ├── src/
│   │   │   ├── cli.ts            # CLI 入口，支持单次运行自动回传 & 本地 19527 桥接服务
│   │   │   ├── true-probe.ts     # 携带自定义 SNI/Host 的 TLS + WS 101 握手与测速核心
│   │   │   ├── server.ts         # 本地 Loopback HTTP + SSE 服务（供面板一键调用）
│   │   │   └── ip-ranges.ts      # 内置清洗后的 Free Plan 可用 CF IPv4/IPv6 CIDR 库
│   └── deploy-wizard/            # [部署向导] 中文全自动安装向导 (CLI + Web 部署器)
│       ├── src/
│       │   ├── cf-api.ts         # Cloudflare API 封装 (创建 KV、部署 Worker、绑定自定义域名)
│       │   └── wizard-zh.ts      # 全中文交互式终端与 Web 向导逻辑

```

#### 2. 关键模块核心代码基准（解决 `-1` 真连接校验与自动回填）

将以下两段核心逻辑放入项目基准中，确保 Agent 生成的代码能够彻底解决 `-1` 问题并打通 NPM 自动回填：

##### (1) Worker 端：内置真连接校验探针与自动回填接口 (`packages/worker-core/src/probe.ts`)

```typescript
export async function handleEdgeProbe(request: Request, env: any): Promise<Response> {
  const url = new URL(request.url);

  // 1. 验证 WebSocket 101 真实升级能力（彻底排除假阳性与 Enterprise 403 IP）
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', (event) => {
      if (event.data === 'PING') {
        server.send(JSON.stringify({
          pong: true,
          colo: (request as any).cf?.colo || 'UNK',
          clientIp: request.headers.get('CF-Connecting-IP')
        }));
        server.close(1000, 'Probe complete');
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // 2. 真实域名下的流式下行测速（避免借用第三方大站测速造成的权限错配）
  const bytes = Math.min(parseInt(url.searchParams.get('bytes') || '2097152', 10), 15728640); // 默认 2MB，最大 15MB
  const chunk = new Uint8Array(65536).fill(0x61);
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const remaining = Math.min(chunk.byteLength, bytes - sent);
      controller.enqueue(chunk.subarray(0, remaining));
      sent += remaining;
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 3. 接收本地 NPM 优选工具自动回传的优选 IP 并写入 KV
export async function handleUpdatePreferredIPs(request: Request, env: any): Promise<Response> {
  const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
  const savedToken = await env.KV.get('SCANNER_TOKEN');
  if (!auth || auth !== savedToken) {
    return new Response(JSON.stringify({ error: 'Token 校验失败' }), { status: 401 });
  }

  const body = await request.json() as { ips: string[] };
  // 格式统一清洗为: IP:Port#机房_延迟_速度
  const cleaned = body.ips.map(line => line.trim()).filter(Boolean).join('\n');
  await env.KV.put('LOCAL_PREFERRED_IPS', cleaned);

  return new Response(JSON.stringify({ success: true, count: body.ips.length }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

```

##### (2) 本地 NPM 包端：指定自定义 `SNI / Host` 进行 TLS + WS 101 真连接校验 (`packages/scanner-cli/src/true-probe.ts`)

```typescript
import * as tls from 'node:tls';
import * as crypto from 'node:crypto';

export interface ProbeResult {
  ip: string;
  port: number;
  ok: boolean;
  latencyMs: number;
  colo: string;
  speedMBps: number;
}

/**
 * 核心突破：直接连接到候选 IP，但强制使用用户自己的 Worker 域名作为 TLS SNI 与 HTTP Host
 * 完整执行 TLS 握手 + WebSocket 101 升级 + PING/PONG 校验，100% 过滤 -1 废节点
 */
export function verifyTrueWsConnection(
  ip: string,
  port: number,
  workerDomain: string,
  timeoutMs = 2500
): Promise<{ ok: boolean; latencyMs: number; colo: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const wsKey = crypto.randomBytes(16).toString('base64');
    let settled = false;

    const done = (ok: boolean, colo = 'UNK') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Math.round(performance.now() - start), colo });
    };

    const socket = tls.connect(
      {
        host: ip,                // 实际连接的优选候选 IP
        port,
        servername: workerDomain, // 关键：强制 TLS SNI 为用户自己的 Worker 自定义域名
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'] // WebSocket Upgrade 使用 HTTP/1.1
      },
      () => {
        // 发送标准 WebSocket 升级请求到 Worker 的 /__edge_probe 端点
        const req = [
          `GET /__edge_probe HTTP/1.1`,
          `Host: ${workerDomain}`,
          `Upgrade: websocket`,
          `Connection: Upgrade`,
          `Sec-WebSocket-Key: ${wsKey}`,
          `Sec-WebSocket-Version: 13`,
          `User-Agent: EdgeNexus-Scanner/1.0`,
          `\r\n`
        ].join('\r\n');
        socket.write(req);
      }
    );

    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('error', () => done(false));

    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      // 必须严格收到 HTTP/1.1 101 Switching Protocols 才算有效节点！
      if (text.includes('101 Switching Protocols')) {
        const coloMatch = text.match(/CF-RAY:\s*[0-9a-f]+-([A-Z]{3})/i);
        done(true, coloMatch ? coloMatch[1].toUpperCase() : 'CF');
      } else {
        // 如果返回 403 Forbidden / 400 / 522 等，立即淘汰！
        done(false);
      }
    });
  });
}

```

---

#### 3. OpenCode / DeepSeek Harness 分阶段开发执行计划（可直接复制的执行指令）

在启动 `OpenCode` 或 `DeepSeek Harness` 时，先让 Agent 创建上述目录与 `AGENTS.md`，随后按以下 **5 个阶段（Phases）** 逐步下发指令执行开发与自测：

##### 📌 Phase 1：初始化 Monorepo 与架构规范 (`AGENTS.md`)

> **发给 Agent 的指令：**
> "请初始化一个基于 TypeScript 的 Monorepo 项目 `edgenexus`（包含 `packages/worker-core`、`packages/scanner-cli`、`packages/deploy-wizard`）。首先编写根目录的 `AGENTS.md`，写入以下核心架构铁律：
> 1. 配置优先级遵循：KV 存储配置 > 环境变量 > 内置默认值。
> 2. Worker 内核必须保持极简（控制在 50KB 以内），内置 `/__edge_probe` 真连接探针端点。
> 3. 优选 IP 解析器必须兼容纯 IP、`IP:Port#备注`、`[IPv6]:Port#备注` 以及标准 `result.csv` 文本行自动清洗。
> 完成后初始化各子包的 `package.json` 和 `tsconfig.json`。"
> 
> 

##### 📌 Phase 2：开发融合版 Worker 代理微内核与订阅引擎 (`packages/worker-core`)

> **发给 Agent 的指令：**
> "在 `packages/worker-core` 中实现核心边缘工作节点：
> 1. **协议层**：实现 `VLESS-WS`、`Trojan-WS` 和 `VLESS-XHTTP (stream-one)` 入站解析。
> 2. **出站层**：实现 `TCP_CONCURRENT_DIAL`（双路并发竞速拨号）、动态 `ProxyIP` 失败回退、`NAT64` 自动合成 IPv6 出站、以及 `SOCKS5/HTTP` 链式出站；加入 `Free CPU` 毫秒级计时预算保护机制。
> 3. **订阅引擎 (`sub-engine.ts`)**：复刻并升级 `edgetunnel` 的 `ADD`、`ADDAPI`、`ADDCSV`（支持按 `DLS` 最低速度阈值过滤）机制，并将 `LOCAL_PREFERRED_IPS`（本地真连接优选结果）作为最高优先级合并输出；内置自适应订阅生成（支持 Base64、Clash/Mihomo YAML、Sing-box JSON 1.12+，并支持可选注入 BPB 风格的 TLS Fragment 参数）。
> 4. **探针与 API**：实现 `/__edge_probe` 端点与 `/api/v1/preferred-ips` 自动回填接口。"
> 
> 

##### 📌 Phase 3：开发独立 NPM 本地真连接优选包 (`packages/scanner-cli`)

> **发给 Agent 的指令：**
> "在 `packages/scanner-cli` 中开发可独立发布至 npm 的 CLI 工具 `cf-edge-scanner`：
> 1. **真连接三阶扫描器**：读取剔除 Enterprise 专属段后的 Free Plan 友好型 IPv4/IPv6 CIDR 列表；第一阶段执行高并发 TCP 握手测延迟；第二阶段强制携带用户传入的 `--host <workerDomain>` 作为 TLS `servername (SNI)` 和 HTTP `Host`，连接 `/__edge_probe` 验证是否返回 `101 Switching Protocols`（彻底解决 `-1` 假死问题）；第三阶段对通过 101 校验的前 30 个 IP 请求 `/__edge_probe?bytes=5242880` 计算真实下行速度。
> 2. **双模运行与面板联动**：
> * CLI 直跑模式：`npx cf-edge-scanner --host xxx --token yyy`，跑完后自动将 `IP:Port#机房_延迟_速度` 格式的 Top 15 列表 POST 回传至面板 KV。
> * 本地桥接服务模式：`npx cf-edge-scanner serve` 在本地监听 `127.0.0.1:19527`（开启 CORS），提供 `/start-scan` 与 `/events` (SSE) 接口，让用户在面板网页点击按钮即可直接唤醒本地终端测速并实时显示进度条。"
> 
> 
> 
> 

##### 📌 Phase 4：开发面板前端 UI 与中文一键部署向导 (`packages/deploy-wizard`)

> **发给 Agent 的指令：**
> "1. 为 `worker-core` 编写内嵌式现代中文管理面板 UI，包含：
> * `edgetunnel` 风格的优选订阅生成器输入区（本地优选池、手动列表 `ADD`、远程 `ADDAPI`、远程 `ADDCSV` + 最低速度阈值输入框）；
> * 【⚡ 一键本地真连接优选】按钮：自动探测本地 `127.0.0.1:19527`，若在线则直接触发 SSE 实时扫描并自动填入列表；若未在线则弹出带一次性 Token 的 `npx -y cf-edge-scanner@latest ...` 一键复制命令，并轮询 KV 自动刷新结果。
> 
> 
> 2. 在 `packages/deploy-wizard` 中结合 `BPB-Wizard` 与 `cfnew-deployer` 的设计，实现全中文安装向导（支持 CLI 与 Web 端）：用户输入 Cloudflare API Token 后，向导自动获取 Account ID、自动创建并绑定 KV 命名空间、生成随机混淆 Worker Hash、自动部署代码并绑定用户的自定义二级域名（自动创建 DNS 记录）。"
> 
> 

##### 📌 Phase 5：端到端联调与 NPM 发布流水线

> **发给 Agent 的指令：**
> "编写自动化测试脚本验证：
> 1. 使用 Wrangler 本地模拟启动 `worker-core`；
> 2. 运行 `scanner-cli` 验证 `/__edge_probe` 的 WebSocket 101 握手、流式测速与 KV 自动回填接口；
> 3. 测试各种脏格式（如直接粘贴 CSV 原文、裸 IPv6 地址）在订阅生成器中的清洗结果，确保生成的 Clash 与 Sing-box 订阅 `server`、`servername/sni`、`host` 映射完全正确；
> 4. 配置 `packages/scanner-cli` 的 `npm publish` 打包脚本。"
> 
> 

---

如果想直观了解本地优选工具（如 `CFData-WEB`）如何与 Cloudflare Worker 及 `edgetunnel` 配合进行本地优选操作，可以参考这段 [CF 优选 IP 与 EdgeTunnel 本地优选指南](https://www.youtube.com/watch?v=M_Uqbm_ObC4)，其中演示了本地扫描筛选与节点配置的完整流程，有助于对比理解上述自动化改造前后的体验差异。