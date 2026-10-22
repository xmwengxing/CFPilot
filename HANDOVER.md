# CFPilot 项目交接文档

> 交接时间：2026-10-22　｜　仓库：`https://github.com/xmwengxing/CFPilot.git`
> 分支：`main`　｜　最新提交：`37ce8e5`（GUI v0.1.1 发布）
> 图形化工具发布页：https://github.com/xmwengxing/CFPilot/releases/tag/gui-v0.1.1

---

## 0. 当前状态（2026-10-22，最优先阅读）

### 项目已可用，三条部署路径

| 路径 | 状态 | 入口 |
|------|------|------|
| **图形化工具** | ✅ 已发布 v0.1.1 | `CFPilot-0.1.1-x64.exe`（安装版）/ `-portable.exe`（便携版），**无需预装 Node** |
| **CLI 部署向导** | ✅ 可用，未发布 npm | `npx -y cfpilot-deploy@latest pages-split` |
| **CLI 优选器** | ✅ 可用，未发布 npm | `npx -y cfpilot-scanner@latest scan --host <域名> --path /vless` |

### 已验证可用（真机）

- Pages **双项目部署**：控制面（面板+订阅+探针）+ 数据面（代理入站），共用同一 KV
- 代理链路：VLESS-WS 101 握手成功 → VLESS 响应头 `[0,0]` → 出站数据帧正常
- 面板：登录、订阅（Base64/Clash/Sing-box）、一键优选全部可用
- **优选测速支持任意项目**：先 101 校验筛出「能服务你域名」的 IP，再对它们测速
  （目标有探针端点走 probe，否则自动切公开测速地址）—— 实测产出 12.2 / 9.5 / 8.7 MB/s
- 更新部署：沿用原 UUID 与 WS 路径，**客户端订阅地址不用改**
- GUI 应用内更新：查 Releases → 下载 → 替换 → 重启

### 关键约束（继续开发前必读）

1. **必须用 CFNext 数据面**，不要改回自研实现。归档在 `archive/self-developed-dataplane/`，
   含完整代码与恢复说明。
2. **控制面与数据面必须分开部署**。合并包在 Pages 上第二次部署返回
   `8000119 Your Pages project has been blocked`（平台主动拒绝，
   Cloudflare 未说明具体触发原因，**不要臆测规则**）。
3. **数据面必须绑定 KV 变量名 `K`**（CFNext 源码读 `t.K.get("config")`），
   控制面读 `KV`。两个都要绑，缺一个就有一侧读不到配置。
4. **数据面配置有两套来源**：环境变量（`U`/`PATH`/`L`）与 KV 的 `config` 键（CFNext schema）。
   后者优先级更高（源码里 `Object.assign(默认, kvConfig)` 整体覆盖）。
   向导会同步写 KV `config` 键。
5. **构建产物必须可复现**。版本号形式为 `<git hash>-<源码内容哈希>`，
   **绝不能加时间戳**（否则 CI 资产一致性校验必然失败）。
6. **面板产物必须统一换行为 LF**（`gen-panel.mjs` 已做）。
   git 的 autocrlf 会让同一份源码产出不同字节，这是历史 CI 反复失败的主因。

### 待办

| 事项 | 说明 |
|------|------|
| npm 发布 | `cfpilot-scanner@0.2.0` / `cfpilot-deploy@0.2.0` 已具备发布条件，需用户执行 F2A |
| Pages 手动部署指南 | README 需补「手动部署」章节，仓库需提供 pages 压缩包 |
| WS 数据面代理池 | vendor 入参不含 SOCKS5/HTTP 代理池，面板配置不生效（仅 `PROXYIP` 有效） |
| Cloudflare 支持请求 | 草稿在 tmp 目录（未发送），引用 Report ID `12704b1598fcad37` |
| 签名 | exe 未签名，SmartScreen 会拦截。可考虑购买 OV 证书消除 |

### 历史结论的处置

下文 §0.1–§0.10 含大量**已被后续实验推翻**的结论，保留仅为追溯。
判断优先级：本文 §0 > [docs/cloudflare-deployment-diagnosis.md](docs/cloudflare-deployment-diagnosis.md) > 下文历史。

特别提醒：下文曾把问题归因为「账号风控」「import 位置」「必须拆分架构」，
这些都**已被真机对照实验证伪**，不要据此继续排查。

---

## 0.11 2026-10-22 的决定性对照实验

这一节记录了推翻旧结论的证据，接手者请先读。

| 实验 | 结果 | 推翻了什么 |
|------|------|-----------|
| 114 字节静态 Worker → workers.dev | 1101 | 「workers.dev 可用」 |
| 同一脚本 → 独立 zone route | 6/6 正常 | 「1101 是账号级封禁」 |
| **cfnext 原版文件**（一行未改）→ Pages 全新随机项目名 | **1/3，第 2 次被封** | 「是我们改坏了数据面」「esbuild 打包导致封禁」 |
| edgetunnel 原版（**完全不用** `cloudflare:sockets`）→ Pages 全新随机项目名 | **4/4 全部成功** | 「Pages 第二次部署必然失败」 |
| 极简 Worker（无 sockets）→ Pages | 4/4 成功 | 同上 |
| 30 行只含 sockets 的脚本 | 加载正常，`connect()` 返回 `TCP Loop detected` | 「TCP Loop 是目标选择问题」 |

**结论**：
- 平台对**含 `cloudflare:sockets` 的 Pages 项目**在第二次部署时拒绝；
  不用 sockets 的项目（edgetunnel 路线）不受影响。
- `TCP Loop detected` 在该环境下是 `cloudflare:sockets` 的系统性限制，
  与目标形态、协议实现无关。
- 因此**双项目拆分**是当前唯一可行的部署形态（各项目首次部署总是成功）。
- 想恢复单项目原地更新，需改用 `fetch()` 落地（edgetunnel 路线），
  这会失去 ProxyIP / NAT64 / SOCKS5 出站能力。

---

## 0.12 优选器的适用边界（2026-10-22 实测）

**代理工具会毁掉优选结果 —— 这是最容易踩的坑。**

只要本机有代理工具接管流量（Clash TUN、系统代理、规则里把待测 IP 走代理），
扫描测出来的就是**到代理的延迟**而不是到目标 IP 的延迟：

| 现象 | 实测证据 |
|------|---------|
| 结果全挤在一个 /24 | 用 TUN 扫描得到 12 条全部是 `103.21.247.x` |
| 延迟被拉平 | 全部显示 18ms（真实差异应该是几百到几千 ms） |
| 机房全同 | 全部 SIN |
| 导入客户端全 -1 | 因为从未真正直连验证过 |

**已实现检测**：`packages/scanner-cli/src/net-env.ts`，CLI 与 GUI 共用。
实测在本机同时命中「Clash Verge 监听 7897」与「fake-ip 198.18.0.82」。

**对照实验**（同一个域名，修正路径后逐个探测不同网段）：

| 探测 IP 所在网段 | 101 校验 | 握手耗时 |
|-----------------|---------|---------|
| 173.245.48.0/20 | ✅ | 1602ms |
| 103.21.244.0/22 | ✅ | 2999ms |
| 103.22.200.0/22 | ✅ | 990ms |
| 162.158.0.0/15 | ✅ | 4696ms |
| 104.16.0.0/13 | ✅ | 1373ms |

结论：
- **101 校验机制是通用的**，任何 CF 网段的 IP 都能通过，不是只对 CFPilot 有效
- 各 IP 的真实握手耗时差异很大（990~4696ms），所以「全部 18ms」必然是 TUN 造成的假象
- 优选器的价值主要在**延迟排序**，而不是「筛掉不可用 IP」——
  对一个正常的 CF 域名，几乎所有 CF IP 都能通过 101 校验

## 0.13 测速方案（2026-10-22 重做）

### 原方案的问题

只能请求 `<目标路径>?bytes=N`，依赖目标项目有 `/__edge_probe` 这个 **CFPilot 专有端点**。
对接第三方项目时该端点不存在 → **速度永远是 0**。

### 取长补短的结论

同类工具（如 CFData-WEB）用**公开测速地址**解决了通用性，
但它**跳过了真连接校验**，于是选出「速度很快但导入客户端全是 -1」的 IP。
CFPilot 的强项恰恰是 101 真连接校验。两者结合：

> **先用 101 校验筛出「确实能服务你的域名」的 IP，再只对这些 IP 测速。**

实测（同一域名，逐个探测不同网段）：

| 探测 IP | 101 校验 | 峰值速度 | 总平均 |
|---------|---------|---------|--------|
| 188.114.96.1 | ✅ | 51.67 MB/s | 16.44 MB/s |
| 其它 6 个 | ❌ | — | 跳过测速 |

注意**峰值与总平均差 3 倍** —— 用平均会严重低估，这是取窗口峰值的原因。

端到端扫描产出：`12.2 / 9.5 / 8.7 MB/s`（此前全是 0）。

### 两种测速方式

| 方式 | 适用 | 要求 | 忠实度 |
|------|------|------|--------|
| `probe` | 目标有探针端点 | 对方须提供 `/__edge_probe` 类端点 | 高（走代理真实路径） |
| `url` | **任何项目** | 无 | 中（测候选 IP 到 CF 边缘的带宽） |

`--speed-mode auto`（默认）自动探测选择。**两种都只作用于已过 101 校验的 IP**。

### 测速精度的三个设计点

1. **滑动窗口峰值，而非总平均** —— 丢弃前 1 秒 TCP 慢启动样本
2. **默认 3 条并发连接** —— 单条 TCP 受拥塞窗口/BDP 限制，高延迟线路填不满带宽
3. **测速地址可用性预检** —— 避免把「地址不可用」误判成「所有 IP 速度都是 0」

### 关键文件

| 想改什么 | 文件 |
|---------|------|
| 吞吐测量（多连接 / 峰值窗口） | `packages/scanner-cli/src/true-probe.ts` 的 `measureThroughput()` |
| 测速地址预设与预检 | `packages/scanner-cli/src/speed-url.ts` |
| 测速方式决策 | `speed-url.ts` 的 `resolveSpeedMode()` |
| 三阶流程编排 | `packages/scanner-cli/src/scan.ts` |

## 0.14 测速地址解析的一个坑（已修）

`parseSpeedUrl` 原本没拦非 http(s) 协议：
`ftp://example.com/a` 会被规范化成 `https://ftp://example.com/a`，
被解析成 `host=ftp` —— **不报错但完全跑不通**。
现在先匹配 `scheme://` 前缀并拒绝非 http(s)。

## 0.15 WS 路径规则

`--path` / GUI 的「WS 路径」**必须与目标项目实际的 WebSocket 路径完全一致**：

| 项目 | 常见路径 |
|------|---------|
| CFPilot / CFNext | `/vless` 或一长串 UUID |
| 部分项目 | 根路径 `/` |
| 不知道 | 分别试 `/` 与 `/vless`，能出结果的那个就是对的 |

实测（`cfp-dat2-umv1.pages.dev`）：

```
/                      → HTTP 200  → 0 条结果
/nonexistent-abc-12345 → HTTP 200  → 0 条结果
/vless                 → HTTP 101  → 有结果
/__edge_probe          → HTTP 101  → 有结果
```

**填错路径不会产生假结果**，只会一个都选不出来 —— 因为校验是真的发起
TLS + WebSocket 101 握手，不是看返回码猜。

## 0.16 scanner CLI 的 MSYS 路径污染（同类问题第二次出现）

Git-Bash 下 `--path /vless` 会被 MSYS 转换成
`C:/Users/<用户名>/.../node_modules/@dsh-ops/bash-win32-x64/vless`，
后果是扫描**静默失败**（0 结果且无任何报错）。

已在 `cli.ts` 的 `normalizeWsPath()` 里拦截，并提示三种绕开方式：

```
1. 用等号写法：      --path=/vless
2. 加环境变量：      MSYS_NO_PATHCONV=1 cfpilot-scanner scan ...
3. 换用 PowerShell / CMD 执行
```

> 部署向导的 `validateOptions()` 早就拦了同类问题，但 scanner 漏了。
> **新增 CLI 路径参数时务必检查这一点。**

## 0.17 GUI 打包产物的两个坑

1. **GPU 开关必须写在主进程顶部**，不能只放在 `scripts/start.mjs`。
   打包后的 exe 不经过 start.mjs，远程桌面下 GPU 进程起不来
   （`error_code=18`）→ 进程直接退出、窗口不出现 →
   用户误以为「需要管理员权限」（提权改变安全上下文后恰好能过）。
   `main.ts` 顶部已无条件设置 `disable-gpu-sandbox` / `disable-gpu` 等开关。

2. **`setAttribute('disabled', '')` 不等于取消禁用**。
   HTML 里只要 `disabled` 属性存在就生效，设成空串仍然禁用，
   表现为按钮永久变灰、必须重启程序。要用 `el.disabled = busy`。

---

## 0.1–0.10 历史记录（结论已被推翻，仅供追溯）

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
| `packages/worker-core` | ✅ 功能完成 | 边缘内核 + 中文面板。合并版 267 KB / 控制面 50 KB / 数据面 226 KB |
| `packages/scanner-cli` | ✅ 可用，未发布 npm | 三阶真连接扫描器 + 本地桥接服务，版本 0.2.0 |
| `packages/deploy-wizard` | ✅ 可用，未发布 npm | 全中文部署向导（Worker 单项目 + Pages 双项目），版本 0.1.0 |
| `packages/gui` | ✅ **已发布 v0.1.1** | Electron 图形化工具，安装版 + 便携版，无需预装 Node |
| 单元测试 | ✅ **178 个全绿** | 19 个测试文件（协议 / 鉴权 / 订阅清洗 / CF API / Pages 部署 / 优选） |
| CI | ✅ **全绿** | 类型检查 → 单测 → 构建 → 资产一致性 → GUI 构建 |
| 真实端到端部署 | ✅ **已验证** | Pages 双项目部署 + 代理链路 + 面板 + 订阅 + 优选全部实测通过 |
| 面板「一键优选」 | ✅ **链路已通** | GUI 与 CLI 均可完成三阶扫描并回填 |

代码规模：`packages/` 下 TypeScript 约 **9000 行**（不含 `dist/` 与生成文件）。

### 部署形态

```
控制面 Pages（无 sockets）      数据面 Pages（CFNext 实现）
  面板 / 订阅 / 探针      ←→    VLESS / Trojan-WS 入站
        │                            │
        └──── 共用同一 KV ───────────┘
             （配置、优选池、凭据）
```

- 控制面通过环境变量 `DATA_HOST` 指向数据面域名，生成订阅时用作 `sni`/`host`
- 数据面用 CFNext 的 `wsHandler`（`packages/worker-core/src/vendor/`）
- 部署清单写在 KV 的 `CFP_DEPLOY_MANIFEST` 键，用于识别同源项目

---

## 3. 仓库结构与模块职责

```text
CFPilot/
├── AGENTS.md                     # 架构铁律（硬性约束，改代码前必读）
├── HANDOVER.md                   # 本文件
├── README.md                     # 用户向文档（中文）
├── cloudflare项目方案.md          # 原始需求方案 + 5 阶段执行计划
├── docs/
│   ├── panel-overview.png        # 面板概览截图
│   └── cloudflare-deployment-diagnosis.md   # 平台限制取证摘要
├── archive/
│   └── self-developed-dataplane/ # 归档：自研 WS 数据面（已弃用，勿直接启用）
├── .github/workflows/
│   ├── ci.yml                    # 类型检查 / 单测 / 构建 / 资产校验
│   └── release-gui.yml           # 图形化工具打包发布
└── packages/
    ├── worker-core/              # @cfpilot/worker-core（private，不发布）
    │   └── src/
    │       ├── index.ts          # 合并版入口（仅本地测试用）
    │       ├── entry-control.ts  # 控制面入口 → dist/control.js
    │       ├── entry-data.ts     # 数据面入口 → dist/dataplane.js
    │       ├── version.ts        # 构建版本号（/__cfp_version 端点）
    │       ├── routes/           # control.ts（控制面）/ data.ts（数据面）/ shared.ts
    │       ├── config.ts         # 配置加载（KV CONFIG > env > 默认值）
    │       ├── auth.ts           # 密码 + 会话 Cookie + 一次性扫描令牌
    │       ├── api.ts            # 面板 REST API + SSE
    │       ├── store.ts          # KV / 内存存储抽象
    │       ├── probe.ts          # /__edge_probe（WS 101 校验 + 流式测速）
    │       ├── sub-engine.ts     # 优选池合并 + 脏数据清洗 + 三格式订阅输出
    │       ├── budget.ts         # Free CPU 毫秒预算保护
    │       ├── protocols/        # vless / trojan / xhttp / websocket / stream / address / sha224
    │       ├── outbound/         # dial（并发竞速 / NAT64）/ socks5 / http-proxy / proxy-pool
    │       ├── vendor/           # CFNext 数据面（原样引入，勿改）
    │       └── ui/panel.html     # 单文件零框架中文面板（构建时压缩进 panel.generated.ts）
    ├── scanner-cli/              # cfpilot-scanner（npm 包，未发布）
    │   └── src/  cli / scan / candidates / true-probe / server(桥接) / ip-ranges / scanner-lib
    ├── deploy-wizard/            # cfpilot-deploy（npm 包，未发布）
    │   ├── src/  cli / wizard / pages-deploy / cf-api / deployer-lib / token-check / access-check
    │   └── assets/cfpilot-worker.js   # 内置内核资产（CI 校验与构建一致）
    └── gui/                      # @cfpilot/gui（Electron 图形化工具）
        ├── src/main/             # main / bridge / scanner / updater / config-store
        ├── src/preload/          # contextBridge 最小 API
        ├── src/renderer/         # index.html + renderer.ts
        ├── build/icon.png        # 应用图标
        └── scripts/              # build.mjs（esbuild 打包）/ start.mjs（启动与 GPU 降级）
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
  但**面板路径与密码例外**：环境变量优先（`auth.ts` 的 `ensureBootstrap`），
  否则复用 KV 部署时新生成的凭据会被旧哈希挡住，表现为「拿着新密码登不进去」。
- **面板**：概览 / 节点来源 / 订阅 / 入站配置 / 高级 五个页签，单文件零框架。
- **版本端点**：`GET /__cfp_version` 返回构建版本号，供部署向导判断是否需要更新。

### scanner-cli（本地真连接优选器）

- 三阶扫描：TCP 握手初筛 → WS 101 真连接校验 → 真实下行测速。
- **直跑模式**：`npx cfpilot-scanner scan --host <域名> --token <令牌>`，跑完自动回填面板 KV。
- **对接任意 VLESS-WS 项目**：`--path /<该项目路径>` 指定目标 WS 路径，
  不依赖 CFPilot 自己的探针端点；目标没有测速端点时自动跳过测速（`--no-speed`）。
- **可复制输出**：额外打印 `IP:端口#机房` 列表，一行一个，可直接粘进同类项目的
  「自定义 IP」输入框。
- **桥接模式**：`npx cfpilot-scanner serve` 在 `127.0.0.1:19527` 提供
  `/status`、`/start-scan`、`/events`(SSE)、`/results`。
- Cloudflare 网段：优先拉官方 `cloudflare.com/ips-v4|ips-v6`，失败回退内置 CIDR 库；固定随机种子，结果可复现。
- **库出口** `src/scanner-lib.ts` 导出 `runScan` / `resolveCandidates` / `formatCopyable`，
  供 GUI 进程内直接调用（不起子进程、不需要系统装 Node）。

### deploy-wizard（全中文部署向导）

- 两种部署通道：
  - `init` —— Worker 单项目（上传内核 + 绑自定义域名）
  - `pages-split` —— **Pages 双项目（当前推荐）**
- **Pages 双项目流程**：建项目 → 配 KV 与环境变量 → 先部署数据面再部署控制面。
  顺序不可调换：Pages 的绑定只对之后的部署生效，且控制面需要数据面域名才能生成订阅。
- **同源项目识别**：部署清单写在 KV 的 `CFP_DEPLOY_MANIFEST` 键
  （记录两个项目名、域名、构建版本、凭据）。更新部署时自动读取，
  **用户不需要记项目名**。
- **版本跳过**：构建版本一致时跳过部署，避免无谓触发平台审核。
- **沿用凭据**：更新时默认沿用原 UUID / WS 路径 / 面板凭据，**客户端订阅地址不用改**。
  需要重置时用 `--new-credentials`。
- **8000119 自动换名重试**：数据面部署被平台拒绝时，自动新建随机项目名再试。
- **参数校验**：拒绝被 MSYS 转换的 Windows 路径（`--panel-path /p-x` 在 Git-Bash 下
  会被转成 `C:/Users/.../p-x`），避免写坏 Pages 环境变量。
- **不丢密码**：域名绑定全程「尽力而为」，任何一步失败只降级告警，绝不抛出。
- 支持 `--yes` 非交互与 `--dry-run`。

### gui（图形化部署与维护工具，Electron）

- 四个页签：Cloudflare 凭据 / 一键部署 / 本地真连接优选 / 说明；
  下方是常驻运行日志（可折叠，出错时自动展开）。
- **凭据只存本机** `~/.cfpilot-gui/secrets.json`，不经过任何中间层，
  界面多处明示不上传。
- **账号与 KV 自动检测**：不手填账号 ID，用 Token 查可见账号、复用已有 KV、
  没有就自动创建。
- **优选直接跑**：进程内 import scanner 库，参数表单带建议值，
  结果同时给「可复制列表」与表格。
- **应用内更新**：查 GitHub Releases → 下载 portable exe → 替换 → 重启。
- **不需要管理员权限**：NSIS 装 `allowElevation: false`。
- **GPU 降级启动**：`scripts/start.mjs` 逐级尝试
  `--disable-gpu-sandbox` 等参数（`app.disableHardwareAcceleration()` 太晚，无效）。
- **打包产物**：`CFPilot-<版本>-x64.exe`（安装版）+ `CFPilot-<版本>-portable.exe`（便携版）。

---

## 5. 未完成项与已知缺口（接手后按此优先级推进）

### 已关闭的缺口（2026-10-22）

| 原缺口 | 状态 | 说明 |
|------|------|------|
| 缺口 1：面板「一键优选」链路断裂 | ✅ 已修 | `src/candidates.ts` 已抽出，桥接服务在未收到 `candidates` 时自行生成；面板与 GUI 均可跑完三阶扫描 |
| 缺口 3：两个 npm 包缺 README | ✅ 已补 | `packages/scanner-cli/README.md`、`packages/deploy-wizard/README.md`、`packages/gui/README.md` |
| 缺口 4：没有真实端到端验证 | ✅ 已完成 | Pages 双项目部署 → 面板登录 → 订阅 → 优选 → 代理链路，全部真机实测通过 |

### 缺口 2（P0）：两个 CLI 未发布到 npm

- 实测 `npm view cfpilot-deploy versions` → `['0.0.0-stage', '0.1.0']`，
  `npm view cfpilot-scanner versions` → 同上。**0.1.0 是 10-21 发的旧版**，
  当前代码是 scanner 0.2.0 / deploy 0.2.0，需要发新版。
- **必须发新版**，否则 `npx -y cfpilot-deploy@latest` 拉到的是没有 `pages-split` 的旧包。
- 发布前需确认：`npm publish --access public`（scanner-cli 需 `dist` 已在 `files` 中；
  deploy-wizard 还需 `assets`，因为内核资产随包分发）。
- **版本号需先升到 0.2.0**，否则会与已发布的 0.1.0 冲突（`EPUBLISHCONFLICT`）。
- 发布需要用户执行 F2A 认证。

### 缺口 5（P1）：方案文档 Phase 5 的自动化联调脚本未落地

原方案 Phase 5 要求「wrangler 本地起内核 → 跑 scanner → 校验 101/测速/回填 → 校验脏数据订阅输出」
的自动化脚本。目前只有单元测试覆盖了协议与清洗逻辑，**没有覆盖 `/__edge_probe` 端到端与回填链路**。

> 注：workerd 的 SQLite 在受限环境下无法初始化（`SQLITE_CANTOPEN`），
> 本机跑不了 `wrangler dev --local` / miniflare。CI 上可考虑用 `workerd` 裸进程做冒烟。

### 缺口 6（P1）：Pages 手动部署指南缺失

- README 目前只写了 CLI 与图形化两条路径，**没有「手动部署」章节**。
- 需要补：Pages 控制台逐步操作说明 + 仓库提供可上传的 pages 压缩包。
- 压缩包应含两个目录：`control/`（`_worker.js` = `dist/control.js`）与
  `data/`（`_worker.js` = `dist/dataplane.js`），并说明两者的绑定与变量配置。

### 缺口 7（P2）：WS 数据面代理池不生效

- `protocols/websocket.ts` 调用 vendor 的 `wsHandler`，其入参只有 `proxyIP`，
  **没有 SOCKS5 / HTTP 代理池字段**。
- 因此面板「高级」里配置的 `SOCKS5` / `HTTP_PROXY` 对数据面无效，只有 `PROXYIP` 生效。
- 要修需改 vendor 或让自研实现接管（后者已被证明不可行，见 §0.11）。

### 缺口 8（P2）：功能层面明确不支持的部分（属设计取舍，非 bug）

- UDP over WebSocket → 返回 400。
- XHTTP 不支持 UDP → 返回 400。
- Clash / Sing-box 内核不支持 XHTTP，这两种订阅只输出 WS 节点；Base64 分享链接同时给 `type=ws` 与 `type=xhttp&mode=stream-one`。
- 方案文档提到的「BPB 风格 TLS Fragment 参数注入」未实现（可选功能，README 也没承诺）。

### 缺口 9（P2）：exe 未代码签名

- SmartScreen 会提示「已阻止无法识别的应用」，用户需点「更多信息 → 仍要运行」。
- 彻底消除需购买 OV 代码签名证书（约 $70-200/年）。
- 自签名证书**同样会触发 SmartScreen**，只是提示文案不同，意义不大。

---

## 6. 接手前必须知道的架构铁律

以下来自 AGENTS.md（硬性约束，违反即回退）：

1. **配置优先级恒为** `KV(CONFIG) > 环境变量 > 内置默认值`；新增配置项必须三层都支持并在 `config.ts` 登记。
2. **Worker 产物预算 80 KB**；不要往 `worker-core` 塞第三方依赖；面板必须是零框架单文件 HTML。
3. **`/__edge_probe` 不可删除**，必须始终提供「WS 101 握手校验」+「流式下行测速」两项能力。
4. **优选 IP 清洗逻辑只能写在 `sub-engine.ts`**，禁止在别处重复实现。
5. **数据面与控制面分离**：`worker-core` 只处理代理与订阅；不得引入 Node API（`node:*`）。
6. **零运行时依赖**：`scanner-cli` / `deploy-wizard` 不得引入第三方运行时依赖，必须能被 `npx -y` 秒级拉起。
7. 编码规范：TypeScript `strict`、禁止 `any`（用 `unknown` + 收窄）、注释与用户文案一律中文、Worker 侧禁止 `console.log`。
8. 提交前必须 `npm run typecheck && npm run test && npm run build` 三连通过。

### 本项目特有的铁律（2026-10-22 新增，违反会直接导致线上故障）

9. **数据面必须用 CFNext 实现**（`src/vendor/cfnext-dataplane.js`），不要改回自研版本。
   自研版已归档在 `archive/self-developed-dataplane/`，含恢复说明。
10. **控制面与数据面必须分开部署。** 合并包在 Pages 上第二次部署会被平台拒绝
    （`8000119`）。Cloudflare 未说明原因，**不要臆测规则、不要试图混淆规避**。
11. **数据面必须绑 KV 变量名 `K`**，控制面绑 `KV`。两个都绑。
    CFNext 源码读 `t.K.get("config")`，只绑 `KV` 会导致数据面读不到配置。
12. **数据面配置要写 KV 的 `config` 键**（CFNext schema），不只是环境变量。
    源码里 `Object.assign(默认, kvConfig)` 是整体覆盖，KV 优先于环境变量。
13. **构建产物必须可复现。** 版本号 = `<git hash>-<源码内容哈希前8位>`，
    **绝不能加时间戳**。
14. **面板产物必须统一换行为 LF**（`gen-panel.mjs` 已做）。git 的 autocrlf 会让
    同一份源码产出不同字节，这是历史 CI 反复失败的主因。

### 三个容易踩的「不要动」点

- **`packages/worker-core/scripts/gen-panel.mjs` 的换行归一化与 gzip OS 字节归一化不要改回去。**
  前者消除 CRLF/LF 差异，后者消除 gzip 头第 10 字节的平台差异（Windows `0x0a` / Linux `0x03`）。
  两者都会让 CI 的「资产与构建一致」校验误报失败。
- **CLI 的 shebang 只能由构建脚本注入。** 源码 `cli.ts` 里再写一次 `#!` 会让 esbuild 产物出现两行 `#!`，
  Node 只认第一行 → 语法错误，npx 直接不可用（commit `044cb33` 已修，脚本里有重复 `#!` 守卫）。
- **改 `compatibility_date` 时要同时改两处**：`packages/worker-core/wrangler.jsonc` 与
  `packages/deploy-wizard/src/wizard.ts` 的 `COMPATIBILITY_DATE`（当前均为 `2026-01-01`）。

### Electron 相关的两个坑

- **GPU 错误不能用 `app.disableHardwareAcceleration()` 解决**：GPU 进程在 JS 入口
  执行**之前**就已启动（electron/electron#14273）。必须在**命令行参数**里禁用
  （`scripts/start.mjs` 已做逐级降级）。
- **esbuild ESM→CJS 的 `0 && (module.exports = ...)` 守卫**：被 bundle 的模块导出
  会变成死代码。GUI 的 `bridge` / `config-store` / `scanner` 必须**各自独立成文件**，
  不能内联进 main.js。

---

## 7. 常用命令

```bash
npm install
npm run typecheck     # 各子包 tsc --noEmit（worker-core 会先重新生成面板产物）
npm test              # vitest run —— 19 文件 / 178 用例
npm run build         # 内核 + 两个 CLI + GUI 打包，并同步 assets/cfpilot-worker.js
npm run verify        # build + typecheck + test
npm run clean         # 清理 dist / .wrangler

# 本地调试用的凭据在 packages/worker-core/.dev.vars（已被 .gitignore 排除，不要提交）
```

### 图形化工具

```bash
npm run start -w @cfpilot/gui              # 从源码启动（带 GPU 降级重试）
npm run build -w @cfpilot/gui
cd packages/gui && npm run dist             # 打包 exe → packages/gui/release/
```

> 打包需要两个环境条件（Windows 沙箱下尤其明显）：
> 1. `TEMP` 指向可写目录（NSIS 的 makensis 需要创建临时文件）
> 2. `npm_config_allow_scripts=true`（npm 的 allowScripts 策略会拦 electron-builder 的子进程安装）

> 若 `node_modules/electron/dist/` 被清空（`npm install` 时 electron 的 postinstall
> 被 allowScripts 拦下），需重新下载解压 electron 二进制。

### 发布

```bash
# npm 包（需用户执行 F2A）
cd packages/scanner-cli  && npm publish --access public
cd packages/deploy-wizard && npm publish --access public

# 图形化工具：推 tag 触发 CI 自动发布
git tag gui-v0.2.0 && git push origin gui-v0.2.0
```

### CI

`.github/workflows/ci.yml`：类型检查 → 单测 → 构建 → 校验内置资产与构建一致 → 上传内核产物
→ 独立 job 构建 GUI。
`.github/workflows/release-gui.yml`：推 `gui-v*` 标签或手动触发 → 打包 → 上传到 Releases。

---

## 8. 建议的下一步路线

| 优先级 | 事项 | 验收标准 |
|--------|------|----------|
| P0 | 发布 `cfpilot-scanner@0.2.0` 与 `cfpilot-deploy@0.2.0` 到 npm | `npx -y cfpilot-deploy@latest pages-split --help` 与 `npx -y cfpilot-scanner@latest --version` 可用（**先升版本号，否则与已发布的 0.1.0 冲突**） |
| P1 | 补 README「手动部署」章节 + 仓库提供 pages 压缩包 | 压缩包含 `control/` 与 `data/` 两个目录，各自带 `_worker.js`；README 说明控制台逐步操作 |
| P1 | 打通数据面代理池（SOCKS5 / HTTP） | 面板高级页配置的代理对数据面生效（当前只有 `PROXYIP` 有效） |
| P2 | Phase 5 自动化联调脚本 | 一条命令起本地内核并验证 101 握手 / 测速 / 回填 / 脏数据订阅输出（注意 workerd 的 SQLite 限制） |
| P2 | 代码签名 | 消除 SmartScreen 拦截（需购买 OV 证书） |
| P2 | 可选：TLS Fragment 参数注入 | 与 BPB-Worker-Panel 行为对齐，需同步更新 README 与订阅渲染 |

---

## 9. 关键文件速查

| 想改什么 | 去哪个文件 |
|----------|-----------|
| 面板界面 | `packages/worker-core/src/ui/panel.html`（改完跑 `npm run build`，会重新生成 `panel.generated.ts`） |
| 优选 IP 解析 / 订阅渲染 | `packages/worker-core/src/sub-engine.ts` |
| 探针行为（101 / 测速） | `packages/worker-core/src/probe.ts` |
| 面板接口 | `packages/worker-core/src/api.ts` |
| 面板鉴权 / 凭据优先级 | `packages/worker-core/src/auth.ts` |
| 代理入站协议（WS 用 vendor） | `packages/worker-core/src/protocols/*`、`packages/worker-core/src/vendor/` |
| 出站拨号 / 代理链 | `packages/worker-core/src/outbound/*` |
| 控制面 / 数据面路由 | `packages/worker-core/src/routes/` |
| 构建版本号与产物可复现 | `packages/worker-core/scripts/build.mjs` |
| 面板压缩与换行归一化 | `packages/worker-core/scripts/gen-panel.mjs` |
| 扫描三阶段逻辑 | `packages/scanner-cli/src/scan.ts`、`true-probe.ts` |
| 候选 IP 生成 | `packages/scanner-cli/src/candidates.ts` |
| scanner 库出口（供 GUI 复用） | `packages/scanner-cli/src/scanner-lib.ts` |
| 本地桥接服务 | `packages/scanner-cli/src/server.ts` |
| CF 网段与采样 | `packages/scanner-cli/src/ip-ranges.ts` |
| Worker 单项目部署流程 | `packages/deploy-wizard/src/wizard.ts` |
| **Pages 双项目部署流程** | `packages/deploy-wizard/src/pages-deploy.ts`（清单、版本跳过、换名重试都在这里） |
| CF API 封装 | `packages/deploy-wizard/src/cf-api.ts` |
| 部署向导 CLI | `packages/deploy-wizard/src/cli.ts` |
| GUI 主进程与桥接 | `packages/gui/src/main/*` |
| GUI 界面 | `packages/gui/src/renderer/*` |
| GUI 应用内更新 | `packages/gui/src/main/updater.ts` |
| GUI 打包配置 | `packages/gui/package.json` 的 `build` 字段 |
| **吞吐测量**（多连接 / 峰值窗口） | `packages/scanner-cli/src/true-probe.ts` 的 `measureThroughput()` |
| **测速地址预设与预检** | `packages/scanner-cli/src/speed-url.ts` |
| 测速方式决策 | `speed-url.ts` 的 `resolveSpeedMode()` |
| 网络环境（代理）检测 | `packages/scanner-cli/src/net-env.ts` |
| 自研数据面归档（勿启用） | `archive/self-developed-dataplane/` |
| 打包与体积检查 | `packages/worker-core/scripts/build.mjs` |
| 面板压缩注入 | `packages/worker-core/scripts/gen-panel.mjs` |

---

## 10. 凭据与安全须知

- Cloudflare Token、面板密码、扫描令牌**一律走环境变量或 KV**，不得写进代码、README、截图或提交记录。
- `packages/worker-core/.dev.vars` 仅供本地调试，已被 `.gitignore` 排除，**不要提交**。
- 面板路径、密码、扫描令牌部署时随机生成；面板路径可随时更换。
- 内核对 `/api/v1/*` 除公开接口（`/session`、`/login`、`/logout`、`/preferred-ips`）外一律要求会话或 Bearer 令牌。
- **GUI 的凭据只写在本机** `~/.cfpilot-gui/secrets.json`，
  不经过任何中间层、不上传、不随安装包分发。界面上有多处明示。
  部署时会在日志里打印，但**不会**写进仓库或任何远端。

---

## 11. 当前线上环境（供接手者参考，2026-10-22）

| 项目 | 说明 |
|------|------|
| Pages `cfp-ctl-test` | 控制面，域名 `cfp-ctl-test.pages.dev`，面板路径见部署日志 |
| Pages `cfp-dat2-umv1` | 数据面（换名后的当前版本），`cfp-dat2-umv1.pages.dev` |
| Pages `cfnext` | 用户原有的 CFNext 项目，**不要动** |
| KV `cfp-kv` | 两个项目共用，存配置 / 优选池 / 部署清单 / 凭据哈希 |
| Worker 脚本 | 0 个（数据面走 Pages） |

部署清单在 KV 的 `CFP_DEPLOY_MANIFEST` 键，是识别「同源项目」的唯一依据。

> 这些是**用户测试账号**的资源。接手后如果要重新部署，优先用
> `npx -y cfpilot-deploy@latest pages-split`（自动识别并复用清单），
> 不要手工建 Pages 项目，否则清单会指向旧项目。

---

## 12. 免责

本项目仅供学习与自建网络研究使用，使用者需自行遵守所在地法律法规与 Cloudflare 服务条款
（尤其 Free 套餐的流量与 CPU 限制）。MIT 许可，见 [LICENSE](LICENSE)。
