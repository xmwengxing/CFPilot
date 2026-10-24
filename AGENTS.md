# CFPilot — Agent 架构规范（AGENTS.md）

本文件是 CFPilot 项目对所有自动化 Agent / 贡献者的**硬性约束**。
开始编码前请完整阅读本文件。

---

## 0. 项目一句话描述

CFPilot 是一个运行在 Cloudflare Workers 上的**代理微内核 + 真连接优选面板**：
把 VLESS-WS / Trojan-WS / VLESS-XHTTP 三种入站协议、ProxyIP / NAT64 / SOCKS5 出站、
四层优选池订阅引擎，以及解决「优选 IP 填进客户端全是 -1」的**真连接探针**，
整合进一个可一键部署的 Worker 里。

---

## 1. 不可动摇的架构铁律

> ⚠️ **部署形态唯一 = Pages 双项目**（2026-10-24 立）。
> Workers 双脚本形态曾作为实验性选项存在（提交 `3c0fa3c`），当日已**全线归档**
> （`archive/workers-deploy/`）：数据面在 Workers 上 522 无解，
> 且**实验用干净账号在少量部署后被 Cloudflare 封禁**（交接文档 §0.22）。
> **禁止**在 CLI / GUI / 文档 / 面板中重新引入 Workers 部署形态；
> 任何「用 Workers 避免 8000119」的提议一律拒绝（封号风险 >> 更新便利）。

1. **配置优先级**：`KV (CONFIG) > 环境变量 > 内置默认值`。
   任何新增配置项都必须同时支持这三层，并在 `packages/worker-core/src/config.ts` 中登记。
2. **一个 KV 命名空间 = 一个 CFPilot 部署实例**。
   内核在 KV 里用的键是**全局平铺、没有实例前缀**的
   （`CONFIG` / `PANEL_PATH` / `ADMIN_PW_HASH` / `LOCAL_PREFERRED_IPS` /
   `SESSION:*` / `SCANNER_TOKEN` / `CFP_DEPLOY_MANIFEST`），
   两个实例共用一个 KV 会互相覆盖 UUID、WS 路径、面板密码与会话。
   部署向导必须在**写入任何键之前**校验 KV 归属（`assertKvOwnership`），越界写入一律中止。
   判断归属**只能靠清单键 `CFP_DEPLOY_MANIFEST`**——标题、UUID、路径等字段值都不唯一，不能作为依据。
3. **绝不要写 CFNext 的小写 `config` 键**。
   那是 CFNext 原版的配置键，vendor 侧是 `Object.assign(默认, kvConfig)` **整体覆盖**：
   往里写会直接改坏共栖的 CFNext 项目的 uuid / path / trojanPassword。
   CFPilot 自己的数据面**不读**这个键（它读大写 `CONFIG`），写了纯属破坏。
4. **内核体积预算**：Worker 打包产物 **必须 ≤ 80KB**（`packages/worker-core/scripts/build.mjs` 会在超限时告警）。
   不要把第三方大依赖塞进 `worker-core`；面板必须是零框架的单文件 HTML。
5. **探针端点不可删除**：`/__edge_probe` 必须始终提供
   「WebSocket 101 握手校验」与「流式下行测速」两项能力，这是 CFPilot 的核心价值。
6. **优选 IP 解析器必须容错**：兼容裸 IP、`IP:Port`、`IP:Port#备注`、`[IPv6]:Port#备注`、
   优选域名，以及 CloudflareSpeedTest 风格的 `result.csv` 原文。
   清洗逻辑集中在 `packages/worker-core/src/sub-engine.ts`，禁止在别处重复实现。
7. **数据面与控制面分离**：`worker-core` 只处理代理与订阅；面板只是它的一个 HTTP 端点。
   不要在 `worker-core` 里引入 Node API（`node:*`），Workers 运行时不支持。
8. **零运行时依赖**：`scanner-cli` 与 `deploy-wizard` 不得引入第三方运行时依赖，
   必须能被 `npx -y` 秒级拉起。开发期依赖（esbuild/typescript）只允许出现在 `devDependencies`。
9. **Worker 不能连回 Cloudflare 自家的 Anycast 入口**。
   实测 `1.1.1.1` / `cloudflare.com` / `104.16.0.1` 一律被拒（报 `TCP Loop detected`），
   而第三方 IP 的 443 完全可用。
   因此出站选路**必须**把 Cloudflare 网段的候选降权（见 `src/outbound/route.ts`），
   绝不能把 CF 网段 IP 当首选出站目标。
   ⚠️ **包括「用域名直连」这种形式**：目标域名解析到 CF 网段时
   （实测 `example.com` → `172.66.147.243` / `104.20.23.154`），
   把域名丢给 `connect()` 让运行时自己解析，必然连回 CF Anycast 被拒。
   这种情况必须把**域名直连也降权**，优先用解析出的第三方 IP 建连。
10. **协议响应头必须在出站建连之前回**。
    VLESS/Trojan 的协议响应头（`[0,0]`）表示「入站已建立」，
    认证通过后**立即**回，之后出站在后台进行；失败用 close 1011 + 分级原因告知。
    早前实现是「先 await 出站成功再回响应头」，
    在 workerd 上直接报 `Workers runtime canceled this request because it detected that your Worker's code had hung`
    （出站稍慢客户端就等不到响应头）。
    vendor（CFNext）与 BPB 都是先回响应头。
11. **代理候选与直连候选必须互斥**，不能放进同一个竞速池。
    用户显式配置代理是为了让流量从指定出口出去；
    同池竞速会让直连先成功而**静默绕过代理** —— 出口 IP 与预期不符且无任何报错。
    现语义对齐 edgetunnel：有代理只走代理，代理全失败抛错。
12. **VLESS / Trojan over WebSocket 是 TLS 透传代理，Worker 不终结出站 TLS**。
    TLS 有两层：第一层「客户端 → CF 边缘」由客户端发起、CF 边缘终结；
    第二层「Worker → 目标站」由客户端与目标站直接完成，Worker 只透传字节。
    若 Worker 自己终结 TLS，会破坏端到端 TLS 语义（证书校验 / SNI / 指纹全部错位）。
    `secureTransport: 'on'` 的**唯一**正确用途是「代理服务器本身是 HTTPS」。
13. **Cloudflare 网段目标只能靠「反代入口」打通**。
    目标解析到 CF 网段时，直连与优选 IP 都会被拒（TCP Loop）——
    降权之后**没有任何可用候选**，必须经第三方反代按 **SNI** 转发出去。
    反代入口的解析**必须按需进行**（无条件预解析会拖慢每一次出站）、
    **缓存必须短**（30 秒级 —— 内置入口指向动态轮换的 IP 池，长缓存会拿到失效 IP）、
    候选**地区要分散**（按当前边缘机房 colo 优先，其次轮转其余地区）。
    用户可在面板自配入口（`relayPool`），自配入口不依赖任何第三方。
14. **WebSocket close reason 必须截断到 123 字节**（RFC 6455 §5.5.1）。
    超长时 **Cloudflare 边缘会静默丢弃整个 close frame** ——
    客户端表现为「一直连着但永远等不到关闭」（真机实测挂起 45s+），
    而本地 workerd 宽容地照发、能正常关闭。**这个差异只有真机能暴露。**
    截断必须按**字节**算，且省略号本身占 3 字节 —— 追加省略号后还要再检查一次。
15. **代理握手必须有超时**。
    代理连上但不回应协议时，无超时的读取会**永远挂起**，
    数据面既不报错也不关闭，客户端一直连着。
    `outbound/socks5.ts` 与 `outbound/http-proxy.ts` 的握手读取都必须带超时。
16. **完整诊断要有独立出口**。
    close reason 装不下多行诊断（且超长会被丢弃），
    所以自研数据面提供 `GET /__diag` 端点返回最近 20 条完整诊断。
    vendor 把异常吞成「目标不可达」，什么都不留 —— 这是自研的核心优势。
17. **socket 的写流不能 `close()`**。
    `cloudflare:sockets` 的 writable 一旦 `close()` 就等于**关闭整个 TCP 连接**
    （目标站收到 RST，来不及把响应发回来）——
    症状是「握手成功但永远收不到数据」，客户端侧表现为延迟 -1。
    转发到 socket 时只 `releaseLock()`，不 `close()`
    （见 `budget.ts` 的 `relay(..., closeTarget)`）。
18. **ReadableStream 的 `start` 不能 `async` 承载整个数据流**。
    `start` 返回的 Promise 未完成时 `pull` 不会被调用，
    而消费者会一直等 —— 表现为「响应头到了，后续数据永远不来」。
    `start` 只做初始化并立即返回，数据在 `pull` 里按需读取。
19. **优选 IP 网段必须实测筛过**。
    Cloudflare 的 IPv4 空间里大部分是区域/租户专用分配，
    对普通站点没有配置（400 或超时）。
    实测（`curl --resolve` + WS 升级校验）：
    `104.16.0.0/11` 与 `104.24.0.0/14` 可用，
    而 `104.28+`、`172.64/65/68+`、`162.158`、`188.114`、
    `198.41`、`108.162`、`141.101`、`173.245`、`103.21/22/31`、
    `190.93`、`197.234`、`131.0.72` 实测 0/8。
    **改这张表前先用实测数据说话**，别照抄。
20. **Cloudflare Workers 的 `connect()` 不支持 IPv6 出站**。
    实测（真实 Pages 部署，VLESS 入站 → 出站到 IPv6 字面量目标）：
    `2607:f8b0::200e`、`2a00:1450:...`、`2606:4700::1111` 全部**无任何响应**，
    而同一时刻 IPv4 目标正常返回。
    → 依赖「代理落地」的功能（`socks5` / `httpProxy` / `proxyIp`）时，
    代理服务器**必须有 IPv4 公网地址**，IPv6-only 的机器不可用。
    → 也不必是海外：实测边缘 → 国内 IP（baidu / qq.com / 腾讯 DNSPod）**都通**。
21. **DoH 优选库必须整体判定**。
    目标域名的 TXT 绝大多数不是优选库（实测 `example.com` 是 `"v=spf1 -all"`，
    `www.cloudflare.com` 是域名验证记录）。
    若「从记录里挑出形似 IP 的片段」，SPF 里的 `ip4:1.2.3.4` 会被误当优选 IP，
    所有出站被悄悄导向该 IP 且**没有任何报错**。
    要求整条记录全是 IP / host:port 才认，否则退回 A / AAAA。
22. **`connect(address, options)` 是两个参数，`options` 是第二个**。
    `secureTransport` 属于 `SocketOptions`（第二个参数），
    塞进第一个参数（`SocketAddress`）里**不会报错，但运行时完全看不到它** ——
    socket 实际是明文，表现为「TLS 静默失效」。
    实测症状（2026-10-23 真机）：
    - `secureTransport` 放错位置 → 明文 CONNECT 被当作 ClientHello 发出去，
      代理端报 `HTTPS_PROXY_REQUEST`；
    - 放对位置但用 `'on'` → `socket.opened` 直接 reject：
      「proxy request failed, cannot connect to the specified address」；
    - 放对位置且用 `'starttls'` + `startTls()` → 进入 TLS 握手阶段。
    **定位 TLS 问题前，先打印 `socket.secureTransport` 确认选项真的生效了**
    （它会返回 `"off" | "on" | "starttls"`）。
23. **Cloudflare 边缘的 TLS 会校验证书链 + 主机名，且无法指定自有 CA**。
    workerd 的 TLS 能力只有 `TlsOptions = { expectedServerHostname?: string }` ——
    没有 `ca` / `rejectUnauthorized` / 自定义信任链的入口。
    实测（真实 Pages + 阿里云 Go TLS 代理）：
    - 自签证书 → 服务端收到 `remote error: tls: unknown certificate authority`；
    - 用 IP 连接（证书签给域名）→ `remote error: tls: bad certificate`；
    - 用域名连接 + SNI 匹配 + 公信 CA 证书 → **握手成功**。
    → HTTPS 代理必须用**域名**配置；代理地址只能写 IP 时，
    用 `#sni=example.com` 显式指定握手名（见 `outbound/proxy-pool.ts`）。
    → 结论：`'on'` 与 `'starttls'` **都校验证书**，
    区别只在 `'on'` 会在 `opened` 阶段就失败、`'starttls'` 能进到握手阶段。
24. **HTTPS 代理用 `starttls` + `startTls()`，不要用 `secureTransport: 'on'`**。
    `'on'` 在真机上 `socket.opened` 直接 reject，拿不到可诊断的 TLS 错误；
    `'starttls'` 能进到握手阶段，失败信息更具体。
    ⚠️ `startTls()` 返回**新** socket，原 socket 已被关闭 ——
    必须换用新 socket 的 readable / writable。
25. **测试代理服务端要支持 TLS 1.3**。
    Cloudflare 边缘的 `startTls()` 只发 TLS 1.3 ClientHello。
    CentOS 7 的 OpenSSL 1.0.2k / Python 3.6 **不支持 TLS 1.3** ——
    握手会永远挂起，表现为「大量 ESTABLISHED 连接堆积、Recv-Q 有数据但服务端不读」，
    而不是明确的报错。
    排查「TLS 握手卡住」时先确认服务端 TLS 版本：
    `openssl version` + `python3 -c "import ssl; print(ssl.OPENSSL_VERSION)"`。
    需要 TLS 1.3 时用 Go 写一个静态编译的代理（`CGO_ENABLED=0 GOOS=linux go build`）。
26. **Pages 部署 `_worker.js` 的 metadata 不能带 `compatibility_date`**。
    Pages Advanced Mode 与 Workers 的 metadata 结构不同，
    多带 `compatibility_date` 会让 Pages **忽略 `_worker.js`**，
    表现为「部署成功、HTTP 200，但返回默认 Welcome 页」。
    正确的 metadata 只有 `{ main_module: '_worker.js', bindings: {} }`。
    另：**Pages 的绑定与变量只对之后的部署生效**，
    顺序必须是「建项目 → 设变量（PATCH）→ 部署」；
    且 PATCH 会自动触发一次部署，之后再 POST `/deployments` 就是二次部署 →
    触发 `8000119`（账号级风控判定，同名重试通常能过）。
27. **Pages 的 WS 路径要用 `WS_PATH`，且值带前导斜杠**。
    `PATH` 是 Pages 的保留名，值不带 `/` 也会导致路径不匹配。
    参考 `config.ts`：`wsPath: text(env.WS_PATH || env.PATH, DEFAULT_CONFIG.wsPath)`。
28. **本地 workerd 拒绝连私有 IP**（`127.0.0.1` / `192.168.x` / `10.x`），
    报「proxy request failed, cannot connect to the specified address」——
    与真机上的「CF 网段被拒」是同一个错误文案，**极易混淆**。
    验证出站链路要么用**公网 IP**的目标，要么用真机。
    另外 workerd 也不校验 TLS 证书（适合验协议层），
    但真机校验 —— 两边结论不一致时以真机为准。

---

## 2. 目录结构

```text
CFPilot/
├── AGENTS.md                     # 本文件
├── package.json                  # npm workspaces 根配置
├── packages/
│   ├── worker-core/              # @cfpilot/worker-core —— 边缘内核 + 中文面板
│   │   └── src/
│   │       ├── index.ts          # 路由分发入口
│   │       ├── config.ts         # 配置加载（KV > env > 默认值）
│   │       ├── auth.ts           # 密码 + 会话 + 一次性扫描令牌
│   │       ├── api.ts            # 面板 REST API + SSE
│   │       ├── store.ts          # KV / 内存存储抽象
│   │       ├── probe.ts          # /__edge_probe 真连接探针
│   │       ├── sub-engine.ts     # 四层优选池 + 多格式订阅输出
│   │       ├── budget.ts         # Free CPU 预算保护
│   │       ├── protocols/        # vless / trojan / xhttp / websocket / stream / address / sha224
│   │       ├── outbound/         # dial（并发竞速 / NAT64）/ socks5 / http-proxy
│   │       └── ui/panel.html     # 内嵌中文面板（单文件，零依赖）
│   ├── scanner-cli/              # cfpilot-scanner —— 本地真连接优选器（npm 包）
│   │   └── src/
│   │       ├── cli.ts            # 命令行入口
│   │       ├── true-probe.ts     # TLS SNI + WS 101 握手 / 真实下行测速
│   │       ├── scan.ts           # 三阶扫描器
│   │       ├── server.ts         # 127.0.0.1:19527 桥接服务（SSE）
│   │       └── ip-ranges.ts      # CF 网段库 + 采样
│   └── deploy-wizard/            # cfpilot-deploy —— 全中文部署向导（npm 包）
│       └── src/
│           ├── cf-api.ts         # Cloudflare API 封装
│           ├── wizard.ts         # 交互式向导
│           └── cli.ts
```

---

## 3. 协议实现要点（不要凭记忆改）

### VLESS
```
0      版本（0x00）
1..16  UUID 原始 16 字节
17     Addons 长度 M
18..   Addons（M 字节 protobuf，含 flow）
18+M   命令 0x01=TCP 0x02=UDP
+1..2  端口（大端）
+3     地址类型 1=IPv4 2=域名 3=IPv6
+4..   地址
```
响应头：`版本(1) + Addons 长度(1) + Addons`。

### Trojan
```
0..55  hex(SHA224(password)) —— 56 个 ASCII 十六进制字符
56..57 CRLF
58     命令 0x01=CONNECT 0x03=UDP
59     地址类型 1=IPv4 3=域名 4=IPv6
60..   地址
+2     端口（大端）
+2     CRLF
```
注意：Trojan 的地址类型编号与 VLESS **不同**（域名是 3 而不是 2）。
`SHA-224` 无法用 WebCrypto 实现，必须使用 `protocols/sha224.ts` 的纯 TS 版本。

### XHTTP（stream-one）
Xray 的 XHTTP stream-one 模式：**一个 HTTP 请求承载上行，同一请求的响应承载下行**。
请求是 `POST /<path>`，请求体首字节为 VLESS 协议头；服务端返回
`200` + 流式响应体（`X-Accel-Buffering: no`、`Cache-Control: no-store`）。
XHTTP **不支持 UDP**。

---

## 4. 编码规范

- 全部 TypeScript，`strict: true`，禁止 `any`（必要时用 `unknown` + 类型收窄）。
- 注释与面向用户的文案一律使用中文；标识符使用英文。
- 不得使用 `console.log`（Worker 侧）；CLI 侧可以用 `process.stdout.write`。
- 提交前必须通过：`npm run typecheck && npm run test && npm run build`。

---

## 5. 提交与发布

- 改动内核后必须重新执行 `npm run build -w @cfpilot/worker-core`，
  并执行 `npm run build -w cfpilot-deploy` 同步 `assets/cfpilot-worker.js`（CI 会校验一致性）。
- `scanner-cli` / `deploy-wizard` 发布到 npm 前需 `npm run build`，
  `scanner-cli` 的 `files` 字段只包含 `dist`。
- 不要提交密钥：Cloudflare Token、面板密码、扫描令牌一律走环境变量或 KV。

---

## 6. 版本号政策（单一版本源，2026-10-24 立）

1. **所有包同版本**：root / worker-core / scanner-cli / deploy-wizard / gui
   的版本号永远一致。无论某个包本身有没有代码变动，只要发布就一起升——
   免去逐包管理版本号的麻烦（用户明确要求）。
2. **根 `package.json` 的 `version` 是唯一版本源**。任何包都不允许单独改版本号；
   直接手改子包 `package.json` 或 `src/version.ts` 一律视为违规。
3. **升级唯一入口**：
   ```bash
   npm run version:bump -- 0.4.0    # 或 major / minor / patch
   ```
   该命令改根版本并调用 `scripts/sync-version.mjs` 全量同步
   （各包 `package.json` + scanner-cli / deploy-wizard 的 `src/version.ts`）。
4. **`src/version.ts` 只允许脚本生成**（文件头有 `sync-version.mjs` 标记注释）。
   worker-core 的 `version.ts` 是构建注入的 `BUILD_VERSION`，与包版本无关，禁止覆盖；
   gui 没有 `version.ts`，版本只存在于 `package.json`。
5. **npm 发布前的兜底**：`scanner-cli` / `deploy-wizard` 的 `prepublishOnly`
   会再跑一次 sync，保证包内版本号与根一致（2026-10-23 曾因漏改 `version.ts`
   出现「npm 上是 0.3.0、CLI 报 0.2.0」的事故）。
6. **GUI 发布**：tag 必须用 `gui-v<统一版本号>`（如 `gui-v0.3.0`），
   CI 会校验 tag 与根版本一致，不一致直接失败。
7. npm 已发布版本号不可覆盖重发，所以每次升级必须是**严格递增**的新号。
