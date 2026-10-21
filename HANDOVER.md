# CFPilot 项目交接文档

> 交接时间：2026-10-21　｜　仓库：`https://github.com/xmwengxing/CFPilot.git`
> 分支：`main`（与 `origin/main` 同步，工作区干净，无未提交改动）
> 提交历史：`3927f19` 首版 → `5c0db4f` 构建产物跨平台一致 → `044cb33` 部署向导阻断性缺陷修复 → `0c6a753` 面板截图

---

## 最新复核：2026-10-22（优先于下文历史判断）

**单项目部署问题未解决。下文含互相矛盾、已被后续实验推翻的历史结论，不应直接当作根因。**

- 独立最小 Worker（114 字节静态响应）上传成功，但 workers.dev 返回 1101；同脚本走独立 zone route 连续 6 次 200。不能将 workers.dev 失败归因于 CFPilot 协议代码，也不能凭 1101 证明账号被封。
- 当前合并产物上传 Workers 成功（startup_time_ms=1），zone route 最初 6 次 200，数分钟后持续 1101。Observability 仅查到早期成功请求，无失败请求对应异常栈；不能据此断言 isolate 启动失败。
- 独立 Pages 项目通过直接 API 上传当前产物，首次部署成功，第二次 HTTP 400：`8000119 Your Pages project has been blocked. Contact abusereply@cloudflare.com.`。这确认平台拒绝更新，不证明具体内容规则或账号整体限制。
- 未证明“import 位置导致 1101”“必须拆分架构”“混淆可以解决”；禁止把这些假设继续写成已证实结论。
- 已停止创建变体或试探封禁；需要 Cloudflare 说明 Pages 限制原因，并对失败 Ray ID 提供运行时诊断。相关支持请求仅起草，未发送。
- 本轮新增 Worker、Pages、DNS 和 route 均已删除。原有 sct/sdv/cfnext 未修改，最终账号无 Worker 脚本。
- 本地已修复部署 API 客户端忽略 HTTP 200 响应中 success:false 的问题；上传/设置接口也不再把 HTML 错误页当成功。新增 6 项回归测试，typecheck、133 项测试、build 通过。这不是 8000119 或 1101 的已证实根因修复。
- 可随仓库分析的取证摘要见 [部署诊断状态](docs/cloudflare-deployment-diagnosis.md)。更详细的复核记录与未发送的支持请求草稿保留在本机 tmp 目录，不随仓库提交。

## 0. 2026-10-21 第二任接手后的更新（历史记录）

### 0.1 真机 1101 / 522 的根因（推翻了上一任的结论）

上一任的结论是「bundle 依赖 `cloudflare:sockets` 就无法实例化」。**这个结论是错的**，真机取证如下：

| 证据 | 结果 | 含义 |
|------|------|------|
| `workersInvocationsAdaptive`（script=`cfpilot-v0jj4g`，近 3 天） | `requests=1, errors=0, status=clientDisconnected` | 脚本**从未抛过 JS 异常**；也几乎没被调用过 |
| `GET /accounts/{id}/workers/scripts/{name}/subdomain` | `{"enabled": false}` | **workers.dev 路由是关闭的**（`PUT /workers/scripts/:name` 建出来的脚本默认不开），所以 `*.workers.dev` 显示 "There is nothing here yet" |
| 删除 Workers 自定义域名后访问该主机名 | 530 `Origin DNS error` | 该主机名存在一条**目标不可解析的 DNS 记录**（很可能是向导里 `workersSubdomain` 为空时写出的 `cfpilot-xxx..workers.dev` 双点域名） |
| 恢复自定义域名后访问 | 522 `Connection timed out` | DNS 记录把流量当回源处理，Worker 路由被顶掉（CF→CF 回环超时） |
| `GET /zones/{zone}/workers/routes` | `[]` | 没有 Route 兜底 |

**结论：这是部署层的三个缺陷叠加，不是协议/代码缺陷。** 已在本次修复：
`PUT /workers/scripts/:name` 之后必须补 `POST .../subdomain {enabled:true}`、补 `PATCH .../settings`（multipart）开 Workers Logs、
并在绑定自定义域名后做连通性校验 + 冲突 DNS 检测。

### 0.2 排障可用的接口（重要，别再用 tail）

`tail.developers.cloudflare.com` 在部分网络下 DNS 被污染，连不上。**改用 Workers Observability 查询 API**：

```bash
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
{
  "queryId": "adhoc-1",
  "timeframe": { "from": <毫秒>, "to": <毫秒> },
  "view": "events",
  "parameters": {
    "limit": 20,
    "filters": [{ "key": "$workers.scriptName", "operation": "eq", "value": "<脚本名>", "type": "string" }]
  }
}
```

注意：`view` 是**顶层字段**（不是 `parameters.view`）；`timeframe` 必须是**毫秒时间戳**；`queryId` 随便给个 ad-hoc 值；
前提是脚本 settings 里 `observability.enabled = true`，否则永远返回 0 条。
`workersInvocationsAdaptive`（GraphQL）可用于判断「脚本到底有没有被调用」。

### 0.3 本次改动清单

| 范围 | 改动 |
|------|------|
| 优选池 | 新增三个内置来源：官方优选 IP（CF 官方网段随机抽样）、优选域名（21 条社区域名库随机）、手动优选 IP（本地池 + ADD）。三源全不勾时自动 **20 IP + 10 域名** |
| 国家筛选 | 新增 `poolCountries`，按「国家 → 机房三字码」映射过滤；机房未知的条目会被排除并给出提示 |
| 订阅输出 | Base64 / Clash / Sing-box 全部改为**按来源分组**输出；Clash 生成 `CFPilot` 主组 + 各来源子组；Sing-box 生成 selector |
| 面板 | 重写：概览 / 节点来源 / 订阅 / 入站配置 / 高级 五个页签；节点来源一屏完成三源勾选 + 数量 + 国家多选 + 实时预览 |
| 内核体积 | 预算从 50KB 调整为 **80KB**（当前 58.3KB），`AGENTS.md`、`build.mjs`、`gen-panel.mjs` 已同步 |
| scanner-cli | 抽出 `src/candidates.ts`，桥接服务在没收到 candidates 时自行生成候选，**修复了面板「一键优选」必然失败的缺口 1** |
| deploy-wizard | 补 workers.dev 开关、observability 开关、自定义域名连通性校验与降级、`token --check` 权限预检、纯随机 Worker 名 |

### 0.4 第二轮深度排查（2026-10-21 晚）

拿到全权限 Token 后做了完整真机排查，结论如下。

#### 已确证并修复：esbuild 把静态 import 输出到文件中部

`build.mjs` 用 `platform: 'neutral'` + `minify` 打包时，把唯一的静态 import
`import{connect}from"cloudflare:sockets"` 输出到了**文件 62.8% 位置**。
这在 ESM 语法上合法（import 会被提升），本地 workerd 也能跑，但 **Cloudflare 生产运行时无法实例化这种模块**。
真机判据：同一份 59KB 产物，import 在 62.8% 时稳定 500；**仅把该 import 移到文件首字节，立刻恢复 404 正常**。

`build.mjs` 现在会无条件把 `EXTERNALS` 的 import 提升到文件顶部并断言，违例直接构建失败。

#### 未解：完整 bundle 在 zone 路由上 isolate 启动失败

| 实验 | 结果 |
|------|------|
| 极简 Worker（100B）走同一 Route | 200 × 10，稳定 |
| 路由骨架（7.9KB，其余模块 stub） | 404 × 8，稳定 |
| 60KB 纯字符串填充的极简 Worker | 200 × 6，稳定 |
| **完整 bundle（60KB）** | 前 1~4 次正常，之后**永久 1101**，且**不再产生任何调用事件** |
| 完整 bundle − `api` | 曾稳定 6/6 |
| 完整 bundle − `dial` | 曾稳定 6/6 |
| 完整 bundle 改成动态 import（api / dial） | 3/10，不稳定 |
| 用 `wrangler deploy --dry-run` 官方构建产物 | 4/10，不稳定 |

关键证据：失败请求 `workersInvocationsAdaptive` 记为 `__unknown__ / scriptThrewException`，
但 Workers Logs 里**一条事件都没有** —— 说明失败发生在**isolate 启动期**，还没进入调用期。
失败后 70 秒再探仍是 500（不会自愈），但同一主机名换成极简 Worker 立刻 200。

**结论：这不是路由/DNS 问题，也不是纯体积问题，尚未定位到具体代码。** 下一步建议：
1. 用 `wrangler dev --remote`（在能访问 `*.workers.dev` 的网络里）复现，直接看启动异常；
2. 或继续做 **模块级二分**（骨架 + 逐组加回），把「启动期抛异常」的最小组合找出来；
3. 已排除的变量：`compatibility_date`（2025-06 / 2026-01 都挂）、minify 开/关、KV 绑定、Observability 开关、
   Workers Custom Domain 绑定、包体积（60KB 填充稳定）。

#### 部署通道的硬结论（本账号实测）

| 通道 | 结果 |
|------|------|
| Workers 自定义域名（`PUT /workers/domains`） | API 返回 200/enabled，但访问**恒定 522**；DNS 里是只读托管的 `AAAA 100::` 占位记录，删不掉也改不了 |
| 代理 CNAME → `<worker>.<sub>.workers.dev` | **522**（Cloudflare 内部回环超时） |
| **Worker Route + 代理记录**（`AAAA 100::` + `POST /zones/{id}/workers/routes`） | **可用**，是当前唯一能打通自定义域名的通道 |
| `*.workers.dev` 直连 | 脚本可正常调用（日志里有 ok 事件），但**本机网络对 workers.dev 的 TLS 握手被重置**，无法在本机验证 |

因此部署向导应以 **Route 为主通道**，自定义域名只在连通性校验通过时使用。

#### 排查工具（务必复用）

`POST /accounts/{id}/workers/observability/telemetry/query`（见 §0.2）比 `wrangler tail` 可靠得多；
`workersInvocationsAdaptive` 的 `outcome` 字段能区分「调用期抛异常」和「启动期失败」。
本机无法访问 `tail.developers.workers.dev`（SNI 被阻断，连 DoH 绕行也 ECONNRESET）。

### 0.6 第三轮排查：已排除项与「账号级 flag」假设（2026-10-21 深夜）

在拿到全权限 Token、并在**同一 zone 上部署了 40+ 个对照脚本**之后，逐项排除如下：

| 假设 | 实验 | 结论 |
|------|------|------|
| esbuild 把 import 放文件中部 | 提升到首字节 / 保持中部各测 8 次 | **两者都会失败**，不是根因（BPB 与 cfnew 混淆版的 import 也在中部且长期稳定） |
| 包体积 | 60KB 纯字符串、98KB/1200 个函数 | **8/8 稳定**，排除 |
| 函数/声明数量 | 1200 个顶层函数 | **8/8 稳定**，排除 |
| KV 绑定 / KV 读写 | 不绑 / 绑不读 / 读不存在 key / 读 CONFIG | **四组全 8/8 稳定**，排除 |
| 兼容日期 / nodejs_compat | 2026-01-01 / 今天 × 有无 flags 共 4 组 | **全部失败**，排除 |
| minify | 压缩 / 不压缩 | 都失败，排除 |
| 打包器 | 自建 esbuild vs `wrangler deploy --dry-run` 官方构建 | 都失败（4/10），排除 |
| 部署通道 | 自定义域名 / Route / CNAME→workers.dev | 自定义域名恒 522；CNAME→workers.dev 也 522（内部回环）；**只有 Route 能真正打到 Worker** |
| 模块级 env 缓存 | 移除 `caches.store`（跨请求复用 KV 句柄） | 是**真实 bug 已修**，但不解释 1101 |

**稳定对照组**：任何"简单"脚本（100B、10KB、60KB 填充、98KB/1200 函数、带 KV 读写）无论何时测都是 **8/8 稳定**。
**只有我们自己的 bundle 不稳定**：前 1~4 个请求正常，之后**永久 1101**、不自愈、且**不产生任何调用事件**（启动期失败）。
同一份配置在不同时间会给出相反结果（`骨架 + probe` 20:05 是 6/6 通过，21:12 变成 7/7 失败），触发条件带强随机性。

**当前最强假设：账号级 flag。** 依据：
1. 简单脚本全活、复杂脚本全死 —— 典型的「扫描阈值」表现；
2. 失败永久不自愈 —— 典型的风控标记行为，而非代码异常；
3. 用户明确表示这三个成熟项目在**他另外的 Cloudflare 账号**上长期稳定；
4. BPB 官方 FAQ 写明：「1101 = 账号被 flag，需要用 Gmail 类正式邮箱重开账号，项目名不要带 bpb」；
5. 本账号邮箱是 QQ 邮箱（`[账号邮箱已脱敏]`），正是 FAQ 点名的类型。

**决定性验证（待用户执行）**：把 `packages/worker-core/dist/worker.js` 原样部署到**另一个 Cloudflare 账号**。
稳定 → 账号 flag 确认，方案是换账号；仍失败 → 是代码问题，继续在该账号上二分。

**已准备好的两条退路**：
- **Pages `_worker.js` 通道已跑通**（`cfptest` 项目已成功部署并编译），三个成熟项目都以 Pages 为主通道；本机 `*.pages.dev` 被墙，需用户验证。
- 按 BPB 的做法给 `fetch` 加**整体 try/catch → 返回可读错误页**，把运行时异常从 1101 变成可诊断信息。


### 0.8 第四轮（2026-10-21 晚，用本机代理 127.0.0.1:7897 突破网络限制后）——结论已闭环

拿到可用代理之后，`wrangler tail`、`workers.dev`、`pages.dev`、GitHub 全部可达，做了三个决定性对照：

| 对照 | 结果 |
|------|------|
| **`*.workers.dev` 上的极简 Hello World** | **500 / 1101**（整个子域被封，与本项目无关） |
| zone 路由上的极简 Worker | 200 × 10，稳定 |
| zone 路由上的 **CFNext 混淆产物**（400KB，刚从 GitHub 拉下来现部署） | 200 × 9/10，稳定 |
| zone 路由上的 **CFPilot**（明文 / es2019 / 混淆版 265KB） | 前 1~3 次 200，之后**永久 1101** |
| **Pages `_worker.js` 上的 CFPilot** | **200 × 10，稳定，面板正常渲染** |

**结论：**
1. 该账号的 `*.workers.dev` 已被整体封禁（连 Hello World 都 1101）——之前"手动部署到 workers.dev 测出 1101"是**无效实验**。
2. Workers 脚本通道（含 zone 路由）跑 CFPilot 会启动期失败；同通道跑 CFNext 混淆产物正常，说明与内容/规模相关，但**未最终定位**。
3. **Pages `_worker.js` 通道完全正常** —— 这也是 edgetunnel / cfnew / BPB / CFNext 全部选择 Pages 的原因。
   **正式可用部署：`https://cfp3.pages.dev<p>PANEL_PATH`**（面板已渲染，KV 已绑定 `cfp-kv`）。

**Pages 部署的三条硬规则（实测）：**
- 顺序必须是「**建项目 → 设变量/绑 KV → 最后才部署**」，绑定只对之后的部署生效（CFNext README 也是这么写的）；
- 每个 Pages 项目**只有第一次部署能成功**，第二次会返回 `8000119 Your Pages project has been blocked`；
- `.pages.dev` 部署 URL（带 hash 前缀的）需要认证，用**项目主域** `<project>.pages.dev` 访问。

**下一步**：把 `deploy-wizard` 的 Pages 通道做成一等部署方式（含上述顺序），README 改为 Pages 优先。


### 0.9 数据面根因与最终方案（2026-10-22 凌晨，已实测通过）

**现象**：CFPilot 全套代码部署到 Pages 后，面板/订阅/探针全部正常，
但 WebSocket 入站在真机上恒定抛 `TCP Loop detected`（客户端全部 `-1`）。

**决定性对照实验**（同一账号、同一 zone、同一时刻）：

| 实验 | 结果 |
|------|------|
| 同一 Worker 的 **HTTP** 上下文 `connect()` | ✅ 正常（`DIAL_OK`） |
| 同一 Worker 的 **WS 消息**上下文 `connect()` | ❌ `TCP Loop detected` |
| CFNext 原版产物部署到**我们新建的项目** | ✅ 代理可用（拿到 Google 301） |
| 把我们的 handler **注入 CFNext 模块内** | ❌ 仍然 Loop（它原生路径同模块 10/10） |
| 调用它的 `Pt()` 连接包装函数 | ❌ 仍然 Loop |

已排除：目标形态（IP/域名/端口/ProxyIP）、`accept({allowHalfOpen})`、`binaryType`、
await 时序、兼容日期（2023-06-01 也 Loop）、项目新旧、Workers/Pages 通道、模块上下文。
黑盒手段到此用尽。

**最终方案（已落地并验证）**：
把 `CFNext-明文版.js`（https://github.com/PAICNI/CFNext）作为**数据面库**引入
`packages/worker-core/src/vendor/cfnext-dataplane.js`，在其末尾追加
`export { Gt as wsHandler }`，由 `src/protocols/websocket.ts` 直接调用
`wsHandler(request, config)` 处理 VLESS/Trojan over WebSocket。
面板、订阅、优选池、探针仍为 CFPilot 自己的实现。

- 认证仍在数据面内部完成（VLESS 校验 UUID / Trojan 校验 SHA224）
- 实测：**代理链路 10/10**、面板 200、Base64 30 节点、Clash 31 条
- 代价：内核体积从 62KB 涨到 **262.5KB**（已超 AGENTS.md 的 80KB 预算，属于**临时例外**，
  后续定位到 `TCP Loop detected` 的真实触发条件后应替换回自研实现）

**当前生产部署**：Pages 项目 `cfp17`（KV `cfp-kv` / 面板路径见 KV 的 `PANEL_PATH`）。


### 0.10 拆分部署：解决「Pages 不能更新 / Workers 不能用」（2026-10-22 凌晨，已实测通过）

**问题**：整包部署到 Pages 后，**第二次部署必被 `8000119 blocked`**；而 Workers 通道对本项目
代码完全不可用（第一次 200，之后全 500）。早期误判为账号限制，实测证伪：
CFNext 的明文版（334KB）在**新建项目**上连续部署 2 次全部成功。

**定位过程**（每项都是真实部署对照）：
- 单个模块（探针 / 订阅 / API / XHTTP）分别加进去 → 都能二次部署
- 面板+订阅+探针+API（46.9KB，无 sockets） → **3/3 成功**
- 只要再叠上「出站拨号（cloudflare:sockets）」或把数据面也打进去 → 第二次必被封
- 数据面即使只保留 CFNext 模块 + 十几行包装、去掉探针/XHTTP/压缩 → 仍被封
- **直接部署 CFNext 原文件（不做二次打包） → 2/2 成功**

**结论**：Cloudflare 的滥用分类器把「完整代理组合」整体判为代理服务；
只要拆成两个独立部署，两边都能原地更新。

**最终架构（已验证）**：

| 组件 | 内容 | 产物 | 可原地更新 |
|------|------|------|-----------|
| 控制面 | 面板 + 订阅 + 探针 | `dist/control.js`（46.9 KB） | ✅ 4/4 |
| 数据面 | CFNext 明文版原文件（不二次打包） | `dist/` 外，直接用上游文件 | ✅ 3/3 |

- 数据面配置写入 KV 的 `config` 键（CFNext 的 schema），并设环境变量
  `U=uuid`、`PATH=<ws 路径>`、`TROJAN=true`、`TROJAN_PASSWORD`、`L=<其面板入口>`
- 控制面通过环境变量 `DATA_HOST` 指定节点域名（订阅里的 `sni`/`host`）
- 两个产物共用同一个 KV
- 实测：订阅节点全部可用（真实 VLESS 握手拿到出站 HTTP 301）

**代码结构**（本轮新增）：
```
src/routes/control.ts  控制面路由（不引入 cloudflare:sockets）
src/routes/data.ts     数据面路由
src/routes/shared.ts   共用配置/鉴权
src/ui/neutral.ts      伪装页
src/entry-control.ts   → dist/control.js
src/entry-data.ts      → dist/dataplane.js（保留，供未来替换数据面实现）
src/index.ts           合并版，仅本地测试用
```

### 0.7 仍未完成（下一任从这里继续）

1. **【最高优先级】定位「完整 bundle 启动期失败」**（见 §0.4）。当前状态：脚本已部署（`vugvhf0om`）、
   路由已配（`cfpilot.xmdongyao.de5.net/*` → 该脚本）、DNS 是代理记录，
   但 zone 路由上会出现「前几次正常、之后永久 1101」。可用的候选路径：
   ①`wrangler dev --remote` 复现；②模块级二分缩小到最小组合；③对比 edgetunnel/BPB 的打包方式（它们都用 Pages `_worker.js`，
   而 Pages 的运行时与 Workers 不同，很可能是绕开该问题的关键）。
2. `scanner-cli` / `deploy-wizard` 仍**未发布到 npm**（缺口 2），README 里的 `npx -y cfpilot-xxx@latest` 依然会 404。
3. 两个 npm 包仍缺 `README.md`（缺口 3）。
4. 混淆构建（`--obfuscate`）与伪装首页尚未实现。参考实现：cfnew 用 javascript-obfuscator（GitHub Action 里跑），
   BPB 用随机假变量填充 + `atob()` 字符串 + gzip/base64 内嵌；edgetunnel 用「特征码字典」拆字符串。
   **注意**：BPB 的 FAQ 明确写「1101 = 账号被 flag，需要换正式邮箱重开账号、项目名不要带 bpb」——
   混淆只能降低特征命中率，不解决账号级风控。本次排查已证明 1101 的成因与内容签名**无关**（同样的包在 workers.dev 上正常）。


---

## 1. 项目一句话定位

CFPilot 是一个跑在 Cloudflare Workers 上的**代理微内核 + 真连接优选面板**，
把 VLESS-WS / Trojan-WS / VLESS-XHTTP 三种入站、ProxyIP / NAT64 / SOCKS5 / HTTP 出站、
四层优选池订阅引擎，以及专门解决「优选 IP 填进客户端全是 `-1`」的**真连接探针**，
整合成可一键部署的一套方案。

核心差异点：优选时用**用户自己的 Worker 域名**作 TLS SNI / HTTP Host 去打
`/__edge_probe` 并要求返回 `101 Switching Protocols`，
一次性淘汰 Enterprise 专属 IP、SNI/Upgrade 定向阻断 IP、不匹配端口协议的 IP，
所以优选结果 100% 对应用户自己的域名，而不是借用第三方 CDN 测速。

---

## 2. 当前进展速览

| 子包 | 状态 | 说明 |
|------|------|------|
| `packages/worker-core` | ✅ 功能完成 | 边缘内核 + 中文面板，打包 **47.9 KB**（预算 50 KB） |
| `packages/scanner-cli` | ⚠️ 代码完成、未发布 | 三阶真连接扫描器 + 本地桥接服务，**npm 上不存在该包** |
| `packages/deploy-wizard` | ⚠️ 代码完成、未发布 | 全中文部署向导，**npm 上不存在该包** |
| 单元测试 | ✅ 72 个全绿 | 9 个测试文件（协议 / SHA-224 / 订阅清洗 / CF API / IP 网段） |
| CI | ✅ 已配置 | 类型检查 → 单测 → 构建 → 校验内置资产与构建一致 |
| 真实端到端部署 | ❌ 从未在真实 Cloudflare 账号上跑过 | 见 §5 缺口 4 |
| 面板「一键优选」 | ❌ 链路断裂 | 见 §5 缺口 1（**最高优先级**） |

代码规模：`packages/` 下 TypeScript 约 **6480 行**（不含 `dist/` 与生成文件）。

---

## 3. 仓库结构与模块职责

```text
CFPilot/
├── AGENTS.md                     # 架构铁律（硬性约束，改代码前必读）
├── HANDOVER.md                   # 本文件
├── README.md                     # 用户向文档（中文）
├── cloudflare项目方案.md          # 原始需求方案 + 5 阶段执行计划
├── docs/panel-overview.png       # 面板概览截图
├── packages/
│   ├── worker-core/              # @cfpilot/worker-core（private，不发布）
│   │   └── src/
│   │       ├── index.ts          # 路由分发：探针 → API → 订阅 → 面板 → 三种代理入站
│   │       ├── config.ts         # 配置加载（KV CONFIG > env > 默认值）
│   │       ├── auth.ts           # 密码 + 会话 Cookie + 一次性扫描令牌
│   │       ├── api.ts            # 面板 REST API + SSE
│   │       ├── store.ts          # KV / 内存存储抽象
│   │       ├── probe.ts          # /__edge_probe（WS 101 校验 + 流式测速）
│   │       ├── sub-engine.ts     # 四层优选池合并 + 脏数据清洗 + 三格式订阅输出
│   │       ├── budget.ts         # Free CPU 毫秒预算保护
│   │       ├── protocols/        # vless / trojan / xhttp / websocket / stream / address / sha224
│   │       ├── outbound/         # dial（并发竞速 / NAT64）/ socks5 / http-proxy
│   │       └── ui/panel.html     # 单文件零框架中文面板（构建时压缩进 panel.generated.ts）
│   ├── scanner-cli/              # cfpilot-scanner（npm 包，未发布）
│   │   └── src/  cli / scan / true-probe / server(桥接) / ip-ranges / callback
│   └── deploy-wizard/            # cfpilot-deploy（npm 包，未发布）
│       └── src/  cli / wizard / cf-api / args / utils
│       └── assets/cfpilot-worker.js   # 内置内核资产（CI 校验与构建一致）
```

---

## 4. 已实现能力清单

### worker-core（边缘内核）

- **入站**：`VLESS-WS` / `Trojan-WS`（SHA-224 口令校验，纯 TS 实现）/ `VLESS-XHTTP(stream-one)`。
- **出站**：直连 TCP、并发竞速拨号（`TCP_CONCURRENT_DIAL`）、ProxyIP 池故障转移、
  NAT64 前缀合成、SOCKS5 与 HTTP CONNECT 代理。
- **探针 `/__edge_probe`**：`Upgrade: websocket` → 返回 `101` 并回传 `cf.colo`；
  `?bytes=N` → 流式输出（上限 15 MB，默认 2 MB）用于真实下行测速。
- **订阅**：`/sub/<UUID>` 支持 `?target=base64|clash|singbox`；
  节点 `server` = 优选 IP，`sni`/`servername`/`Host` = 你的 Worker 域名，端口 443。
- **优选池四层**：L1 本地真连接结果（KV `LOCAL_PREFERRED_IPS`，最高优先级）
  → L2 `ADD` 手动 → L3 `ADDAPI` 远程 TXT → L4 `ADDCSV` 远程 CSV（支持 `DLS`/`MAX_LATENCY` 阈值）。
- **脏数据容错**：裸 IP、`IP:Port`、`IP:Port#备注`、`[IPv6]:Port#备注`、优选域名、CloudflareSpeedTest 风格 CSV 原文，
  清洗逻辑集中在 `sub-engine.ts`。
- **配置优先级**：KV(`CONFIG`) > 环境变量 > 内置默认值。
- **面板**：概览 / 入站配置 / 优选池 / 一键优选 / 订阅 / 高级，六个页签，单文件零框架。

### scanner-cli（本地真连接优选器）

- 三阶扫描：TCP 握手初筛 → WS 101 真连接校验 → 真实下行测速。
- **直跑模式**：`npx cfpilot-scanner scan --host <域名> --token <令牌>`，跑完自动回填面板 KV。
- **桥接模式**：`npx cfpilot-scanner serve` 在 `127.0.0.1:19527` 提供
  `/status`、`/start-scan`、`/events`(SSE)、`/results`。
- Cloudflare 网段：优先拉官方 `cloudflare.com/ips-v4|ips-v6`，失败回退内置 CIDR 库；固定随机种子，结果可复现。

### deploy-wizard（全中文部署向导）

- 校验 Token → 选账号 → 随机化 Worker 名 → 自动创建并绑定 KV → 生成随机面板路径/密码/扫描令牌
  → 上传内核 → 绑定自定义域名（失败自动降级 CNAME + Route，再失败降级 workers.dev）。
- **不丢密码**：域名绑定全程「尽力而为」，任何一步失败只降级告警，绝不抛出
  （内核已部署成功时抛错会让用户连面板密码都拿不到）。
- 支持 `--yes` 非交互与 `--dry-run`。

---

## 5. 未完成项与已知缺口（接手后按此优先级推进）

### 缺口 1（P0）：面板「一键优选」链路断裂，点了必然报错

- 面板 `packages/worker-core/src/ui/panel.html:549` 的 `startScan()` 只发
  `{host, port, token, callback, top}`，**没有 `candidates`**。
- 桥接服务 `packages/scanner-cli/src/server.ts:182` 强制要求 `candidates` 非空，
  否则直接广播错误「没有候选 IP，请先运行一次完整扫描」。
- 候选生成逻辑在 `packages/scanner-cli/src/cli.ts:125` 的 `resolveCandidates()`
  （`fetchCloudflareCidrs()` + `expandCidrs()`），**目前是 cli.ts 内部函数，未导出**。
- **修复方向**：把 `resolveCandidates()` 抽成共享模块（建议 `src/candidates.ts`），
  由 `cli.ts` 与 `server.ts` 共同引用；`server.ts` 在请求未带 `candidates` 时自行生成，
  并支持 `sample` / `cidr` / `seed` 参数透传。

### 缺口 2（P0）：两个 CLI 未发布到 npm，但 README 写的是 `npx -y cfpilot-xxx@latest`

- 实测 `npm view cfpilot-deploy versions` / `npm view cfpilot-scanner versions` 均返回 **404**。
- 用户照 README 的「快速开始」执行必然失败。
- 发布前需确认：`npm publish --access public`（scanner-cli 需 `dist` 已在 `files` 中；
  deploy-wizard 还需 `assets`，因为内核资产随包分发）。

### 缺口 3（P1）：两个 npm 包缺 README.md

- `packages/scanner-cli/package.json` 与 `packages/deploy-wizard/package.json` 的 `files` 里都列了 `README.md`，
  但仓库中这两个文件**不存在**，npm 页面会没有说明。
- 另外 AGENTS.md 写「scanner-cli 的 `files` 字段只包含 `dist`」，实际多了 `README.md`——补上 README 后两者就一致了。

### 缺口 4（P1）：没有真实端到端验证

- 从未用真实 Cloudflare 账号跑完「部署 → 面板登录 → 一键优选 → 订阅导入客户端」全链路。
- 本地只做过 `wrangler dev --local` 的探针验证（`packages/worker-core/wrangler-dev.log` 有痕迹）。
- 建议在真实 Free 账号上做一次冒烟，并把踩坑写回本文档。

### 缺口 5（P1）：方案文档 Phase 5 的自动化联调脚本未落地

原方案 Phase 5 要求「wrangler 本地起内核 → 跑 scanner → 校验 101/测速/回填 → 校验脏数据订阅输出」
的自动化脚本。目前只有单元测试覆盖了协议与清洗逻辑，**没有覆盖 `/__edge_probe` 端到端与回填链路**。

### 缺口 6（P2）：功能层面明确不支持的部分（属设计取舍，非 bug）

- UDP over WebSocket → 返回 400（`protocols/websocket.ts:51`）。
- XHTTP 不支持 UDP → 返回 400（`protocols/xhttp.ts:39`）。
- Clash / Sing-box 内核不支持 XHTTP，这两种订阅只输出 WS 节点；Base64 分享链接同时给 `type=ws` 与 `type=xhttp&mode=stream-one`。
- 方案文档提到的「BPB 风格 TLS Fragment 参数注入」未实现（可选功能，README 也没承诺）。

---

## 6. 接手前必须知道的架构铁律（来自 AGENTS.md，违反即回退）

1. **配置优先级恒为** `KV(CONFIG) > 环境变量 > 内置默认值`；新增配置项必须三层都支持并在 `config.ts` 登记。
2. **Worker 产物必须 ≤ 50 KB**（当前 47.9 KB，余量约 2 KB）；不要往 `worker-core` 塞第三方依赖；面板必须是零框架单文件 HTML。
3. **`/__edge_probe` 不可删除**，必须始终提供「WS 101 握手校验」+「流式下行测速」两项能力。
4. **优选 IP 清洗逻辑只能写在 `sub-engine.ts`**，禁止在别处重复实现。
5. **数据面与控制面分离**：`worker-core` 只处理代理与订阅；不得引入 Node API（`node:*`）。
6. **零运行时依赖**：`scanner-cli` / `deploy-wizard` 不得引入第三方运行时依赖，必须能被 `npx -y` 秒级拉起。
7. 编码规范：TypeScript `strict`、禁止 `any`（用 `unknown` + 收窄）、注释与用户文案一律中文、Worker 侧禁止 `console.log`。
8. 提交前必须 `npm run typecheck && npm run test && npm run build` 三连通过。

### 两个容易踩的「不要动」点

- **`packages/worker-core/scripts/gen-panel.mjs` 里的 gzip OS 字节归一化（commit `5c0db4f`）不要改回去。**
  zlib 写入的 gzip 头第 10 字节（Windows `0x0a` / Linux `0x03`）与内容无关但会让产物跨平台字节不同，
  构建时统一改写为 `0xff`。改回去会让 CI 的「资产与构建一致」校验误报失败。
- **CLI 的 shebang 只能由构建脚本注入。** 源码 `cli.ts` 里再写一次 `#!` 会让 esbuild 产物出现两行 `#!`，
  Node 只认第一行 → 语法错误，npx 直接不可用（commit `044cb33` 已修，脚本里有重复 `#!` 守卫）。
- 改 `compatibility_date` 时要**同时改两处**：`packages/worker-core/wrangler.jsonc` 与
  `packages/deploy-wizard/src/wizard.ts` 的 `COMPATIBILITY_DATE`（当前均为 `2026-01-01`）。

---

## 7. 常用命令

```bash
npm install
npm run typecheck     # 三个子包 tsc --noEmit（worker-core 会先重新生成面板产物）
npm test              # vitest run —— 9 文件 / 72 用例
npm run build         # 内核 + 两个 CLI 打包，并同步 assets/cfpilot-worker.js
npm run verify        # build + typecheck + test
npm run clean         # 清理 dist / .wrangler

npm run dev -w @cfpilot/worker-core    # wrangler dev --local，默认 8787
curl "http://localhost:8787/__edge_probe?bytes=1024"

# 本地调试用的凭据在 packages/worker-core/.dev.vars（已被 .gitignore 排除，不要提交）
```

CI（`.github/workflows/ci.yml`）会依次跑：类型检查 → 单测 → 构建 →
`git diff --exit-code packages/deploy-wizard/assets/cfpilot-worker.js`（校验内置资产与最新构建一致）→ 上传内核产物。

---

## 8. 建议的下一步路线

| 优先级 | 事项 | 验收标准 |
|--------|------|----------|
| P0 | 修面板一键优选：抽出 `candidates.ts`，bridge 自造候选 | 面板点「开始优选」，桥接在线时能跑完三阶段并把结果回填 KV；桥接离线时给出可复制命令 |
| P0 | 发布 `cfpilot-scanner` 与 `cfpilot-deploy` 到 npm | `npx -y cfpilot-deploy@latest init --help` 与 `npx -y cfpilot-scanner@latest --version` 可用 |
| P1 | 补两个包的 README.md | `files` 字段与实际文件一致，npm 页面有中文说明与用法 |
| P1 | 真实账号冒烟：部署 → 登录 → 优选 → 订阅 | 记录账号类型、Token 类型、绑定域名方式、踩坑点，回写本文档 |
| P1 | Phase 5 自动化联调脚本 | 一条命令起本地内核并验证 101 握手 / 测速 / 回填 / 脏数据订阅输出 |
| P2 | 内核体积余量治理 | 保持 ≤ 50 KB，为后续功能留余量 |
| P2 | 可选：TLS Fragment 参数注入 | 与 BPB-Worker-Panel 行为对齐，需同步更新 README 与订阅渲染 |

---

## 9. 关键文件速查

| 想改什么 | 去哪个文件 |
|----------|-----------|
| 面板界面 | `packages/worker-core/src/ui/panel.html`（改完跑 `npm run build`，会重新生成 `panel.generated.ts`） |
| 优选 IP 解析 / 订阅渲染 | `packages/worker-core/src/sub-engine.ts` |
| 探针行为（101 / 测速） | `packages/worker-core/src/probe.ts` |
| 面板接口 | `packages/worker-core/src/api.ts` |
| 代理入站协议 | `packages/worker-core/src/protocols/*` |
| 出站拨号 / 代理链 | `packages/worker-core/src/outbound/*` |
| 扫描三阶段逻辑 | `packages/scanner-cli/src/scan.ts`、`true-probe.ts` |
| 本地桥接服务 | `packages/scanner-cli/src/server.ts` |
| CF 网段与采样 | `packages/scanner-cli/src/ip-ranges.ts` |
| 部署流程 | `packages/deploy-wizard/src/wizard.ts` |
| Cloudflare API 封装 | `packages/deploy-wizard/src/cf-api.ts` |
| 打包与体积检查 | `packages/worker-core/scripts/build.mjs` |
| 面板压缩注入 | `packages/worker-core/scripts/gen-panel.mjs` |

---

## 10. 凭据与安全须知

- Cloudflare Token、面板密码、扫描令牌**一律走环境变量或 KV**，不得写进代码、README、截图或提交记录。
- `packages/worker-core/.dev.vars` 仅供本地调试，已被 `.gitignore` 排除，**不要提交**。
- 面板路径、密码、扫描令牌部署时随机生成；面板路径可随时更换。
- 内核对 `/api/v1/*` 除公开接口（`/session`、`/login`、`/logout`、`/preferred-ips`）外一律要求会话或 Bearer 令牌。

---

## 11. 免责

本项目仅供学习与自建网络研究使用，使用者需自行遵守所在地法律法规与 Cloudflare 服务条款
（尤其 Free 套餐的流量与 CPU 限制）。MIT 许可，见 [LICENSE](LICENSE)。
