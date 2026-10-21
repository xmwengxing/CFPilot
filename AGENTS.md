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

1. **配置优先级**：`KV (CONFIG) > 环境变量 > 内置默认值`。
   任何新增配置项都必须同时支持这三层，并在 `packages/worker-core/src/config.ts` 中登记。
2. **内核体积预算**：Worker 打包产物 **必须 ≤ 50KB**（`packages/worker-core/scripts/build.mjs` 会在超限时告警）。
   不要把第三方大依赖塞进 `worker-core`；面板必须是零框架的单文件 HTML。
3. **探针端点不可删除**：`/__edge_probe` 必须始终提供
   「WebSocket 101 握手校验」与「流式下行测速」两项能力，这是 CFPilot 的核心价值。
4. **优选 IP 解析器必须容错**：兼容裸 IP、`IP:Port`、`IP:Port#备注`、`[IPv6]:Port#备注`、
   优选域名，以及 CloudflareSpeedTest 风格的 `result.csv` 原文。
   清洗逻辑集中在 `packages/worker-core/src/sub-engine.ts`，禁止在别处重复实现。
5. **数据面与控制面分离**：`worker-core` 只处理代理与订阅；面板只是它的一个 HTTP 端点。
   不要在 `worker-core` 里引入 Node API（`node:*`），Workers 运行时不支持。
6. **零运行时依赖**：`scanner-cli` 与 `deploy-wizard` 不得引入第三方运行时依赖，
   必须能被 `npx -y` 秒级拉起。开发期依赖（esbuild/typescript）只允许出现在 `devDependencies`。

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
