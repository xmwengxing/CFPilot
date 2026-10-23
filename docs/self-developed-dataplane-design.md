# 自研数据面：架构设计与真机实验结论

> 日期：2026-10-23　｜　状态：设计阶段（实验结论已真机验证）
> 目标：不照抄 CFNext，综合 edgetunnel / BPB-Worker-Panel / CFNext 写出自己的数据面。
> 前置：[docs/kv-instance-isolation.md](kv-instance-isolation.md)（KV 实例隔离，已实施）

---

## 0. 结论速览

| # | 结论 | 依据 |
|---|------|------|
| 1 | **旧代码归档文档的核心结论是错的**：「静态导入 `cloudflare:sockets` 会让 isolate 启动失败（1101）」 | 真机：静态 import 但不调用 → **部署 success、响应正常** |
| 2 | **真正的失败在运行时出站**：`connect()` 到 Cloudflare 自家 IP 恒被拒 | 真机：`1.1.1.1:443`、`cloudflare.com:443`、`104.16.0.1:443` 全部 `proxy request failed` |
| 3 | **第三方 IP 的 443 完全可用** | 真机：`8.8.8.8:443`、`9.9.9.9:443`、`208.67.222.222:443` 全部 **OK** |
| 4 | `request.fetcher.connect` **不能**绕过上述限制 | 真机：与 `cloudflare:sockets` 错误信息完全一致 |
| 5 | `secureTransport: 'on'` 可以连第三方 443 | 真机：`9.9.9.9:443` 建连成功 |
| 6 | 8000119 与滥用邮件是**间歇性账号级风控**，不是内容判定 | 真机：同配置 6/6 成功；原样重试即成功；**连续 10 次中性内容部署：9 成功 / 1 次泛化错误** |

**一句话**：旧代码不是「写不出来」，而是**出站选路必然踩到 Cloudflare 自家 IP**。

### 0.1 关于「滥用邮件」的正确理解（用户提供的关键事实）

用户说明：**邮件从第一次测试部署就收到了，几���封一模一样；只要部署被检测到可疑就会有；账号本身很健康。**

结合实测，这三件事互不矛盾，且指向同一个解释：

- 邮件**不是**「部署次数过多」导致的账号处罚，而是**每一次部署被判定为可疑**就会触发一次通知；
- 因此「几十封一模一样」= 几十次部署各自命中判定，而不是一次事件重复发信；
- 「账号本身很健康」与实测一致：连续 10 次部署 9 次成功，**没有**出现账号级封禁。

实测支撑（§1.5）：**内容完全相同且完全中性**的产物连续部署 10 次 → 成功 9 次、
泛化错误 1 次；明文 `vless`/`trojan`/`proxy` 特征串与拆分混淆版本**结果相同**（都成功）。

**结论**：风控判定是**内容无关的账号级间歇判定**。产品上的应对是
「**先原样重试、再换名**」（已实施，见 §0.19.4），而不是靠混淆字符串去规避。

> ⚠️ 因此 edgetunnel / CFNext 的「特征码字典混淆」在**部署受理**这一层
> 并无实测收益（我们的 X/Y 对照即证据）。它更可能服务于**运行时流量特征**层面，
> 与部署能否通过是两件事，不应混为一谈。

---

## 1. 真机实验记录（2026-10-23）

账号 `70ec011b12cd621609a8412a4d0c1668`，全部实验项目已清理。

### 1.1 sockets 导入形式 ≠ 失败原因

| 脚本 | 内容 | 部署 | 运行时响应 |
|------|------|------|-----------|
| A | `import{connect}from"cloudflare:sockets"`，**从不调用** | ✅ success | `A-ok` |
| B | 动态 `import('cloudflare:sockets')`，从不调用 | ✅ success | `B-ok` |
| C | 静态 import + **真的调用** `connect()` | ✅ success | `proxy request failed, ... consider using fetch instead` |

**A 与 B 都正常** → 静态导入不会导致 1101。
归档文档 `archive/self-developed-dataplane/README.md` 与 `src/outbound/dial.ts` 的注释
（「静态导入 sockets 会让 isolate 在启动阶段失败」「一个只导入 sockets 的 30 行脚本同样复现 TCP Loop detected」）
**与实测不符**，需一并更正。

### 1.2 出站可达性矩阵（同一 Worker 实例内对照）

```
8.8.8.8:53          → OK          8.8.8.8:443        → OK
9.9.9.9:443         → OK          208.67.222.222:443 → OK
1.1.1.1:443         → BLOCKED     cloudflare.com:443  → BLOCKED
104.16.0.1:443      → BLOCKED
```

**被拒的恰好是 Cloudflare 自家的 IP**（1.1.1.1、cloudflare.com、104.16.0.1 都在 CF 网段）。
第三方 IP 的 443 一律可用。这与 Worker 运行时的出网策略一致：
**Worker 不能主动连回 Cloudflare 自己的 Anycast 入口**（那会构成环路，
Cloudflare 侧直接拒绝，报 `TCP Loop detected`）。

### 1.3 `request.fetcher.connect` 不是绕过手段

edgetunnel 用 `request.fetcher.connect`（见 §3.1），容易误以为它更宽松。
实测：fetcher 与 sockets 的错误信息**完全一致**，同样拒绝 CF 自家 IP。

### 1.4 `secureTransport: 'on'` 可用（但**不适用于主出站路径**）

`connect({hostname, port, secureTransport: 'on'})` 连 `9.9.9.9:443` 建连成功。
这是 Workers 的原生 TLS 通道：TCP 由运行时建好，TLS 也由运行时终结，
**我们只需要在流上跑明文 HTTP**。

> ⚠️ **2026-10-23 复核更正**：本节早先被当作「自研数据面必须补 TLS」的依据，
> 属于**误判**。见 §1.4d 的三方源码对照。
> `secureTransport` 的真实用途只有一处：**代理服务器本身是 HTTPS 时**。

### 1.4d ⚠️ 三方源码对照：VLESS/Trojan 主出站路径**不需要 TLS**

复核了三个成熟项目的**实际源码**（不是 README），结论一致：

| 项目 | 直连目标 | 优选 IP 落地 | SOCKS5 | HTTP 代理 | HTTPS 代理 |
|------|---------|-------------|--------|----------|-----------|
| **CFNext（vendor）** | 纯 TCP | 纯 TCP | — | — | 不支持 |
| **edgetunnel** | 纯 TCP | 纯 TCP | 纯 TCP | 纯 TCP | `secureTransport:'on'` + 自研 `TlsClient` |
| **BPB** | 纯 TCP | 纯 TCP | — | — | — |

源码证据：

- **CFNext**：`Pt(hostname, port, timeout)` 内只有 `connect({hostname, port})`，
  全文件**搜不到** `secureTransport` / `startTls` / `TlsClient`。
- **edgetunnel**：`connectDirect()` / `connectProxyIP()` / `socks5Connect()` /
  `httpConnect()` 全部是纯 TCP；
  `secureTransport: 'on'` 只出现在 `httpsConnect()`（连 **HTTPS 代理服务器**）
  与 `sstpConnect()`（连 **SSTP 代理服务器**）两处，
  `TlsClient` 也只服务于「代理服务器本身要 TLS」的场景。

**原因（协议本质）**：VLESS / Trojan over WebSocket 是 **TLS 透传代理**。
TLS 有两层，不能混淆：

```
第一层  客户端 ──TLS──> Cloudflare 边缘     ← TLS 由客户端发起、CF 边缘终结
        （保护客户端→Worker 的 WS 传输；Worker 拿到的是已解密的 WS 帧）

第二层  Worker ──?──> 目标站                ← Worker 不终结 TLS！
        （透传客户端发来的 TLS 密文，由客户端与目标站直接完成握手）
```

Worker 在第二层只是**字节搬运工**。若 Worker 自己终结 TLS，
就会破坏客户端与目标站之间的端到端 TLS 语义（证书校验、SNI、指纹全部错位）。

**因此**：
- 「给自研数据面补 TLS 能力」**不是**必要项，原列为第一优先级属于误判；
- 唯一需要 TLS 的是**代理服务器本身是 HTTPS/SSTP 的场景** —— 这正是 vendor 缺失、
  edgetunnel 具备的能力，值得补（见 §5 实施状态）。

### 1.4b ⚠️ `WebSocketPair` 的索引顺序不可靠（自研实现踩到并已修）

自研实现最初写的是：

```ts
const pair = new WebSocketPair()
const client = pair[0]
const server = pair[1]
```

真机表现：**WS 升级返回 200 而非 101**（vendor 同样的代码返回 101）。
原因：`WebSocketPair` 的**索引顺序不是规范保证的**，`pair[0]` 可能拿到的是
「服务端侧」那一个，`accept()` 落在错误的 socket 上，101 构造随之失败。

vendor（CFNext）用的是 `Object.values` 解构，正是为了不依赖索引顺序：

```js
const n = new WebSocketPair, [r, a] = Object.values(n)
```

→ 自研实现已改为 `Object.values(new WebSocketPair())`，修正后真机返回 101。

> 这条与 `AGENTS.md` 里「优先取成熟项目的可借鉴点」直接相关：
> 照抄时容易连**索引顺序**这种隐性约定一起抄错。

### 1.4c WS 升级在 Cloudflare 边缘有**间歇性拦截**（与实现无关）

同一份代码、同一实例，反复发 WS 升级请求：

```
vendor 实例：{"HTTP/1.1 101 Switching Protocols": 7, "错误": 1}
自研实例：  {"HTTP/1.1 400 Bad Request": 5, ...}
```

而普通 HTTP 请求（`/__edge_probe`）**始终 200**。
说明拦截只针对 WS 升级流量，且**与数据面实现无关**（vendor 同样被拦）。

**因此「真机验证 WS 升级」必须多次采样**，单次 400 说明不了任何问题。

### 1.5 部署节奏与风控（内容无关）

完全中性内容（`export default { async fetch() { return new Response("ok") } }`）连续部署 10 次：

```
成功=9   被拒(8000119)=0   泛化错误(8000000)=1
```

明文代理特征串 vs 拆分混淆串，两者结果相同（均成功）。

**推论**：部署受理的成败**与产物内容无稳定因果**，失败率约 1/10，
且失败形态在 `8000119`（明确 blocked）与 `8000000`（泛化错误）之间随机出现。

---

## 2. 旧代码为什么「陷入死循环」


三个缺陷叠加，形成**确定性失败**：

```
旧 pickOutbound(target, proxies, colo)
  1) proxies.length > 0 → 过滤 p.kind === 'direct'  ← 缺陷 A：把 SOCKS5/HTTP 代理全滤掉
  2) isCloudflareAddress(target.hostname) → 走「同区域落地」分支
  3) 同区域落地列表来自优选 IP 库 ← 缺陷 B：库里的 IP **全是 Cloudflare 网段**
  → 必然 connect 到 CF Anycast → 必然 TCP Loop detected
```

- **缺陷 A**：`sameRegion = proxies.filter((p) => p.kind === 'direct')`
  —— 注释写的是「优先同区域」，实际把 SOCKS5 / HTTP 代理全过滤掉了。
  归档 README 已记「未修」，但没意识到它的致命性。
- **缺陷 B**：优选 IP 库是硬编码的 CF 网段（`104.16.0.0/12` 等）。
  CFNext 的库则是**域名**（`proxyip.hk.<域名>` 等），解析出的 IP 可能不是 CF Anycast。
- **缺陷 C**：第 3 步「目标是 CF 地址且没有可用 ProxyIP：仍然尝试直连一次」——
  注释说是「把 Loop 异常交给上层转换为可诊断的关闭码」，
  但每条连接都必然触发 Loop，**诊断信息永远拿不到**（因为根本没到上层）。

> 所以「永远无法部署还找不出原因」的真相是：
> **失败发生在出站选路，而异常被吞在 `tryDial` 的 catch 里，只返回 null**，
> 日志上看不到任何线索；每一层失败都被当作「目标不可达」，
> 于是表现为「怎么试都不行」。

---

## 3. 三个成熟项目的做法（取长补短）

### 3.1 edgetunnel（cmliu/edgetunnel）

| 特点 | 值得借鉴 |
|------|---------|
| **完全不用 `cloudflare:sockets`**（实测 0 次引用） | 出站改走 `fetch()` + HTTP 代理隧道 |
| `创建请求TCP连接器(request)` → `request.fetcher.connect` | 统一的连接器抽象，便于替换后端 |
| 自研 `TlsClient`（约 500 行） | 在裸 TCP 上完成 TLS 握手与双向加解密 |
| 出站 = 连 `cloudflare.com:443`（探测目标）→ 经 SOCKS5/HTTP 代理 → `CONNECT` 隧道 | **出站必须有外部代理**；`cloudflare.com:443` 是允许连的 CF 域名（作为代理探测目标） |
| `dns.nameserver-policy` + ECH | ECH 参数注入方式 |
| 特征码字典混淆字符串 | 规避部署期静态特征查杀 |

### 3.2 BPB-Worker-Panel（bia-pain-bache/BPB-Worker-Panel）

| 特点 | 值得借鉴 |
|------|---------|
| 先回 VLESS/Trojan 协议响应头再中继 | 避免客户端把首包判为协议错误 |
| 内置订阅生成 + 面板一体化 | 与 CFPilot 面板形态一致 |
| 代理池（ProxyIP / SOCKS5）配置面 | 与 CFPilot 现有的 `proxy-pool.ts` 对齐 |
| XHTTP / gRPC 支持 | 传输层可扩展 |

### 3.3 CFNext（PAICNI/CFNext，vendor 当前实现）

| 特点 | 值得借鉴 |
|------|---------|
| `Bt()` 出站三级候选：`m()` 直连目标 → `h()` 同区域优选 IP 竞速 → `g()` 走 outboundProxy | **候选顺序**设计：直连优先，优选 IP 次之，代理兜底 |
| `Ct(ip, 4000)` = `connect(ip, port)` + 等 `socket.opened` | 拨号语义（**注意**：直接连 CF IP 会被拒） |
| `Ge()` 探测 + `Ft()` DoH 解析优选 IP | 优选 IP 的来源是**域名解析**，不是硬编码网段 |
| `lt(env)` 配置加载器（env + KV `config` 键整体覆盖） | 与 CFPilot 现有 `config.ts` 的三层优先级同构 |
| `Object.assign(默认, kvConfig)` 整体覆盖 | 已在 §0.18/0.19 讨论过，**CFPilot 不应写这个键** |
| 特征码字典 + 字符串拆分 | 静态特征规避 |

### 3.4 三者共同的架构事实

> **出站要么直连第三方 IP，要么经外部代理隧道；不能指望 Worker 直连 Cloudflare 自家 Anycast。**

这与 §1.2 的实测完全一致，也是新旧实现的分水岭。

---

## 4. 自研数据面设计

### 4.1 总体架构

```
客户端 ──VLESS/Trojan over WS──> 数据面 Worker
                                  │
                    ┌─────────────┴─────────────┐
                    │  ① 协议解析（VLESS/Trojan）  │
                    │  ② 出站选路（三级候选）      │
                    │  ③ 隧道建立 + 双向中继        │
                    └─────────────┬─────────────┘
                                  │
              候选 A：直连第三方 IP:端口
              候选 B：优选 IP（DoH 解析的第三方 IP）
              候选 C：经 SOCKS5 / HTTP 代理 → CONNECT 隧道
```

### 4.2 与旧代码的关键差异

| 维度 | 旧代码 | 新设计 | 依据 |
|------|--------|--------|------|
| **出站选路** | 优选库全是 CF 网段 → 必然 Loop | 候选**按可达性排序**，CF 网段 IP 降权/排除 | §1.2 |
| **同区域过滤** | `kind === 'direct'`（错） | 按**代理种类**分组：SOCKS5 / HTTP 各自优选 | §2 缺陷 A |
| **优选 IP 来源** | 硬编码 CF 网段 | DoH 解析**第三方域名**得到 IP | §3.3 `Ft()` |
| **失败可诊断** | catch 里吞掉，只返回 null | 分级记录**哪一级候选失败、失败原因** | §2 缺陷 C |
| **协议响应头** | 先回响应头再中继 | 保留（BPB 做法） | §3.2 |
| **首包缓存** | 有（cfnew 做法） | 保留 | §2 |
| **TLS** | 无 | 走 `secureTransport: 'on'`，不在应用层做 TLS | §1.4 |

### 4.3 出站选路（核心算法）

```
candidates(target, config, colo):
  A. 直连 target
     - 若 target 是 CF 网段 IP → 降权（最后尝试），避免确定性失败
  B. 优选 IP 库（DoH 解析第三方域名得到）
     - 按 colo 同区域优先
     - 竞速取最先成功者
  C. 代理池（ProxyIP / SOCKS5 / HTTP）
     - ProxyIP：连到该 IP，由它转发到 target
     - SOCKS5 / HTTP：握手后 CONNECT target
```

**关键约束**（来自 §1.2，写进代码注释）：
> 绝不把「Cloudflare Anycast IP」当作首选出站目标。
> 这类地址在 Worker 运行时**必然**被拒（`TCP Loop detected`），
> 表现为「代理永远连不上」且无任何错误线索。

### 4.4 与现有 CFPilot 的衔接

- **协议解析**：`src/protocols/vless.ts` / `trojan.ts` 已存在且有测试，可直接复用
- **代理池解析**：`src/outbound/proxy-pool.ts` 已存在
- **SOCKS5 / HTTP 客户端**：`src/outbound/socks5.ts` / `http-proxy.ts` 已存在
- **需要重写**：`src/outbound/dial.ts`（选路 + 错误可诊断）
- **新增**：优选 IP 的 DoH 解析（`src/outbound/doh.ts` 需从归档恢复并修正）

### 4.5 部署期风控规避（基于 §0.19.4 与用户补充）

用户补充的事实：**滥用邮件从第一次测试部署就收到、几十封一模一样、账号本身健康**。
结合实测（同配置 6/6 成功、原样重试即成功），可判定：

- 风控判定**与内容无关**，是账号级的**间歇性**判定
- 每次判定命中就发一封邮件 → 邮件数量 = 被判定次数
- 应对：**部署失败先原样重试，再换名**（已实施，见 §0.19.4）

另可降低命中概率的做法（待验证）：
- 特征码字典混淆字符串（edgetunnel / CFNext 都这么做）
- 避免在产物里出现完整协议 URI 特征串（现有 `sub-engine.ts` 已有此做法，注释见 `vlessUri`）

### 4.6 多实例并存

用户要求：支持一个账号同时跑多个 CFPilot 实例。
配合 [docs/kv-instance-isolation.md](kv-instance-isolation.md) 的 KV 归属校验，
每个实例用自己的 KV；自研数据面不改变这个约束。

---

## 5. 实施状态（2026-10-23）

### 已完成

| 阶段 | 内容 | 状态 |
|------|------|------|
| 1 | 归档代码复用到 `src/outbound/`，修正选路算法 | ✅ `src/outbound/route.ts` + 24 项测试 |
| 2 | 出站选路重写 + 分级错误诊断 | ✅ `buildRouteCandidates()` / `classifyDialFailure()` |
| 3 | 真机部署验证 | ⚠️ **WS 升级已通（101），但出站代理链路未完成验证**（见下） |
| 4 | **DoH 优选 IP 库接入** | ✅ `src/outbound/doh.ts`，机制对齐 vendor `Ft()` / edgetunnel 预加载竞速 |
| 5 | **代理池落地**（SOCKS5 / HTTP CONNECT / HTTPS） | ✅ 三种类型全部进选路，且与直连**互斥** |
| 6 | 特性开关：自研 / vendor 可切换 | ✅ `DATAPLANE` 环境变量 + `--dataplane` CLI 参数 |

### 代码产出

| 文件 | 说明 |
|------|------|
| `src/outbound/route.ts` | **新增**：出站选路（CF 网段降权、代理优先、优选 IP 排序）+ 失败分级 + 候选分组 |
| `src/outbound/doh.ts` | **新增**：DoH 解析（TXT 优选库 → A → AAAA），含**严格判定**与 5 分钟缓存 |
| `src/outbound/dial.ts` | 改造：`dial()` 走选路结果；新增 `optimizedIps` / `resolvePreferred` / `onFailure`；支持 `secureTransport` |
| `src/outbound/proxy-pool.ts` | 改造：新增 `https` 代理类型（代理服务器本身走 TLS） |
| `src/outbound/http-proxy.ts` | 改造：支持 `Proxy-Authorization`（此前解析了凭据却没发出去） |
| `src/protocols/websocket-self.ts` | **新增**：自研 WS 数据面（协议解析、攒包、首包缓存、响应头先回） |
| `src/protocols/dataplane.ts` | **新增**：实现选择逻辑（独立成模块，避免加载 vendor 的 sockets） |
| `src/protocols/websocket.ts` | 改造：按 `DATAPLANE` 分派 vendor / self |
| `src/routes/data.ts` | 改造：读取 `DATAPLANE` 并传入 |
| `src/config.ts` / `src/types.ts` | 新增 `resolvePreferred` 配置项 + `RESOLVE_PREFERRED` 环境变量 |
| `src/ui/panel.html` | 新增「出站前自动 DoH 解析优选 IP」开关 |
| `deploy-wizard` | `--dataplane <vendor\|self>`、`--resolve-preferred=false`，注入数据面环境变量 |

### 本轮（第二阶段）实现的三个关键决策

#### ① 代理与直连**互斥**，不共用竞速池

用户显式配置代理是为了让流量**从指定出口出去**。
若代理候选与直连候选同池竞速，直连一旦先成功就会**静默绕过代理** ——
出口 IP 与用户预期不符，且没有任何报错（最难察觉的一类故障）。

现语义对齐 edgetunnel 的 `connecttoPry`：
- 有代理 → 只走代理；代理全失败 → 抛错（**不**静默改走直连）
- 无代理 → 走直连 / 优选 IP

实现：`route.ts` 的 `groupCandidates()` 把候选分成 `proxy` / `direct` / `fallback` 三组，
`dial.ts` 据此分派。**降权候选（CF 网段）单独成组**，最后才试。

#### ② DoH 优选库必须**严格判定**，不能"挑出形似 IP 的片段"

目标域名的 TXT 记录**绝大多数不是优选 IP 库**。实测样例：

```
example.com        TXT "v=spf1 -all"
example.com        TXT "_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9"
www.cloudflare.com TXT "canva-site-verification=oOyaVnHC-OiFoR1BPvetNA"
github.com         TXT "MS=6BF03E6AF5CB689E315FB6199603BABF2C88D805"
```

若只做「从记录里挑出形似 IP 的片段」，`v=spf1 ip4:1.2.3.4 -all` 这类 SPF 记录
会被误当成优选 IP 库 —— 于是所有出站都被悄悄导向 `1.2.3.4`，**且没有任何报错**。

因此 `parseTxtIps()` 采用**整体判定**：整条记录必须全部是 IP / host:port，
混有其它 token 就整条判为「不是优选库」，退回 A / AAAA 解析。

#### ③ 候选排序必须**稳定**

`Array.prototype.sort` 在 V8 里对长度 > 10 的数组改用 TimSort（**非稳定**），
会让同权重候选的相对顺序变得不确定 —— 竞速时「谁先试」随机，排查时无法复现。
现改为「权重 + 原始下标」的稳定排序。

### ✅ 打包验证：自研代码确实在部署产物内（2026-10-23 补充）

这一点必须验证，否则 `--dataplane self` 只会静默退回 vendor。

用 esbuild `metafile` 核对 `dist/dataplane.js`（`entry-data.ts`）的实际模块构成：

| 模块 | 源大小 | 是否在包内 |
|------|--------|-----------|
| `src/vendor/cfnext-dataplane.js` | 360 KB | ✅ |
| `src/protocols/websocket-self.ts` | 9.4 KB | ✅ |
| `src/outbound/route.ts` | 9.1 KB | ✅ |
| `src/protocols/dataplane.ts` | 746 B | ✅ |

即 **vendor 与自研两套实现同时在产物里**，`DATAPLANE` 决定运行时走哪一套。

> ⚠️ 排查提示：直接 `grep "自研数据面" dist/dataplane.js` 会**搜不到**，
> 因为 esbuild 默认 `charset: 'ascii'` 会把中文字符串转义成 `\uXXXX`，
> 同时 `minify` 会重命名函数。验证打包内容请用 esbuild `metafile`，不要用字符串 grep。

静态 `cloudflare:sockets` 导入仍然只有 **vendor 一处**（原本就有），
自研路径经 `outbound/dial.ts` 的动态导入取得 `connect()`，未新增静态特征。

### ✅ 阶段 3 的验证现状（2026-10-23 真机验证完成，闸门已过）

> 本节在 2026-10-23 被**真机验证重写**。此前记录的是「未能稳定复现」，
> 根因是**验证方法不对** + **实现确有两个缺陷**。下面是最终结论。

#### 验证手段：两层

1. **本地 workerd（`wrangler dev --local`）** —— 用真实 Workers 运行时，
   出站是**真实 TCP**。已实测 workerd 本地**完整支持** `cloudflare:sockets`
   （导入 / connect / 数据交换全部成功），因此本地可以验证整条出站链路。
2. **真实 Cloudflare Pages 部署** —— 用 `--dataplane self` 部署后真机采样。

配套工具在 **`packages/worker-core/scripts/selfdp-e2e/`**（已固化为可复用脚本，含 README）：
明文 HTTP 回显服务器、VLESS 测试客户端（`client.mjs` / `suite.mjs`）、SOCKS5 代理（`socks5-proxy.mjs`）、
多次采样统计（`probe2.mjs`）。

一键跑法：

```bash
npm run e2e:echo -w @cfpilot/worker-core     # 起出站目标（明文 HTTP 回显服务器）
npm run e2e:dev  -w @cfpilot/worker-core     # 起本地 workerd（DATAPLANE=self）
npm run e2e:test -w @cfpilot/worker-core     # 跑测试套件（预期 7/7）
```

#### 本地 workerd 结果（7/7 通过）

| 场景 | 结果 |
|------|------|
| VLESS 响应头 `[0,0]` | ✅ |
| 目标站真实响应回传 | ✅ 446 字节，含回显标记 |
| 目标站收到正确请求 | ✅ method / path / query 均正确 |
| **1MB 负载逐字节完整** | ✅ 1048576 / 1048576 字节，无一字节错 |
| 错误 UUID 被拒绝 | ✅ 无响应头、无数据回传 |
| 不可达目标给出分级诊断 | ✅ close 1011 + 逐候选原因 + 修复建议 |
| **SOCKS5 代理路径** | ✅ 代理日志证实 109B 请求 / 446B 响应全部经由代理 |

#### 真实 Cloudflare 结果

部署：`jyhii42d4-0tkb.pages.dev`（`DATAPLANE=self`），UUID `2bce16b3-…`，WS 路径 `/y1i9n7d8c0`。

| 采样 | 目标 | 结果 |
|------|------|------|
| 8 次 | `neverssl.com:80`（解析到 `34.223.124.45`，非 CF 网段） | **upgrade 8/8、VLESS `[0,0]` 8/8、真实 HTTP 响应 6/8、正常关闭 6 次** |
| 4 次 | `example.com:80`（解析到 `172.66.147.243` / `104.20.23.154`，**全是 CF 网段**） | VLESS `[0,0]` 4/4，但**出站必然失败**（符合预期，见下） |

> ✅ **结论：自研数据面的出站链路已在真实 Cloudflare 上被完整证明可用。**
> 这是本项目自研数据面第一次通过阶段 3 闸门。

#### ⚠️ 验证过程中发现并修复的两个**真实缺陷**

##### 缺陷 1：响应头必须在出站建连**之前**回（时序错误）

原实现是「先 `await` 出站建连成功，再回协议响应头」。
本地 workerd 实测直接报错：

```
Workers runtime canceled this request because it detected that your Worker's code had hung
```

出站稍慢，客户端就一直等不到响应头。

**修正**：认证通过后**立即**回响应头，出站在后台进行；失败则用 close 1011 + 分级原因告知。
与 vendor（CFNext `d(new Uint8Array([0,0]))`）和 BPB 的做法一致。
（认证本身在 `parseTarget` 里已完成，回响应头不会引入安全漏洞。）

##### 缺陷 2：目标域名解析到 CF 网段时，域名直连**必须降权**

**实测证据**：

```
example.com      → 172.66.147.243, 104.20.23.154   ← 全是 Cloudflare 网段 → 出站 100% 失败
neverssl.com     → 34.223.124.45                    ← 第三方 IP           → 出站成功
```

把域名丢给 `connect()` 让运行时自己解析，得到的必然是 CF Anycast 入口 → 被平台拒绝。
而**直连候选原本排在最前**（primary 组），会先白白耗掉一次超时。

**修正**：`RouteInput` 新增 `deprioritizeDirect`；
`dial()` 在「成功解析且结果全为 CF 网段」时把域名直连降权，
优先用解析出的第三方 IP 建连。

#### 本轮新增的两个测试坑（写给后续维护者）

1. **workerd 的文本帧（opcode 1）不会进入服务端的二进制处理分支**：
   发文本帧 → 服务端收到 0 字节。必须发**二进制帧**（opcode 2）。
2. **VLESS 地址字段的长度字节不能被域名首字符覆盖**：
   布局是 `[类型(1)] + [长度(1)] + [域名]`，写成 `[类型] + 域名` 会让
   域名首字符（如 `'1'` = 0x31）当成长度，解析全错。

### ✅ 第三阶段：vendor vs self 对照实验 → 自研成为默认（2026-10-23）

#### 对照实验设计

**同一 Cloudflare 账号、同一时段、同一客户端、同一目标**，两个实例各自独立 KV：

- 部署 `DATAPLANE=vendor` 与 `DATAPLANE=self` 两个实例；
- **交替采样**（A→B→A→B…）而不是「先测完 A 再测完 B」——
  后者会把时段差异（边缘拦截窗口、网络抖动）误判成实现差异；
- **真实 TLS 客户端首包**：手工构造合法 ClientHello（`clienthello.mjs`）。
  手写简化版会被目标站直接 RST，连回包都收不到，测不出真实差异；
- 目标分两类：**非 CF 网段**（`github.com:443`）与**全 CF 网段**（`example.com:443`）。

#### 结果（真实 Cloudflare，真实 TLS 首包）

| 目标 | vendor | self |
|------|--------|------|
| 非 CF 网段 `github.com:443` | 100% | **100%** |
| 全 CF 网段 `example.com:443` | 73% / 80% | **67% / 100%** |

（两轮 15 样本；vendor 自身在 73%~100% 间波动 —— 第三方反代池本身不稳定。）

#### 过程中发现并补齐的**关键能力**：反代入口

**第一次对照时 self 在 CF 网段目标上是 0%，vendor 是 100%** —— 差距的根因：

> vendor 内置一张第三方反代域名表：
> `proxyip.{hk,us,jp,...}.cmliussss.net`（`__D = "cmli"+"ussss"+".net"`），
> 运行时解析出 IP 直连。这些域名指向**动态轮换的 IP 池**
> （CNAME → `proxyip.fast-ip.eu.org`）。
>
> 反代入口是**第三方服务器**，收到客户端的 TLS ClientHello 后按 **SNI** 转发到目标：
>
> ```
> Worker ──connect(反代IP:443)──> 第三方反代（按 SNI 转发）
>        ──透传客户端 ClientHello(SNI=example.com)──> Cloudflare 边缘
> ```
>
> 出口是第三方 VPS 而非 Cloudflare 自己的边缘，**不触发 TCP Loop 限制** ——
> 这是打通 CF 网段目标的唯一办法。
>
> 自研原先只有「DoH 解析 + CF 网段降权」，**缺这一层**，
> 于是 CF 网段目标必然失败（降权后没有任何可用候选）。

补齐后（新增 `src/outbound/relay.ts`），自研实现了同一机制，且**可配置、可关闭**：

- 用户可在面板填自己的反代入口（`relayPool`），**完全不依赖第三方**；
- 内置表可用 `USE_BUILTIN_RELAY=false` 关闭；
- **按当前边缘机房（colo）优先选地区**（与 vendor 的 `_Zc()` 同构）；
- **缓存必须短**（30 秒而非 5 分钟）：反代域名指向动态轮换池，
  长缓存会拿到已失效的 IP —— 这是成功率上不去的主因之一。

#### 三个优化迭代（实测数据驱动）

| 改动 | CF 网段目标成功率 |
|------|------------------|
| 无反代入口 | **0%** |
| 反代入口一次性全量并发（53 个） | 70% |
| 限到 8 个候选 | 40% ← 备选太少，命中概率低 |
| 分批（每批 8 个，批间串行） | 33% ← 串行等待耗尽客户端预算 |
| 每域名 4 个 + 短缓存 + colo 优先 + 轮转 | **67% → 100%** |

结论：**候选要多、地区要分散、缓存要短**。

#### 结论：自研成为默认数据面

`resolveDataPlaneImpl()` 缺省改为 `self`；`DATAPLANE=vendor` 可切回 CFNext。
理由：可用性已持平（甚至更好），而自研额外提供：

- **失败分级诊断**（vendor 把异常吞成「目标不可达」）；
- **代理池**：SOCKS5 / HTTP CONNECT / HTTPS（vendor 只读 `PROXYIP`）；
- **DoH 优选解析** + Cloudflare 网段降权；
- **反代入口可配置**（不依赖第三方）；
- **降权候选稳定排序**（竞速顺序可复现）。

### ✅ 第四阶段：代理路径与自配反代入口的真机验证（2026-10-23）

#### 一、自配反代入口：端到端路径已通

验证路径完全走**用户真实操作路径**（面板 API → KV → 数据面）：

```
PUT /api/v1/config  {relayPool:"45.192.247.177", useBuiltinRelay:false}
  → KV CONFIG 确认 relayPool / useBuiltinRelay
  → 数据面出站 → example.com:443（全 CF 网段，直连必然失败）
  → 4/4 成功（收到目标站 TLS 响应）
```

**内置表关闭 + 只配自营入口仍成功** —— 证明生效的确实是「用户自配」这条来源，
而不是内置表兜底。

#### 二、代理路径

| 代理类型 | 结果 | 说明 |
|---------|------|------|
| **SOCKS5**（代理池 3 个） | ✅ **10/10** | 每次收到 httpbin 真实响应（499 字节） |
| **HTTPS 代理**（`secureTransport:'on'` + CONNECT，代理池 3 个） | ✅ **5/10** | 成功时收到真实响应（498/499 字节）；失败是公共代理本身不稳定 |
| **HTTP CONNECT**（明文） | ⚠️ **真机未单独验** | 组合已被上面两项覆盖：TCP 层 = SOCKS5 路径（普通 `connect()`），握手层 = HTTPS 路径（同一份 `httpConnect()`）。公共明文 HTTP 代理几乎都不支持 CONNECT 隧道（实测 190+ 个全部失败） |

> ⚠️ **本表的 HTTPS 一行已被第六阶段修正**：当时的 `secureTransport` 实际上**没生效**
> （参数放错了位置，见 §6「第四阶段补充」），所以那 5/10 的「成功」是巧合 ——
> 公共代理恰好也接受明文 CONNECT。第六阶段用自建代理重测后，
> HTTPS 代理的真实约束是「**必须域名 + 公信 CA 证书 + SNI 匹配**」。

**关键观察**：SOCKS5 代理池 10/10，而单代理 1/8 ——
**代理池的竞速机制让单个不稳定代理的问题被掩盖**。
这正是自研相对 vendor 的优势（vendor 只读 `PROXYIP`，没有代理池竞速）。

#### 三、真机发现的三个**真实缺陷**（本地测不出来）

##### 缺陷 3：代理握手无超时 → **静默挂起 45s+**

把不支持 SOCKS5 的服务器配成 SOCKS5 代理时：
`readExactly()` 没有超时 → 永远等不到协议响应 → 数据面**既不报错也不关闭**，
客户端一直连着（本地 workerd 表现正常，只有真机暴露）。

**修复**：`outbound/socks5.ts` 与 `outbound/http-proxy.ts` 的握手读取全部加超时（6s），
超时后抛错 → 上层按「代理握手失败」分级上报。

##### 缺陷 4：close frame 的 reason 超 123 字节 → **Cloudflare 边缘静默丢弃整个 close frame**

诊断信息（`explainDialFailure` 的多行说明）约 283 字节，远超 RFC 6455 规定的 123 字节。
真机表现：**close frame 根本不发出**，客户端静默挂起；
而本地 workerd 宽容地照发，能正常关闭。

**修复**：`websocket-self.ts` 的 `closeWith()` 统一截断到 123 字节
（按**字节**算，且省略号本身占 3 字节，必须在追加后再检查一次）。

> ⚠️ 曾经的修复漏了「追加省略号后再检查」，结果仍超 1 字节，
> 真机依旧不 close —— 这个坑只有真机能暴露。

##### 缺陷 5：完整诊断没有出口

close reason 装不下完整诊断（且超长会被丢弃）。
**修复**：新增数据面诊断端点 `GET /__diag`（自研专有），
返回最近 20 条完整诊断（失败类型 / 原始消息 / 候选 / 多行说明）。

```json
{
  "ok": true, "impl": "self",
  "recent": [{
    "at": 1792728772297,
    "target": "httpbin.org:80",
    "failures": [{ "kind": "blocked", "message": "...", "candidate": "HTTP 45.74.31.40:5292" }],
    "summary": "出站被 Cloudflare 拒绝（...）：...\n  常见原因：...\n  → 换一个第三方 IP，或改用代理落地。"
  }]
}
```

这是自研相对 vendor 的核心优势落地：**vendor 把异常吞成「目标不可达」，什么都不留**。

### ✅ 第五阶段：订阅形态选择 + 优选 IP 质量修正（2026-10-23）

用户实测反馈三个问题，全部定位并修复。

#### 问题 1：默认下发 30 个节点，订阅却有 90 个

**根因**：老的两个独立开关 `subProtocol`（vless/trojan/both）× `subTransport`（ws/xhttp/both）
交叉后必然生成三种形态 → 节点数被**乘三**。

**修复**：新增 `subVariants`（多选），面板给三个复选框（默认只勾 `vless-ws`）：

| 形态 | 说明 |
|------|------|
| `vless-ws` | VLESS + WebSocket（兼容性最好，默认） |
| `vless-xhttp` | VLESS + XHTTP（仅 Xray 内核） |
| `trojan` | Trojan over WebSocket |

配套规则（`resolveSubVariants()`）：
- 形态依赖的入站**没启用就自动剔除**（`enableXhttp=false` → 不下发 XHTTP 节点）；
- Clash / sing-box **不支持 XHTTP** → 这些格式里跳过 XHTTP 形态（否则订阅为空）；
- 一个都没剩时回落到 `vless-ws`（保证订阅不为空）。

实测：默认 30 条；勾选三种 → 90 条。

#### 问题 2：XHTTP 与 Trojan 节点延迟全是 -1

**Trojan 服务端实现是正确的** —— 用真实 Trojan 握手在真机验证：
收到目标站的完整 HTTP 响应（458 字节）+ 正常关闭。

**XHTTP 有两个真实 bug**（都是本地测不出来的）：

##### bug A：`relay()` 关闭了 socket 的写流

`relay()` 在源流结束时调 `writer.close()`。
对 `cloudflare:sockets` 的 writable，这等于**关闭整个 TCP 连接** ——
目标站收到 RST，来不及把响应发回来。
症状：握手成功但**永远收不到数据**（客户端侧就是延迟 -1）。

对比：WebSocket 入站路径只 `releaseLock()` 不 `close()`，所以一直正常。

**修复**：`relay()` 增加 `closeTarget` 参数（默认 true），
socket 场景传 `false`（只释放锁，不关连接）。

##### bug B：`async start` 阻塞了下行读取

```ts
new ReadableStream({ async start(controller) { /* 读整个下行 */ } })
```

`start` 返回的 Promise 未完成时，流的 `pull` **不会被调用**，
而消费者（fetch / Xray 客户端）会一直等 ——
表现为「响应头到了，但后续数据永远不来」。

**修复**：`start` 只入队响应头并立即返回；下行数据在 `pull` 里按需读取。

##### 附带：XHTTP 的 `dial()` 少了两个参数

`resolvePreferred` 与 `relayPool` 没传 → XHTTP 用运行时自己的 DNS 解析，
可能命中 Cloudflare 网段（连不回自家 Anycast）。已与 WS 路径对齐。

#### 问题 3：vless+WS 节点一开始可用，后来全部失效

**根因**：部署向导在数据面因 `8000119` **换名重建**后，
控制面的 `DATA_HOST` 仍指向**已删除的旧域名** →
订阅里每个节点的 `sni` / `host` 都指向不存在的域名 → 全部失效。

**修复**（`packages/deploy-wizard/src/pages-deploy.ts`）：
数据面部署完成后，比对控制面当前的 `DATA_HOST` 与实际数据面域名，
不一致就**重新配置控制面**（环境变量可随时改，无需重新部署）。

> 这个修复在真机上被触发验证了两次（每次部署都遇到 8000119 换名，
> 日志都正确打印「控制面 DATA_HOST 仍指向旧域名 → 正在同步」）。

#### 顺带：官方优选 IP 池的质量修正

**实测发现**（`curl --resolve` 逐段测 WebSocket 升级是否返回 101）：

```
104.16 – 104.25   8/8  ✅ 主力通用 Anycast 段
104.26            2/8
104.27            6/8
104.28 – 104.31   0/8  ❌
172.66 – 172.67   6/8
172.64/65/68-71   0/8  ❌
162.158 / 188.114 / 198.41 / 108.162 / 141.101
173.245 / 103.21 / 103.22 / 103.31
190.93 / 197.234 / 131.0.72        0/8  ❌
```

旧 CIDR 表 15 个段里 **13 个完全不可用** —— 随机采样命中率约 1/4，
于是订阅里大半节点是坏的，客户端测速一片 -1。

**修复**：
- `CF_IPV4_CIDRS` 换成实测可用的 3 个段；
- `CURATED_OFFICIAL_IPS` 从 10 个扩到 **27 个**（逐个验过）。

> ⚠️ 可用段与**具体站点**有关（CF 按站点分配），
> 但 `104.16.0.0/11` 是主力通用段，对绝大多数站点都可用。
> 想完全对齐自己的站点，用面板的「本地真连接优选」实测筛一遍最准。

### ✅ 第六阶段：代理池三类真机验证 + HTTPS 代理根因修正（2026-10-23）

在用户提供的国内阿里云服务器（`47.104.173.139`，CentOS 7.8）上，
用自建代理分别验证 SOCKS5 / HTTP CONNECT / HTTPS(TLS) 三条出站路径。

#### 一、结果

真实 Pages 数据面 + 真实 VLESS 会话 + 自建代理：

```
=========== socks5 ===========   ✅✅✅   出站成功 3/3
=========== http  ===========   ✅✅✅   出站成功 3/3
=========== https ===========   ✅✅✅   出站成功 3/3
```

代理端日志佐证流量确实经代理（不是静默直连）：
```
[#11] TLS 握手完成 from 104.28.157.104:34778（SNI="exammaster.zzzjl.com"）
[#11] CONNECT httpbin.org:80 隧道已建立
[cfp-proxy] SOCKS5 CONNECT httpbin.org:80
[cfp-proxy] HTTP CONNECT httpbin.org:80
```

#### 二、🔴 HTTPS 代理的根因被推翻并修正

第四阶段判定「HTTPS 代理失败 = 自签证书不被信任」—— **这是错的**。
真机取证把它拆成三层：

| 层 | 当时的判断 | 实测结论 |
|----|-----------|---------|
| ① TLS 没生效 | 「`'on'` 是惰性 TLS，明文 CONNECT 被当 ClientHello」 | ❌ 错 —— `secureTransport` **压根没传到运行时** |
| ② 证书不被信任 | 「自签证书被 CF 拒绝」 | ❌ 部分错 —— 自签确实被拒，但主因是别处 |
| ③ 真正根因 | — | ✅ **`connect(address, options)` 的 options 放错了参数位** |

`@cloudflare/workers-types` 的声明：
```ts
function _connect(address: string | SocketAddress, options?: SocketOptions): Socket;
interface SocketOptions { secureTransport?: string; allowHalfOpen: boolean; }
interface SocketAddress { hostname: string; port: number; }
```

旧代码把 `secureTransport` 塞进**第一个**参数：
```ts
connect({ hostname, port, secureTransport })                    // ❌ 运行时静默忽略
connect({ hostname, port }, { secureTransport })                 // ✅
```

TypeScript 放过多余字段，运行时静默忽略 → socket 实际是明文 →
对端 TLS 服务器看到明文报 `HTTPS_PROXY_REQUEST`；
调 `startTls()` 则抛「The `secureTransport` socket option must be set to 'starttls'」。

> **定位手法**：`socket.secureTransport` 是只读 getter（返回
> `"off" | "on" | "starttls"`）。打印它即可确认选项有没有真生效 ——
> 比从报错文案反推快得多。

#### 三、修正后的真机结论

| 模式 | 结果 |
|------|------|
| `secureTransport:'on'`（options 放对） | `socket.opened` 直接 reject：「proxy request failed, cannot connect to the specified address」 |
| `secureTransport:'starttls'` + `startTls()` | **进入 TLS 握手阶段**（能拿到具体握手错误） |
| `starttls` + 自签证书 | 服务端收到 `remote error: tls: unknown certificate authority` |
| `starttls` + 用 IP 连接（证书签给域名） | 服务端收到 `remote error: tls: bad certificate` |
| `starttls` + **域名连接 + SNI 匹配 + 公信 CA 证书** | ✅ **握手成功，CONNECT 隧道建立** |

**关键结论：`'on'` 与 `'starttls'` 都会校验证书** ——
workerd 的 TLS 能力只有 `TlsOptions = { expectedServerHostname?: string }`，
**没有 `ca` / `rejectUnauthorized` / 自定义信任链的入口**，自签证书无解。

两者区别只在**失败时机**：`'on'` 在 `opened` 阶段就挂（拿不到可诊断信息），
`'starttls'` 能进到握手阶段。所以生产实现选 `'starttls'`。

#### 四、代码改动

| 文件 | 改动 |
|------|------|
| `outbound/dial.ts` | `ConnectFn` 改成 `(address, options?)`；`secureTransport` 移进第二个参数；`startTls()` 支持 `expectedServerHostname`；错误信息细化为「TLS 握手超时」；catch 分支关闭升级后的 socket |
| `outbound/proxy-pool.ts` | `ProxyEndpoint` 加 `serverName`；`https://` 条目域名 host 自动作 SNI；支持 `#sni=example.com` 后缀；IP 形式不推导 SNI |
| `outbound/route.ts` | `via` 透传 `serverName` |
| `ui/panel.html` | HTTP 代理输入框提示补充 `https://` 与 `#sni=` 用法 |
| `test/proxy-sni.test.ts` | 新增 7 个用例 |

#### 五、⚠️ 测试环境上的三个坑（都不是代码缺陷）

1. **CentOS 7 的 OpenSSL 1.0.2k 不支持 TLS 1.3** ——
   而 CF 边缘的 `startTls()` **只发 TLS 1.3 ClientHello**。
   症状隐蔽：Python `ssl` 当服务端时握手**永远挂起**，
   表现为「63 条 ESTABLISHED 连接堆积、Recv-Q 有数据但服务端不读」，不是明确报错。
   → 换 Go 写的静态编译代理（`CGO_ENABLED=0 GOOS=linux go build`）才通。
2. **本地 workerd 拒绝连私有 IP**（`127.0.0.1` / `192.168.x`），
   错误文案与真机的「CF 网段被拒」**完全一样**，极易误判。
   → 验出站用公网 IP 目标或直接上真机。
3. **Pages 部署 `_worker.js` 的 metadata 不能带 `compatibility_date`** ——
   带了就让 Pages 忽略 `_worker.js`，表现为「部署成功、HTTP 200、返回默认 Welcome 页」。
   正确格式只有 `{ main_module: '_worker.js', bindings: {} }`。
   另：Pages 绑定与变量**只对之后的部署生效**（顺序：建项目 → PATCH 设变量 → 部署）；
   且 PATCH 会自动触发一次部署，之后再 POST `/deployments` 就是二次部署 → 触发 `8000119`。

#### 六、阿里云服务器清理（用户要求「不破坏网站项目」）

全部还原：测试进程 3→**0**；监听端口 39080-39082/39182 4→**0**；
`/tmp/cfp-test/` **已删除**；firewalld 临时端口放行 **已移除**；
CF 网段 rich rules 45→**0**（45 条全是测试期间加的）；临时 Docker 镜像 **已删除**。

**未受影响（已验证）**：5 个站点目录完好；HTTP 全部正常（301/200/302/200/200）；
`exammaster.zzzjl.com` HTTPS 200；`nginx`/`mysqld`/`docker` 均 `active`；
容器 `easytier`/`easytier-web`/`watchtower`/`edumaster_api`/`edumaster_postgres` 全部存活。

### 下一步（第七阶段）

1. **DoH 优选路径真机验证**：「TXT 优选库」这条路径需要特定域名才能验。
2. **反代入口池的质量提升**：内置表 14 个域名的实际可用率与地域分布仍需长期采样。
3. **代理池的真实用户场景压测**：竞速机制在 10+ 代理、长时间运行下的表现。

### 关于「自研 vs vendor」的现状判断

自研实现已具备**协议层完整性与可诊断性**（失败会说明是被平台拒绝还是超时），
vendor 实现在同一环境下的**出站选路不可诊断**（异常被吞，表现一致）。
但两者在**运行时边缘拦截**面前表现相同 —— 说明拦截发生在更前面一层，
与数据面实现无关。

因此建议：**自研实现继续推进，但默认仍用 vendor**（`DATAPLANE` 缺省即 vendor），
等优选库与代理池完成、用明文 HTTP 目标站真机跑通出站链路后，再考虑切换默认值。

---

## 6. 待验证 / 待澄清

1. **用户自己的 CFNext 项目与自研数据面能否共存？**
   自研数据面不写小写 `config` 键（§0.18），理论上不冲突，需真机确认。
2. **`secureTransport: 'on'` 在 Pages 上是否稳定？**
   实测单次成功，需多次重复确认稳定性。
   （用途已收窄为「HTTPS/SSTP 代理服务器」，见 §1.4d）
3. **CFNext 的 `proxyip.<地区>.<域名>` 域名从哪来？**
   需查其仓库/文档；若依赖第三方服务，需评估可用性与合规性。
4. **BPB-Worker-Panel 的数据面实现细节**
   需 clone 后精读（本次仅从 HANDOVER 记录与公开信息了解其做法）。
5. **edgetunnel 的「预加载竞速」（构建预加载竞速候选列表）机制**
   已确认它与 CFNext 的「DoH TXT 优选 IP」是同一思路的两个变体：
   前者预解析并缓存，后者每次解析。自研取 CFNext 路线（实现更简单、无预热延迟）。

---

## 7. 免责

本项目仅供学习与自建网络研究使用，使用者需自行遵守所在地法律法规与 Cloudflare 服务条款。
