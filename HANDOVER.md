# CFPilot 项目交接文档

> 最后更新：2026-10-24 凌晨　｜　仓库：`https://github.com/xmwengxing/CFPilot.git`
> 分支：`main`　｜　**全仓统一版本：0.3.0**（版本政策见 §0.3）
> npm：`cfpilot-scanner@0.3.0` / `cfpilot-deploy@0.3.0` **均已发布**
> 图形化工具最新 release：`gui-v0.1.4`（`CFPilot-0.1.4-x64.exe` / `-portable.exe`）；
> 下一次发版按新版本政策打 tag `gui-v0.3.0`
>
> 🆕 **2026-10-24 新增**：部署形态从「单一 Pages 双项目」扩展为**双形态**
> （Pages 默认 / Workers 实验性），见 §0.22。GUI 与 CLI 均可选择。

---

## 0. 当前状态（最优先阅读）

### 0.1 一句话现状

CFPilot 已是一个**功能完整、经真机验证**的 Cloudflare 代理微内核 + 真连接优选面板：
自研数据面为默认实现（vendor CFNext 可回退），四条交付路径全部就绪
（GUI exe / 两个 npm 包 / 线上部署 / CI），**支持 Pages 与 Workers 两种部署形态**，
全仓测试 **40 个文件 / 390 个用例全绿**。

### 0.2 交付物状态

| 路径 | 状态 | 入口 |
|------|------|------|
| 图形化工具 | ✅ 已发布 v0.1.4 | GitHub Releases：`CFPilot-0.1.4-x64.exe`（安装版）/ `-portable.exe`（便携版），**无需预装 Node** |
| CLI 优选器 | ✅ **npm 已发布 0.3.0** | `npx -y cfpilot-scanner@latest scan --host <域名> --path /vless` |
| CLI 部署向导 | ✅ **npm 已发布 0.3.0** | `npx -y cfpilot-deploy@latest pages-split --token <TOKEN>` |
| 线上部署 | ✅ 运行中 | 控制面 `e4kkjet6.pages.dev`（详见 §11） |

### 0.3 版本体系（2026-10-23 立：单一版本源）

- **所有包同版本**：root / worker-core / scanner-cli / deploy-wizard / gui 版本号永远一致，
  无论某个包本身有没有代码变动，只要发布就一起升。根 `package.json` 的 `version`
  是**唯一版本源**，当前全仓 **0.3.0**。
- 升级唯一入口：`npm run version:bump -- 0.4.0`（或 `major` / `minor` / `patch`）——
  改根版本并同步全部 workspace（`scripts/bump-version.mjs` → `scripts/sync-version.mjs`）。
- 手动改子包 `package.json` 或 `src/version.ts` 的版本号 = **违规**。
- npm 发布兜底：`scanner-cli` / `deploy-wizard` 的 `prepublishOnly` 会自动再同步一次
  （历史事故：npm 上是 0.3.0、CLI `--version` 报 0.2.0，因 `version.ts` 是硬编码常量漏改）。
- GUI 发版 tag 必须与根版本一致（如 `gui-v0.3.0`），CI 会校验，不一致直接失败。
- 完整政策见 AGENTS.md「版本号政策」专节。

### 0.4 已验证的核心能力（真机）

- **自研数据面为默认**（`DATAPLANE=self` 缺省）：非 CF 网段目标 100%，
  CF 网段目标经反代入口 67% → 100%，与 vendor 持平或更好（§0.20.10）。
- 三种入站 **VLESS-WS / Trojan-WS / VLESS-XHTTP** 全部真机端到端通过（§0.20.12）。
- **代理池 SOCKS5 / HTTP CONNECT / HTTPS 真机 3/3 全绿**（§0.20.13）。
- 自配反代入口端到端生效（面板 API → KV → 数据面，§0.20.11）。
- 面板：登录 / 订阅（Base64 / Clash / Sing-box，**UA 自动识别**）/ 一键优选 /
  国家筛选 / 订阅名称与端口多选 / 数据面域名展示 / ECH 开关。
- 订阅导入客户端自动填 **`CFPilot`**（不再是 `CFPilot.yaml`，§0.21 #25）。
- 节点预览不再谎报「CPU 预算不足」（§0.21 #22）。

### 0.5 关键约束（继续开发前必读）

1. **数据面默认自研，vendor 可回退**：`resolveDataPlaneImpl()` 缺省 `self`；
   `DATAPLANE=vendor` 切回 CFNext（`src/vendor/cfnext-dataplane.js`，**勿改**）。
   ⚠️ 本文旧版与 AGENTS.md 旧版写的「必须用 CFNext 数据面、不要改回自研」**已作废**
   （自 2026-10-23 §0.20.10 起自研为默认）。
2. **控制面与数据面必须分开部署**（共用同一 KV）。有两种形态：
   - **Pages 双项目（默认）**：两个 Pages 项目，控制面走 `dist/control.js`（无 sockets），
     数据面走 `dist/dataplane.js`；
   - **Workers 双脚本（实验性）**：两个 Worker 脚本，产物相同。
     ⚠️ 数据面在 Workers 上会 522（§0.22），控制面完全可用。
   两种形态**不能共用同一个 KV**（KV 键全局平铺，会互相覆盖凭据）。
3. **一个 KV 命名空间 = 一个 CFPilot 实例**。内核在 KV 里的键**全局平铺、无实例前缀**，
   两个实例共用一个 KV 会互相覆盖 UUID / WS 路径 / 面板密码 / 会话。
   归属**只能靠清单键**判断（字段值不唯一，不能作依据）：
   Pages 用 `CFP_DEPLOY_MANIFEST`，Workers 用 `CFP_DEPLOY_MANIFEST_WORKERS`。
   部署向导写入任何键之前做归属校验，越界一律中止。
4. **绝不要写 CFNext 的小写 `config` 键**。vendor 侧是 `Object.assign(默认, kvConfig)`
   **整体覆盖**，写进去会直接改坏共栖的 CFNext 项目的 uuid / path / trojanPassword；
   CFPilot 数据面根本不读它（读大写 `CONFIG`），写了纯属破坏。
5. **8000119 的平台行为（2026-10-23/24 实测定性，不要臆测规则）**：
   - 控制面（不承载代理流量）：原地重部署**无限制**；
   - **Pages 数据面（已承载流量）**：**原地重部署是持久性拒绝**（实测 4/4 被拒）→
     更新数据面必须**新建项目 + 切控制面 `DATA_HOST` + 重发控制面**，
     向导已自动化该流程（含 DATA_HOST 同步，问题 3 的修复）；
   - **Workers 脚本（含数据面）**：原地重复更新 **5/5 全部成功，从未出现 8000119**
     （§0.22.1）—— 这是 Workers 通道的核心优势；
   - 新项目首次部署：**间歇性**拒绝，**原样重试通常可过**（先重试再换名，
     `deployWithBlockRetry` 已按此实现）。
6. **Worker 不能连回 Cloudflare 自家 Anycast**（`1.1.1.1` / `cloudflare.com` /
   `104.16.0.1` 一律 `TCP Loop detected`），**第三方 IP 的 443 完全可用**；
   CF 网段目标只能靠「反代入口」按 SNI 转发打通（§0.20.2 / §0.20.10）。
7. 配置优先级 `KV(CONFIG) > 环境变量 > 内置默认值`（面板路径与密码例外：env 优先，
   否则复用 KV 部署时新凭据被旧哈希挡住，表现为「拿着新密码登不进去」）。
8. **构建产物必须可复现**：版本号 = `<git hash>-<源码内容哈希前8位>`，**禁时间戳**；
   面板产物统一 LF 换行（`gen-panel.mjs` 已做，改回去会让 CI 资产校验误报）。

### 0.6 待办

| 事项 | 状态 |
|------|------|
| npm 发布（scanner-cli + deploy-wizard） | ✅ 已完成（0.3.0，用户执行 F2A） |
| README「手动部署」章节 + 仓库提供 pages 压缩包 | ⬜ 未做（缺口 6） |
| DoH 的 TXT 优选库路径真机验证 | ⬜ 未验（需要特定域名，普通域名 TXT 是 SPF/验证记录） |
| GUI 界面人工点验 | ⬜ 仅构建 + 类型检查 + 产物标记验证 |
| exe 代码签名 | ⬜ 未做（SmartScreen 提示，缺口 9） |
| 数据面内核更新到最新版 | ⬜ 已解除 8000119 限制 —— Workers 通道可原地更新（§0.22），但数据面在 Workers 上 522；**仍建议 Pages 新建项目流程**（§0.19.4） |
| **Workers 数据面 522 触发点** | ⬜ **未解决**。已排除体积/sockets/账号/KV/vendor/relay 域名等因素；触发点是 `websocket-self` 的 `dial()` 调用块（§0.22.3）。可尝试的下一步：把 `outbound/*` 全部内联进单一入口文件（edgetunnel 形态） |
| **单 Worker 合并部署** | ⬜ 技术上 `dist/worker.js` 已支持，但真机仍 522（同上）；不建议作为默认形态（§0.22.7） |

---

## 0.22 双部署形态：Pages（默认）+ Workers（实验性）（2026-10-24）

用户要求「把单 worker 部署改成双 worker 部署，并测试是否可行；若 worker 更新更稳定
就把默认改成 worker 模式」。**结论：Workers 的更新确实更稳，但数据面跑不通，
因此 Workers 作为实验性选项保留，默认仍是 Pages。**

### 0.22.1 真机实验：60+ 轮对照，两个账号

| 对照项 | Pages 通道 | Workers 通道 |
|--------|-----------|-------------|
| 同一份数据面产物能否运行 | **5/5 → 200 ✅** | **5/5 → 522 ❌** |
| 原地重复更新 | 承载流量后**持久拒绝**（8000119） | **5/5 全部成功**，无 8000119 |

同一账号、同一时刻、**同一字节内容**（`wsSelf.js`，26.2 KB），
Pages `_worker.js` 5/5 返回 `wsSelf4`，Workers 自定义域名 5/5 返回 522。

### 0.22.2 已排除的假设（都不是原因）

| 假设 | 实验 | 结论 |
|------|------|------|
| 体积超限 | 260KB 纯合法脚本（4000 个函数） | 200 ✅ 排除 |
| 静态 `cloudflare:sockets` | 只 import 不调用 / 真调用 | 200 ✅ 排除 |
| 动态 `import("cloudflare"+":sockets")` | 拼接式 + 字面量式 | 200 ✅ 排除 |
| `compatibility_date` | 无 / 2024 / 2025 / 2026 | 全 522，排除 |
| minify | minify on / off | 全 522，排除 |
| 账号状态 | 备用**干净账号**（0 项目 0 脚本） | 同样 522，排除 |
| KV 绑定 | 无绑定 / 双绑定 KV+K | 全 522，排除 |
| 模块级 API | `new Map` / `TextEncoder` / `WebSocketPair` 等逐个单测 | 上传即被拒或 200，均正常 |
| esbuild target | es2019 / es2020 / es2022 | 全 522，排除 |

### 0.22.3 精确触发点（含控制面可用证据）

**数据面 522 的触发条件**：`protocols/websocket-self.ts` 里的 **`dial()` 出站调用块**。

- 把 `dialed = await dial({...})` 换成桩 → **立即恢复 200**（7.5KB 产物 → 200）
- 保留 `import { dial }` 但不调用 → 仍 522
- 逐条删除 `handleWebSocket` 函数体的顶层语句，只有删掉含 dial 调用的那段才恢复 200

而 `outbound/dial.ts` **单独**打包（18.5KB）在 Workers 上完全正常（200）。
两者组合才失败 —— 这是 Workers 运行时的一条尚未查清的边界，不是我们的代码 bug。

**已排除**（都不是原因）：体积（28.5KB 纯填充 → 200）、静态/动态 sockets 导入、
`compatibility_date`、minify、账号状态、KV 绑定、模块级 API、esbuild target、
vendor 232KB、内置反代域名（`cmliussss` 字样）、`relay` 模块单独引入。

### 0.22.3b Workers 通道的最终能力边界（真机实测）

| 能力 | Workers 通道 | 说明 |
|------|-------------|------|
| 控制面：面板 HTML | ✅ 200（41KB 完整面板） | 与 Pages 无差异 |
| 控制面：订阅（Base64/Clash/Sing-box） | ✅ 200 | UA 协商同样生效 |
| 控制面：探针 `__edge_probe` | ✅ 200（流式测速正常） | — |
| 控制面：原地重复更新 | ✅ **5/5 全部成功，无 8000119** | **核心优势** |
| 数据面：VLESS-WS / Trojan-WS / XHTTP | ❌ 522（isolate 启动失败） | 触发点见 §0.22.3 |

**结论**：Workers 通道适合「只想要面板 + 订阅 + 长期可更新」的用户；
需要稳定数据面（真代理）仍应使用默认的 Pages 双项目。

### 0.22.3c 为 Workers 通道做的代码改造

| 文件 | 改动 | 目的 |
|------|------|------|
| `packages/worker-core/src/outbound/dial.ts` | 新增 `setConnectOverride()` / `hasConnectOverride()`；`getConnect()` 优先用注入实现 | Workers 用 `request.fetcher.connect` 代替 `cloudflare:sockets` |
| `packages/worker-core/src/entry-data-self.ts` | **新增**。纯自研数据面入口（零 vendor，39.8KB） | 含 vendor 的产物在 Workers 上 522；本产物同时注入 connect 与 dial |
| `packages/worker-core/src/index.ts` | `installConnect()` 注入 connect + dial | 合并版同样支持 Workers |
| `packages/worker-core/src/entry-data.ts` | `installConnect()` 同上 | — |
| `packages/worker-core/src/protocols/websocket-self.ts` | `resolveDial()` 运行时取 dial，**去掉静态 import** | 静态依赖是 522 触发条件之一 |
| `packages/worker-core/src/routes/data.ts` | `resolveWsHandler(impl)` 按实现动态取处理器 | `self` 时不再静态引入 vendor |
| `packages/worker-core/scripts/build.mjs` | `vendorSocketsShim` + `stripSocketsFallback` 插件；新增 `dataplane-self.js` 产物目标 | 构建期剥离 sockets 静态/动态引用 |
| `packages/deploy-wizard/src/worker-deploy.ts` | 默认加载 `dataplane-self.js`（缺失时回落通用产物并告警） | Workers 通道默认用纯自研产物 |

> ⚠️ 上述改造**不影响 Pages 通道**：`dataplane.js`（含 vendor）仍按原样构建，
> `dataplane-self.js` 只被 `worker-split` 使用。Pages 通道行为与 0.3.0 完全一致。

> ⚠️ 复现要点：**必须用自定义域名或 workers.dev 访问**。
> 本机 `workers.dev` DNS 被污染，无法直连验证；跨账号 fetch 也会拿到 1101/522，
> 因此结论只依赖「同一账号、同一时刻、同一份字节、不同通道」的对照。

### 0.22.4 实现内容

| 文件 | 改动 |
|------|------|
| `packages/deploy-wizard/src/worker-deploy.ts` | **新增**。Workers 双脚本部署，含 KV 归属校验、清单、原地更新、数据面健康探测 |
| `packages/deploy-wizard/src/cf-api.ts` | 新增 `listScriptNames` / `deleteScript` / `listWorkerDomains` / `findWorkerDomain` |
| `packages/deploy-wizard/src/cli.ts` | 新增 `worker-split` 子命令 + 完整中文帮助；`--list-kv` 同时展示两种形态 |
| `packages/deploy-wizard/src/deployer-lib.ts` | 导出 `deployWorkerSplit` 等供 GUI 复用 |
| `packages/gui/src/main/bridge.ts` | `runDeploy` 按 `deployMode` 分流；`DeployerModule` 加 Workers 签名 |
| `packages/gui/src/preload/preload.ts` | `runDeploy` 参数加 `deployMode` / `controlHostname` / `dataHostname` / `zoneId` |
| `packages/gui/src/globals.d.ts` | 同步渲染层类型 |
| `packages/gui/src/renderer/index.html` | 部署方式单选 + Workers 警示框 + 自定义域名/Zone ID 输入；「说明」页加双形态对比 |
| `packages/gui/src/renderer/renderer.ts` | `readDeployMode()` / `applyDeployMode()`，字段文案随形态切换 |
| `packages/worker-core/src/ui/panel.html` | 概览新增「部署形态」卡片，按「节点域名 ≠ 面板域名」启发式判断，并提示两种形态的更新差异 |
| `packages/worker-core/src/entry-data-self.ts` | **新增**。Workers 专用纯自研数据面入口（零 vendor） |
| `packages/worker-core/src/outbound/dial.ts` | 新增 connect 注入能力（`setConnectOverride`） |
| `packages/worker-core/scripts/build.mjs` | sockets shim / 剥离插件 + `dataplane-self.js` 产物目标 |
| `packages/deploy-wizard/test/worker-deploy.test.ts` | **新增** 9 个用例（部署顺序 / 清单隔离 / 凭据沿用 / 版本跳过 / KV 互斥 / 参数校验 / 归属判定） |

### 0.22.5 关键设计决策

1. **清单键分离**：Workers 清单写 `CFP_DEPLOY_MANIFEST_WORKERS`，
   Pages 清单仍是 `CFP_DEPLOY_MANIFEST` —— 两者互不覆盖，`--list-kv` 可同时展示。
2. **KV 互斥**：`inspectWorkerKvOwnership` 检测到 Pages 清单时**直接拒绝**
   （两种形态共用一套 KV 键会互相覆盖凭据），`--force-kv` 可强推。
3. **部署后主动探测**：上传完成后 GET 数据面 `/__diag`，
   失败就明确告警「Workers 通道已知限制」并指引改用 pages-split ——
   不让用户自己发现订阅里节点全不通。
4. **默认 Pages**：GUI 默认选中 Pages，CLI 默认子命令仍是 `pages-split`。

### 0.22.6 实测输出（主账号自定义域名，`worker-split` 全流程）

```
· 未检测到 Workers 部署，进入首次部署模式
· KV 归属校验通过：空命名空间
✅ 数据面已上传：ty9p3e99
✅ 控制面已上传：vst4xkp7y
✅ 控制面已开启 workers.dev 子域路由
✅ 数据面已开启 workers.dev 子域路由
✅ 部署凭据已写入 KV（uuid / WS 路径 / Trojan 密码已生效）
正在探测数据面可访问性（约 15 秒）…
⚠ 数据面探测未通过 —— 见告警说明（Workers 通道已知限制）
· 已记录 Workers 部署清单，下次更新会自动识别同源脚本
```

随后连续两次 `--force` 原地更新：**两次都成功，UUID / WS 路径不变，无 8000119**。

### 0.22.7 三个同类项目的源码调研结论（2026-10-24）

用户要求研究「为何 edgetunnel / cfnew / CFNext 能稳定部署 Worker，能否合并面板与数据面」。

**下载并逐行比对了三份明文源码**，结论如下：

| 项目 | 大小 | sockets 导入方式 | 部署形态 | 在 Workers 上的实测 |
|------|------|-----------------|---------|-------------------|
| **edgetunnel** | 5.0MB | **完全不 import**，用 `request.fetcher.connect()` | 单 Worker | ✅ 200（404 是因为路径） |
| **cfnew** | 37KB | `import{connect}from"cloudflare:sockets"`（静态） | 单 Worker | ✅ **200** |
| **CFNext** | 352KB | `import{connect as t}from"cloudflare:sockets"`（静态） | 单 Worker | ❌ **522** |
| **CFPilot dataplane** | 247KB | 静态 + 动态混合 | 单/双 Worker | ❌ **522** |

**关键发现**：

1. **cfnew 证明「静态 sockets 导入 + 单 Worker」本身可以在 Workers 上跑通**
   （37KB → 200），所以 522 不是「用了 sockets」或「合并了面板与数据面」造成的。
2. **CFNext 352KB → 522**，与我们的 247KB 产物同样失败。
   结合「28.5KB 纯填充 → 200」与「cfnew 37KB → 200」，
   **体积也不是原因**（37KB 与 247KB 之间有明确的临界差异，但纯填充到 28.5KB 仍正常）。
3. **edgetunnel 是唯一完全不用 `cloudflare:sockets` 的项目**，
   全部出站走 `request.fetcher.connect(options, init)` —— 这也是本次改造采用的方式。

**「能否合并面板与数据面成单 Worker」的结论**：

- 技术上**已经可以**：`dist/worker.js`（合并版，296KB）就是单 Worker 产物，
  且已完成 sockets 剥离改造（构建脚本对全部产物生效）。
- 但真机实测合并版在 Workers 上仍 522（与 dataplane 同因，见 §0.22.3）。
- 因此**当前不建议**把单 Worker 作为默认交付形态；
  Pages 双项目仍是唯一真机验证稳定的形态。
- 若将来要支持单 Worker，前置条件是解决 §0.22.3 的触发点。

**为什么 edgetunnel 稳定**：它把 `request.fetcher.connect` 包装成
`(options, init) => fetcher.connect(...)` 的连接器，自研 `TlsClient` 在裸 TCP 上做 TLS，
**整个产物里没有任何 `cloudflare:sockets` 字样**。本项目的 `setConnectOverride`
改造正是向这个形态靠拢；剩余差距在 §0.22.3 的触发点上。

### 0.22.8 「能否直接用 cfnew 的内核」调研结论（2026-10-24）

用户提议「拆 cfnew 的数据面直接用，自研暂时归档」。下载源码 + README + 变量表
逐行分析后，**结论是不可行**，原因是架构根本不同：

| 维度 | cfnew | CFPilot |
|------|-------|---------|
| 内核大小 | 37KB（压缩成 2 行） | 控制面 57KB + 数据面 248KB |
| 面板 | **外部独立网站**（cfnew.xy.kg / 自建 Vercel） | 内置在 Worker 里 |
| 内核职责 | 只做「代理转发 + 配置接口」 | 数据面 + 面板 + 订阅 + 优选池 + 探针 |
| 配置存储 | KV 的 **`c` 键**（小写），环境变量全单字母（`u`=UUID、`C`=KV 绑定名） | KV 的 **`CONFIG` 键**（大写），环境变量大写命名 |
| 协议 | VLESS-WS / Trojan-WS / VLESS-XHTTP | 同左 + SOCKS5/HTTP/HTTPS 代理池 + 反代入口 |

**具体冲突**：

1. **键名不兼容**：cfnew 读 KV `c` 键，我们读 `CONFIG`。直接混用会同时写坏两套配置
   （且 `c` 与我们的键不重叠，但适配层要完整翻译 32 个配置项）。
2. **能力缺口**：cfnew 内核**没有**面板渲染、订阅生成、优选池、探针 `/__edge_probe`、
   `/__diag` 诊断 —— 这些是 CFPilot 的核心价值，全在我们的控制面侧。
3. **它是「外部面板」模式**：把控制台剥离到 Vercel 才换来 37KB 的单 Worker。
   我们的是「内置面板」模式，两者不是同一架构。

**cfnew 能跑通的真正原因**（重要）：它**不是**因为技术更先进，而是因为
**功能被大幅裁减** —— 37KB 内核 + 外部面板。这恰好印证了 §0.22.7 的发现：
cfnew 37KB → 200，而 CFNext 352KB → 522、我们 247KB → 522，
**体积/功能密度才是关键变量**（28.5KB 纯填充 → 200，说明不是纯体积，
而是「代理相关代码密度」）。

**最终决策（用户确认，方案A）**：保持现状。Workers 通道数据面标记为暂不可用，
自研数据面**不归档**，Pages 双项目仍是唯一真机验证稳定的形态。

> 若将来要解锁 Workers 数据面，可行路径有两条（按预期工作量排序）：
> 1. **把 `outbound/*` 全部内联进单一入口文件**（完全复刻 edgetunnel 形态），
>    消除模块间静态依赖 —— 本次已确认「静态 dial 依赖」是触发条件之一；
> 2. 以 cfnew 为参考重写一个**极简数据面**（只保留三种入站 + 直连），
>    作为 `DATAPLANE=minimal` 选项，牺牲代理池/反代/诊断换 Workers 兼容性。

---

## 0.21 阶段二优化批次 + 版本统一（2026-10-23 晚）

用户一批 8 项反馈优化（提交 `68d4f47`，34 文件 +1072/-239；GUI `gui-v0.1.4` 已发布），
加版本体系统一（提交 `f7b0366`）。

### #22 节点预览恒显「CPU 预算不足，已跳过部分远程拉取」（假阳性）

**根因**：`CpuBudget` 用 `performance.now()` 墙钟近似 CPU 计时，而 `/nodes` 在两次
KV I/O **之前**就建好 8ms 预算 —— I/O 等待轻松吃穿预算，预览**恒显**不足。
**修法**：预算只计**活跃段**（`anchor` / `accumulated` / `paused` 三态，
pause/resume 包住远程 fetch），创建时机移到 KV 读之后。
`/sub` 不带 budget，真实订阅不受影响。

### #23 面板域名识别 + GUI 自动识别域名

- 面板概览原来只显示面板自己的域名 → `/status` 新增 `nodeDomain`，
  概览增加**数据面域名**行，并能识别自定义域名（`listPagesProjects` 返回
  `subdomain` + `domains` 数组）。
- GUI 本地真连接优选新增「**自动识别域名**」按钮：读 KV 清单拿 `dataProject` →
  查 Pages 项目 → **自定义域名优先**，没有则填 `<subdomain>.pages.dev` 并警告。
- 本地优选生成的命令原先显示**面板项目**域名 → 改用**数据面**域名
  （优选测试地址本就应该是数据面）。

### #24 国家筛选 + `--sample` 失效（双根因）

- **国家选择改造**：面板去掉国家 chips（省 CPU 且无意义——colo 只在扫描响应里才有）；
  优选器新增国家过滤（过滤点在 `wsOk` 之后、测速之前，筛空则忽略并提示调大采样）；
  scanner-cli 加 `--countries`；GUI 国家**多选下拉**（列表走 IPC 从 scanner 库取，
  与面板/CLI 三端同源，避免硬编码漂移）。国家表在 `packages/scanner-cli/src/countries.ts`，
  **约定：只允许在 worker-core `pools.ts` 改后同步**。
- **`--sample` 失效双根因**：① 每网段写死 `Math.max(64, ratio)` 下限；
  ② **比例分母把 IPv6 /32（2^96）算进去，IPv4 比例被稀释成 0**，只能吃 64 下限
  → `--sample 300` 实产 1400+。重写 `expandCidrs`：按地址族分别分配预算
  （混合时各拿一半）、小样本（≤1000）下限 1 / 大样本下限 64、
  **超预算时从最大计数网段依次减 1 收口** → `--sample 300` 精确得 300。
- ⚠️ 踩坑：`sample / bool ? a : b` 中 `/` 先于 `?:` 求值，`sample/true` 与
  `sample/false`(Infinity) 均 truthy → 单地址族也只拿一半预算。必须先算布尔值。

### #25 Clash 订阅名称（`CFPilot.yaml` → `CFPilot`）

客户端导入订阅后自动填的名称取自 `Content-Disposition` 的 filename。
**修复**：`sanitizeSubName` 去引号/反斜杠/换行、限长 64、**不带扩展名** →
线上实测 `Content-Disposition: inline; filename="CFPilot"`，`Profile-Title` 同步。
面板新增订阅名称修改框（`cfgSubName`）。

### #26 端口乘法语义

- 每个**自动池**条目按 `subPorts`（面板多选）各生成一份节点；
- **手动池**显式非 443 端口豁免（`portsForEntry`）；
- 多端口 label 加 `:端口` 后缀。
- GUI 去掉端口选择、**固定 443**（2053 等端口部分网络被阻断，给用户选只引入不确定性）。

### 其它小优化

- logo 字符 `CF Pilot` → `CP`（面板 + GUI）；
- GUI 域名填写框提示：「建议使用自定义域名，避免 pages.dev 生产链接阻断」；
- README（根 + gui）补免责声明（仅作学习交流；方法来自互联网；违法问题概不负责）。

### 版本体系统一（`f7b0366`）

见 §0.3。实施踩坑：第一版 sync 脚本曾把 `worker-core/src/version.ts`
（构建注入的 `BUILD_VERSION` / `VERSION_PATH` / `versionResponse()`，被 entry 引用）
误覆盖成两行 stub —— 已 git 恢复，并加**白名单 + 文件头标记注释**双保险：
只生成 scanner-cli / deploy-wizard 的 `version.ts`，无标记的手写文件一律跳过。

---

## 0.20 自研数据面：真机实验结论与新架构（2026-10-23）

用户提出：重新尝试全自研数据面（参考 edgetunnel / BPB-Worker-Panel / CFNext），
并指出「旧代码陷入开发死循环、永远无法部署还找不出原因」。
**结论：死循环有确定的技术根因，且归档文档给出的归因是错的。**
完整设计见 [docs/self-developed-dataplane-design.md](docs/self-developed-dataplane-design.md)。

### 0.20.1 ⚠️ 更正：「静态 import sockets 会导致 1101」是错的

归档文档与 `src/outbound/dial.ts` 的注释都写着「静态导入 `cloudflare:sockets`
会让 isolate 在启动阶段失败（1101）」。**2026-10-23 真机复验（同一账号）**：

| 脚本 | 内容 | 部署 | 运行时 |
|------|------|------|--------|
| A | 静态 import sockets，**从不调用** | ✅ success | `A-ok` |
| B | 动态 import sockets，从不调用 | ✅ success | `B-ok` |
| C | 静态 import + **真的调用 connect()** | ✅ success | `proxy request failed...` |

**静态导入完全正常。** 失败发生在**运行时出站**。

### 0.20.2 出站可达性矩阵（同一 Worker 实例内对照，可复现）

```
8.8.8.8:53          → OK        8.8.8.8:443        → OK
9.9.9.9:443         → OK        208.67.222.222:443 → OK
1.1.1.1:443         → BLOCKED   cloudflare.com:443  → BLOCKED
104.16.0.1:443      → BLOCKED
```

**被拒的恰好是 Cloudflare 自家的 Anycast 地址**：Worker 不能主动连回 Cloudflare
自己的入口（会构成环路），Cloudflare 侧直接拒绝并报 `TCP Loop detected`。
**第三方 IP 的 443 完全可用。**
`request.fetcher.connect`（edgetunnel 用的）**不能**绕过此限制，错误信息与 sockets 一致。

### 0.20.3 旧代码死循环的根因（三个缺陷叠加）

```
1) 缺陷 A：同区域过滤写成 p.kind === 'direct' → 把 SOCKS5 / HTTP 代理全滤掉
2) 缺陷 B：优选 IP 库装的是硬编码 CF 网段（104.16.0.0/12 等）→ 候选必然被拒
3) 缺陷 C：tryDial 的 catch 把异常吞掉、只返回 null
   → 每一层失败都表现为「目标不可达」，日志里没有任何线索
```

**所以「永远无法部署还找不出原因」的真相**：失败发生在出站选路，异常被吞，
看起来像随机失败 → 反复重试 → 永远不成。
（对照：CFNext 的优选库用的是**域名**解析出的 IP，未必落在 CF Anycast 段。）

### 0.20.4 三个成熟项目的可借鉴点

| 项目 | 值得借鉴 |
|------|---------|
| **edgetunnel** | 完全不用 `cloudflare:sockets`（实测 0 次引用）；`request.fetcher.connect` 抽象成连接器；自研 `TlsClient` 在裸 TCP 上做 TLS；出站 = 连 `cloudflare.com:443` 探测 → 经 SOCKS5/HTTP 代理 → `CONNECT` 隧道；特征码字典混淆 |
| **BPB-Worker-Panel** | 先回 VLESS/Trojan 协议响应头再中继（避免客户端误判首包）；面板与订阅一体化；代理池配置面；XHTTP/gRPC |
| **CFNext**（当前 vendor） | 出站三级候选顺序：`m()` 直连目标 → `h()` 同区域优选 IP 竞速 → `g()` 走 outboundProxy；`Ct(ip,4000)` 拨号语义；`Ft()` DoH 解析优选 IP；`lt(env)` 三层配置加载器 |

**三者共同的架构事实**：出站要么直连**第三方** IP，要么经外部代理隧道；
**不能指望 Worker 直连 Cloudflare 自家 Anycast**。

### 0.20.5 8000119 与滥用邮件（结合用户补充的事实）

用户补充：**邮件从第一次测试部署就收到、几十封一模一样；只要部署被检测到可疑就会有；账号本身很健康。**

实测与之一致：完全中性内容（`return new Response("ok")`）连续部署 10 次 →
**成功 9 次、泛化错误 1 次**；明文 `vless`/`trojan`/`proxy` 特征串 vs 拆分混淆版本
→ **结果相同（都成功）**。

**因此**：
- 邮件 = **每一次部署被判定为可疑**就触发一次，不是「部署次数过多」的账号处罚；
- 「几十封一模一样」= 几十次部署各自命中判定；
- 部署受理的成败**与产物内容无稳定因果**。
- edgetunnel / CFNext 的「特征码字典混淆」在**部署受理**层面无实测收益；
  它更可能服务于运行时流量特征层，两者不应混谈。

**应对**：新项目失败时**先原样重试、再换名**（§0.19.4 已实施）；
已承载流量的项目原地重部署无效，必须新建项目（见 §0.5 第 5 条与晚间实测）。

### 0.20.6 实施路线（阶段 1–6 全部完成）

| 阶段 | 内容 | 闸门 | 状态 |
|------|------|------|------|
| 1 | 归档代码复用到 `src/outbound/`，修正选路算法 | 本地单测全绿 | ✅ |
| 2 | 出站选路重写 + **分级错误诊断** | 单测覆盖候选顺序 | ✅ |
| 3 | **真机验证直连第三方 IP 的代理链路** | VLESS 握手返回 `[0,0]` 且能取回真实 HTTP 响应 | ✅ **已过**（§0.20.9） |
| 4 | 优选 IP 库接入（DoH 解析**第三方域名**） | 优选链路真机可用 | ✅ 代码完成；**TXT 优选库路径待特定域名验证** |
| 5 | 代理池落地（SOCKS5 / HTTP CONNECT / HTTPS） | 经代理真机可用 | ✅ **已真机验证 3/3**（§0.20.13） |
| 6 | 特性开关：自研 / vendor 可切换 | 两种实现都能部署与工作 | ✅ 自研为默认（§0.20.10） |

> ⚠️ 阶段 3 的验证方法要注意：应连**明文 HTTP 目标站**或用**会自己完成 TLS 的客户端**。
> 用明文 HTTP 去请求 HTTPS 站拿不到响应，那是验证方法问题，不是实现缺 TLS（详见 §0.20.8）。

### 0.20.7 多实例并存

支持，且是推荐用法：每个实例一个独立 KV；自研数据面不改变这个约束
（CLI `--new-kv` / `--list-kv` / `--kv <id>`；GUI 凭据页 KV 下拉 + 新建按钮）。

### 0.20.8 第二阶段：DoH 优选库 / 代理池 / HTTPS 代理（已实施）

#### ⚠️ 先更正一条误判：「补 TLS 能力」不是主出站路径的必需项

早期实施路线把「补 TLS 能力」排第 1 位。**该判断有误**，复核三方**源码**（非 README）后更正：

| 项目 | 直连目标 | 优选 IP | SOCKS5 | HTTP 代理 | HTTPS 代理 |
|------|---------|--------|--------|----------|-----------|
| CFNext（vendor） | 纯 TCP | 纯 TCP | — | — | 不支持 |
| edgetunnel | 纯 TCP | 纯 TCP | 纯 TCP | 纯 TCP | `secureTransport:'on'` + 自研 `TlsClient` |
| BPB | 纯 TCP | 纯 TCP | — | — | — |

源码证据：**CFNext** `Pt()` 内只有 `connect({hostname, port})`，全文件搜不到
`secureTransport` / `startTls` / `TlsClient`；**edgetunnel** 的
`secureTransport:'on'` 与 `TlsClient` **只**出现在 `httpsConnect()` 与 `sstpConnect()`。

**原因（协议本质）**：VLESS / Trojan over WebSocket 是 **TLS 透传代理**，TLS 有两层不能混淆 ——
第一层「客户端 → CF 边缘」由客户端发起、CF 边缘终结；
第二层「Worker → 目标站」**Worker 不终结 TLS**，只透传客户端发来的密文。
若 Worker 自己终结 TLS，会破坏端到端语义（证书校验 / SNI / 指纹全部错位）。

**结论**：`secureTransport` 的唯一正确用途是「**代理服务器本身是 HTTPS/SSTP**」——
这正是 vendor 缺失、edgetunnel 具备的能力，本阶段已补上。

#### 本阶段实施内容

| 项 | 文件 | 说明 |
|----|------|------|
| DoH 优选库 | `src/outbound/doh.ts`（新增） | TXT 优选库 → A → AAAA，5 分钟缓存；机制对齐 vendor `Ft()` |
| 候选分组 | `src/outbound/route.ts` | 新增 `groupCandidates()`：代理 / 直连 / 降权三组 |
| 代理落地 | `src/outbound/dial.ts` | SOCKS5 / HTTP / HTTPS 全部进选路；`secureTransport` 支持 |
| HTTPS 代理 | `src/outbound/proxy-pool.ts` | 新增 `https` 类型（`https://` 前缀） |
| 代理认证 | `src/outbound/http-proxy.ts` | 补 `Proxy-Authorization`（此前**解析了凭据却没发出去**） |
| 配置项 | `config.ts` / `types.ts` / `panel.html` | `resolvePreferred` + `RESOLVE_PREFERRED` + 面板开关 |
| CLI | `deploy-wizard` | `--resolve-preferred=false` |

#### 三个值得记住的实现要点

1. **代理与直连必须互斥**：同池竞速会让直连先成功而**静默绕过代理** ——
   出口 IP 与用户预期不符且无任何报错。现语义对齐 edgetunnel：有代理只走代理，代理全失败抛错。
2. **DoH 优选库必须整体判定**：目标域名的 TXT 绝大多数不是优选库
   （实测 `example.com` 是 `"v=spf1 - all"`、`www.cloudflare.com` 是域名验证记录）。
   若「挑出形似 IP 的片段」，SPF 里的 `ip4:1.2.3.4` 会被误当优选 IP，
   **所有出站被悄悄导向该 IP 且无任何报错**。现要求整条记录全是 IP 才认。
3. **候选排序必须稳定**：`Array.prototype.sort` 对长度 > 10 的数组用非稳定 TimSort，
   会让竞速时「谁先试」随机、排查无法复现。现改为「权重 + 原始下标」稳定排序。

### 0.20.9 真机验证：自研数据面出站链路**已跑通**（阶段 3 闸门通过）

#### 验证手段：本地 workerd + 真实 Pages 双层

关键前提：**本地 `wrangler dev --local`（workerd）完整支持 `cloudflare:sockets`**
（实测：导入 / connect / 真实数据交换全部成功），
因此可以在不出云的情况下把整条出站链路验完 —— 比反复撞真机边缘窗口高效得多。

配套工具已固化为 **`packages/worker-core/scripts/selfdp-e2e/`**（含 README），
npm script：`e2e:echo` / `e2e:dev` / `e2e:test`（预期 7/7）。

#### 结果

| 层 | 场景 | 结果 |
|----|------|------|
| 本地 workerd | 基本链路 | ✅ VLESS `[0,0]` + 真实响应 446B |
| 本地 workerd | **1MB 负载逐字节完整** | ✅ 1048576 / 1048576 字节无差错 |
| 本地 workerd | 错误 UUID 被拒 | ✅ 无响应头、无数据 |
| 本地 workerd | 不可达目标分级诊断 | ✅ close 1011 + 逐候选原因 + 修复建议 |
| 本地 workerd | **SOCKS5 代理路径** | ✅ 代理日志证实请求/响应全部经由代理 |
| **真机 Pages** | `neverssl.com:80`（非 CF 网段） | ✅ **upgrade 8/8、VLESS `[0,0]` 8/8、真实 HTTP 响应 6/8** |
| 真机 Pages | `example.com:80`（全 CF 网段） | VLESS `[0,0]` 4/4，出站必然失败（符合预期） |

#### ⚠️ 验证中发现并修复的两个**真实缺陷**

1. **协议响应头必须在出站建连之前回**：原实现「先 await 出站成功再回响应头」→
   workerd 报 `Workers runtime canceled this request because it detected that your Worker's code had hung`。
   已修：认证通过即回响应头，出站转后台，失败用 close 1011 + 分级原因告知
   （认证在 `parseTarget` 内已完成，回响应头不引入安全漏洞）。
2. **目标域名解析到 CF 网段时，域名直连必须降权**：实测
   `example.com` → 172.66.147.243 / 104.20.23.154（全 CF 网段 → 出站 100% 失败），
   `neverssl.com` → 34.223.124.45（第三方 IP → 成功）。
   把域名丢给 `connect()` 让运行时自己解析必然连回 CF Anycast 被拒，且直连候选原本排最前
   会白耗一次超时。已修：`RouteInput` 新增 `deprioritizeDirect`，解析结果全为 CF 网段时降权。

#### 两个测试坑（写给后续维护者）

1. **workerd 的文本帧（opcode 1）不会进入服务端二进制分支** —— 必须发二进制帧（opcode 2）。
2. **VLESS 地址字段的长度字节不能被域名首字符覆盖** —— 布局是 `[类型(1)] + [长度(1)] + [域名]`；
   写成 `[类型] + 域名` 会让域名首字符（如 `'1'` = 0x31）当成长度，解析全错。

#### ⚠️ 令牌探测的坑（避免误判）

`cfat_` 前缀是 **account-owned token**，**不支持** `/user/tokens/verify` 端点，
对该端点调用恒返回 401「Invalid API Token」。**这不代表令牌失效** ——
判断有效性要用 `GET /accounts`。

#### 仍未验证

- DoH 的「TXT 优选库」路径需特定域名才能验（普通域名的 TXT 是 SPF / 域名验证记录）。
- （代理池三类已于 §0.20.13 全部真机验证通过。）

### 0.20.10 vendor vs self 对照实验 → **自研成为默认数据面**

#### ⚠️ 用户环境提示：Clash Verge 的 TUN 模式

TUN 开启会带来两个干扰：① **Node 的 `fetch` 在 TUN 下 `fetch failed`** ——
部署向导写 KV 连续失败 → 数据面 KV 无 `CONFIG` 键 → **WS 路径 404**
（curl 写同一个 KV 却成功 → 是 TUN 与 undici 的兼容性问题，**不是代码 bug**）；
② 本机出站被全面限速，**本机不是有效的出站测试基准** ——
有效基准是「Cloudflare 边缘 → 目标站」，即真机数据面。

#### 对照实验设计

同一账号、同时段、同一客户端、同一目标；两个实例各自独立 KV；**交替采样**（A→B→A→B）。
真实 TLS 客户端首包用手工构造的合法 ClientHello（`selfdp-e2e/clienthello.mjs`）——
手写简化版会被目标站直接 RST，测不出真实差异。

#### 关键发现：vendor 靠「第三方反代入口」打通 CF 网段目标

第一次对照：**vendor 100% vs self 0%**（CF 网段目标）。根因是 vendor 内置
`proxyip.{hk,us,jp,...}.cmliussss.net`，CNAME 到**动态轮换的 IP 池**。
反代入口是第三方服务器，收到客户端 TLS ClientHello 后**按 SNI 转发**到目标：

```
Worker ──connect(反代IP:443)──> 第三方反代（按 SNI 转发）──> Cloudflare 边缘
```

出口是第三方 VPS 而非 Cloudflare 自己的边缘 → **不触发 TCP Loop 限制**。
自研原先只有「DoH 解析 + CF 网段降权」，缺这一层 → CF 网段目标必然失败。

#### 补齐：新增 `src/outbound/relay.ts`

同一机制但**可配置、可关闭**（vendor 只能硬编码依赖第三方）：
面板可填自己的反代入口（`relayPool`）→ **完全不依赖第三方**；
`USE_BUILTIN_RELAY=false` 关内置表；**按当前边缘机房（colo）优先选地区**；
**缓存 30 秒**（不是 5 分钟 —— 动态轮换池，长缓存会拿到已失效的 IP）。

#### 优化迭代（实测数据驱动）

| 改动 | CF 网段目标成功率 |
|------|------------------|
| 无反代入口 | **0%** |
| 全量并发（53 个候选） | 70% |
| 限到 8 个 | 40%（备选太少） |
| 分批（每批 8，批间串行） | 33%（串行等待耗尽客户端预算） |
| 每域名 4 个 + 短缓存 + colo 优先 + 轮转 | **67% → 100%** |

结论：**候选要多、地区要分散、缓存要短**。

#### 最终结果与决策

| 目标 | vendor | self |
|------|--------|------|
| 非 CF 网段 `github.com:443` | 100% | **100%** |
| 全 CF 网段 `example.com:443` | 73% / 80% | **67% / 100%** |

vendor 自身在 73%~100% 间波动（第三方池不稳定），self 已持平甚至更好。
→ `resolveDataPlaneImpl()` 缺省改 `self`；`DATAPLANE=vendor` 保留回退；
GUI 新增「数据面实现」下拉框（默认自研）。

自研独有能力：失败分级诊断、SOCKS5/HTTP/HTTPS 代理池、DoH 优选解析、
反代入口可配置、降权候选稳定排序。

### 0.20.11 代理路径 + 自配反代入口真机验证

用户要求「把这两项验掉」——即代理池真机与自配反代入口端到端。

#### 一、自配反代入口：端到端路径已通 ✅

完全走**用户真实操作路径**（面板 API → KV → 数据面）：

```
PUT /api/v1/config {relayPool:"45.192.247.177", useBuiltinRelay:false}
  → KV CONFIG 确认写入
  → 数据面出站 → example.com:443（全 CF 网段，直连必然失败）
  → 4/4 成功
```

**内置表关闭 + 只配自营入口仍成功** → 证明生效的是「用户自配」这条来源。

> 面板 API 的路径是**根路径** `/api/v1/config`（不是面板路径前缀），
> cookie 名是 `cfpilot_sess`（见 `auth.ts` 的 `SESSION_COOKIE`）。

#### 二、代理路径

| 类型 | 结果 |
|------|------|
| **SOCKS5**（代理池 3 个） | ✅ **10/10**，每次收到 httpbin 真实响应 499 字节 |
| **HTTPS 代理**（池 3 个） | ✅ **5/10**，成功时收到真实响应（完整打通见 §0.20.13） |
| HTTP CONNECT（明文） | 组合已被上面两项覆盖（TCP 层 = SOCKS5 路径，握手层 = HTTPS 路径，同一份 `httpConnect()`）。公共明文 HTTP 代理几乎都不支持 CONNECT 隧道（实测 190+ 个全失败） |

**关键观察**：单代理 1/8，代理池 10/10 ——
**代理池竞速把单个不稳定代理的问题掩盖了**。这是自研独有能力（vendor 只读 `PROXYIP`）。

#### 三、真机发现的三个真实缺陷（本地测不出来）

| 缺陷 | 症状 | 修复 |
|------|------|------|
| 代理握手**无超时** | 代理连上但不回应 → 数据面**既不报错也不关闭**，静默挂起 45s+ | `socks5.ts` / `http-proxy.ts` 握手读取加 6s 超时 |
| **close reason 超 123 字节** | RFC 6455 限制；超长时 **Cloudflare 边缘静默丢弃整个 close frame** → 客户端一直连着。本地 workerd 宽容地照发，只有真机暴露 | `closeWith()` 统一截断到 123 字节（按**字节**算；省略号占 3 字节，追加后还要再检查一次） |
| 完整诊断**没有出口** | close reason 装不下多行诊断 | 新增数据面诊断端点 `GET /__diag`（自研专有），返回最近 20 条完整诊断 |

> ⚠️ 截断修复第一遍漏了「追加省略号后再检查」→ 仍超 1 字节 → 真机依旧不 close。
> **这类坑只有真机能暴露**，本地 workerd 全部通过。

#### 四、Cloudflare 平台的两个硬限制（实测）

1. **边缘拒绝把 CONNECT 方法转发给 Worker**（400，`CF-RAY: -` 表示没到 Worker）。
   → 标准 HTTP CONNECT 代理**无法用 Cloudflare Worker 搭**；Worker 又不能当 TCP 服务端。
   → 可行替代是 **POST + 二进制 body** 承载隧道。本项目**未**引入
   （语义是请求-响应而非持续隧道，不适合作为生产特性）。
2. **本机 `workers.dev` 不通**（`pages.dev` 正常）→ 测试一律用 Pages。

### 0.20.12 用户实测反馈的三个问题（全部已修）

#### 问题 1：默认下发 30 个节点，订阅里却有 90 个

**根因**：`subProtocol`（vless/trojan/both）× `subTransport`（ws/xhttp/both）
两个独立开关交叉 → 必然三种形态 → 节点数乘三。
**修复**：新增 `subVariants`（多选），面板三个复选框，默认只勾 `vless-ws`。
`resolveSubVariants()`：依赖入站没启用 → 自动剔除；Clash/sing-box 不支持 XHTTP →
这些格式跳过 XHTTP 形态；全被剔除 → 回落 `vless-ws`。实测：默认 30 条，勾三种 → 90 条。

#### 问题 2：XHTTP 与 Trojan 延迟全 -1

**Trojan 服务端实现正确** —— 真机真实 Trojan 握手收到目标站完整 HTTP 响应（458 字节）。

**XHTTP 两个真机才暴露的 bug**：
1. **`relay()` 关闭了 socket 写流** → 等于关闭整个 TCP 连接，目标站收到 RST
   来不及回数据（症状：握手成功但永远收不到数据）。
   修复：`relay()` 加 `closeTarget` 参数，socket 场景传 `false`。
2. **`async start` 阻塞下行读取** → `start` 的 Promise 未完成时 `pull` 不被调用。
   修复：`start` 只入队响应头立即返回，下行放到 `pull` 里读。

附带：XHTTP 的 `dial()` 漏了 `resolvePreferred` / `relayPool`，已与 WS 路径对齐。

#### 问题 3：vless+WS 一开始可用，后来全失效

**根因**：数据面因 `8000119` 换名重建后，控制面 `DATA_HOST` 仍指向**已删除的旧域名**
→ 订阅所有节点的 `sni`/`host` 都指向不存在的域名。
**修复**：部署向导在数据面部署完成后比对控制面 `DATA_HOST`，不一致就重新配置控制面
（环境变量可随时改，无需重新部署）。真机已被触发验证两次。

#### 顺带：官方优选 IP 池质量修正

`curl --resolve` 逐段实测（WS 升级是否返回 101）：
`104.16–104.25` 8/8 ✅、`104.26` 2/8、`104.27` 6/8、`104.28+` 0/8 ❌、
`172.66/67` 6/8、`172.64/65/68+` 0/8 ❌、其余 13 个段 0/8 ❌。
旧表 15 个段里 13 个完全不可用（随机采样命中率约 1/4）→ 订阅大半节点是坏的。
修复：`CF_IPV4_CIDRS` 换成实测可用的 3 段；`CURATED_OFFICIAL_IPS` 10 → 27 个。

> ⚠️ 可用段与具体站点有关（CF 按站点分配），但 `104.16.0.0/11` 是主力通用段。
> 想完全对齐自己的站点，用面板「本地真连接优选」实测筛一遍最准。

#### ⚠️ 本轮踩到的两个测试方法坑

1. **自制 WS 客户端会被 Cloudflare 边缘拒绝**（原始 TCP + 手写握手 → 400），
   而 `ws` 库能过。**用 `curl --resolve` 或 `ws` 库**测 IP 可用性才准 ——
   我一度用自制客户端测出「所有 IP 都不可用」的假结论。
2. **每次部署后数据面域名都会变**（8000119 换名），测试脚本必须用**当前**域名 ——
   我有一轮测试全打在已删除的旧项目上，得出了「XHTTP 修不好」的错误结论。

### 0.20.13 HTTPS 代理路径打通 + 一个被推翻的根因

#### 🔴 先说被推翻的结论

上一轮判定「HTTPS 代理失败是因为**自签证书不被 Cloudflare 信任**」。**这个判断是错的**：

| 层 | 当时的判断 | 实测结论 |
|----|-----------|---------|
| ① TLS 没生效 | 「`secureTransport:'on'` 是惰性 TLS」 | ❌ **错** —— `secureTransport` 压根没传到运行时 |
| ② 证书不被信任 | 「自签证书被 CF 拒绝」 | ❌ **部分错** —— 自签确实被拒，但**主因是别处** |
| ③ 真正根因 | — | ✅ **`connect(address, options)` 的 options 放错了参数位** |

确切机制（`@cloudflare/workers-types` 的声明）：

```ts
function _connect(address: string | SocketAddress, options?: SocketOptions): Socket;
interface SocketOptions { secureTransport?: string; allowHalfOpen: boolean; }
interface SocketAddress { hostname: string; port: number; }
```

旧代码把 `secureTransport` 塞进了**第一个**参数 → TypeScript 不报错（多余字段被放过），
**运行时静默忽略** → socket 实际是明文 → 对端 TLS 服务器看到明文报
`HTTPS_PROXY_REQUEST`。正确写法是第二个参数：

```ts
connect({ hostname, port, secureTransport })   // ❌ 旧代码
connect({ hostname, port }, { secureTransport }) // ✅ 正确
```

**定位手法（值得复用）**：`socket.secureTransport` 是只读 getter，
返回 `"off" | "on" | "starttls"`。打印它就能立刻确认选项有没有真的生效 ——
比从报错文案反推快得多。

#### 修正后的真机结论（Cloudflare 边缘）

| 模式 | 结果 |
|------|------|
| `secureTransport:'on'`（options 放对） | `socket.opened` 直接 reject：「proxy request failed, cannot connect to the specified address」 |
| `secureTransport:'starttls'` + `startTls()` | **进入 TLS 握手阶段**（能拿到具体的握手错误） |
| `starttls` + 自签证书 | 服务端收到 `remote error: tls: unknown certificate authority` |
| `starttls` + 用 IP 连接（证书签给域名） | 服务端收到 `remote error: tls: bad certificate` |
| `starttls` + **域名连接 + SNI 匹配 + 公信 CA 证书** | ✅ **握手成功，CONNECT 隧道建立** |

**结论：`'on'` 与 `'starttls'` 都会校验证书**（workerd 的 TLS 能力只有
`TlsOptions = { expectedServerHostname?: string }`，**无法指定自有 CA**）。
两者区别只在失败时机。所以生产实现选 `'starttls'`。
⚠️ `startTls()` 返回**新** socket，原 socket 已被关闭 —— 必须换用新 socket 的流。

#### 代码改动

1. **`outbound/dial.ts`**：`ConnectFn` 改 `(address, options?)`；
   `connectWithTimeout()` 把 `secureTransport` 放进第二个参数；
   `startTls()` 支持 `expectedServerHostname`；`starttls` 分支错误信息细化为「TLS 握手超时」；
   catch 分支关闭**升级后**的 socket。
2. **`outbound/proxy-pool.ts`**：`ProxyEndpoint` 加 `serverName`；`https://` 条目域名 host
   自动作 SNI；支持 `#sni=example.com` 后缀；IP 形式**不**推导 SNI。
3. **`outbound/route.ts`**：`via` 透传 `serverName`。
4. **面板**：HTTP 代理输入框提示补充 `https://` 与 `#sni=` 用法。
5. **测试**：新增 `test/proxy-sni.test.ts`（7 个用例）。

#### 真机验证结果（3/3 全绿）

阿里云 `47.104.173.139` 上分别跑 SOCKS5 / HTTP CONNECT / HTTPS(TLS) 三个代理，
经真实 Pages 数据面 + 真实 VLESS 会话：`socks5 3/3 ✅  http 3/3 ✅  https 3/3 ✅`。
代理端日志佐证（确实经代理，不是静默直连）：
`[#11] TLS 握手完成 from 104.28.157.104（SNI="exammaster.zzzjl.com"）` +
`CONNECT httpbin.org:80 隧道已建立`。

#### ⚠️ 测试环境上踩的三个坑（都不是代码缺陷）

1. **CentOS 7 的 OpenSSL 1.0.2k 不支持 TLS 1.3** —— 而 CF 边缘的 `startTls()`
   **只发 TLS 1.3 ClientHello**。症状很隐蔽：Python `ssl` 当服务端时握手**永远挂起**
   （63 条 ESTABLISHED 堆积、Recv-Q 有数据但服务端不读），**不是**明确的报错。
   → 换 Go 静态编译代理（`CGO_ENABLED=0 GOOS=linux go build`）才通。
   → 以后在旧系统上验 TLS，先查 `openssl version`。
2. **本地 workerd 拒绝连私有 IP**（`127.0.0.1` / `192.168.x`），错误文案与真机的
   「CF 网段被拒」**完全一样**，极易误判。→ 验出站用**公网 IP** 目标或直接上真机。
3. **Pages 部署 `_worker.js` 的 metadata 不能带 `compatibility_date`** ——
   带了就让 Pages 忽略 `_worker.js`（部署成功、HTTP 200、返回默认 Welcome 页）。
   正确格式只有 `{ main_module: '_worker.js', bindings: {} }`。
   另：Pages 绑定与变量**只对之后的部署生效**，顺序必须是
   「建项目 → PATCH 设变量 → 部署」；PATCH 会自动触发一次部署，
   之后再 POST `/deployments` 就是二次部署 → 触发 `8000119`。

#### 阿里云服务器清理（用户要求「不破坏网站项目」）

已全部还原并验证：测试进程 3→0；监听端口 4→0；`/tmp/cfp-test/` 已删；
firewalld 临时端口放行已移除、CF 网段 rich rules 45→0；临时 Docker 镜像已删。
未受影响：`/www/wwwroot/` 5 个站点 HTTP 全部正常、`exammaster.zzzjl.com` HTTPS 200、
nginx/mysqld/docker 均 active、5 个容器全部存活。

---

## 0.19 订阅格式识别、ECH 与真机复验（2026-10-23）

### 0.19.1 Clash Verge 导入失败的根因：**订阅格式只看 URL 参数，不看 User-Agent**

用户反馈：「Clash Verge 导入失败，但浏览器可以直接读到 YAML 文本」。

**根因**：订阅路由只认 `?target=` / `?format=` 查询参数，**完全不看 `User-Agent`**。
而客户端导入订阅时**只给订阅 URL，不会加 `?target=clash`**，是靠自己的 UA 表明身份的：

| 客户端 | User-Agent | 期望格式 |
|--------|-----------|---------|
| Clash Verge / Clash / mihomo | `clash-verge/…` | YAML |
| sing-box | `sing-box/…` | JSON |
| v2rayN / Shadowrocket / NekoBox | `v2rayNG/…` 等 | Base64 |

于是 Clash Verge 拿到的是 **Base64 分享链接集合**，按 YAML 解析必然失败。

**已修**：新增 `resolveFormatByUserAgent()`（`routes/shared.ts`），
优先级改为 **URL 显式参数 > User-Agent > 默认 base64**；识别不出返回 null（不猜）。
真机复验：`clash-verge/v1.6.6` → `text/yaml` ✅；`Mozilla/5.0` / `v2rayNG/1.8.5` → Base64 ✅。

### 0.19.2 Clash YAML 模板的兼容性问题（已修）

原模板语法合法、字段齐全（PyYAML + mihomo schema 校验通过），但三处让 Clash Verge 别扭：
1. `external-controller: 127.0.0.1:9090` —— 客户端自己会管理，写死会端口冲突 → **移除**；
2. `port`/`socks-port` —— mihomo 只认 `mixed-port` → 改为只写 `mixed-port`；
3. 无 `dns` 段 —— ECH 需要 DoH → 补 `dns`（fake-ip + DoH + fallback）。
另补 `unified-delay` / `tcp-concurrent`。
真机复验：60 节点全部合规、0 引用错误、名称 60/60 唯一。

### 0.19.3 ECH 特性（新增，默认关闭）

参考 edgetunnel 的做法实现。**ECH 是客户端侧能力**：内核只负责把参数写进订阅。

| 配置 | 环境变量 | 默认 |
|------|---------|------|
| `ech` | `ECH` | `false` |
| `echHost` | `ECH_HOST` | `cloudflare-ech.com` |
| `echDns` | `ECH_DNS` | 空 |

三种订阅格式输出：Clash YAML 节点加 `ech-opts` + `dns.nameserver-policy`；
Base64 链接加 `&ech=<SNI>+<DoH>`；Sing-box 加 `tls.ech`。
真机复验：关闭时 0 处；开启后 60 节点全带 `ech-opts`、90 条链接全带 `ech=`。

### 0.19.4 8000119 归因的两次更正（先推翻「内容决定」，再补「流量项目持久性」）

§0.9 / §0.10 曾把 `8000119 blocked` 归因为「把数据面也打进包里 → 判为代理服务」。
**2026-10-23 白天真机复验推翻**（同一账号、同一 KV、同一产物反复部署到新建项目）：

| 配置 | 结果 |
|------|------|
| 最小脚本 + 无 KV 无 env | ✅ success |
| 数据面产物 + 无 KV 无 env | ✅ success |
| 数据面产物 + **双 KV 绑定**（`KV` + `K`） | ❌ 一次 timeout、一次 `8000119` |
| 数据面产物 + **仅 `KV` 绑定** | ✅ success |
| **完全相同的双 KV 绑定配置，连续 6 次** | ✅ **6/6 全部成功** |
| **最初失败的那个项目，原样重试** | ✅ **成功** |

**结论（白天）**：失败与「内容是不是代理」「有没有 KV 绑定」都不构成稳定因果；
`8000119` 是**账号级、间歇性的风控判定**。向导的 `deployWithBlockRetry`
因此改为**先原样重试同一项目 3 次、再换名**。

> ⚠️ **2026-10-23 晚间补充（重要，纠正上述结论的适用范围）**：
> 对**已承载真实代理流量的数据面项目**，原地重部署是**持久性拒绝**
> （实测 4/4 全部 `8000119`，换备用名也失败）；而控制面不碰代理流量，
> 原地重部署无限制（当天 13 次全成）。
> **因此数据面每次更新必须：新建项目 → 切控制面 `DATA_HOST` → 重发控制面**
> （向导已自动化，见 §0.20.12 问题 3）。「间歇性、原样重试即可」只对**新项目**成立。
> 触发条件仍未完全确定，**不要臆测规则**；要查就做「固定账号、固定配置、重复 N 次」的统计。

### 0.19.5 真机复验清单（2026-10-23 白天）

账号 `70ec011b12cd621609a8412a4d0c1668`：`--list-kv` 正确识别 `cfnext` 为非 CFPilot 实例；
`--new-kv` 全新部署成功（数据面首次超时、原样重试成功）；
`--mode update` 复用实例 UUID/WS 路径不变；KV 键检查大写 `CONFIG` 有值、
小写 `config` 不存在；UA 识别 / Clash YAML / ECH 开关全部符合预期；
完整 VLESS 握手响应头 `[0,0]`（UUID 认证通过）。清理：8 个对照项目全删。

---

## 0.18 KV 实例隔离与数据面产物的实证（2026-10-22 晚）

本节是对旧版若干过时描述的更正，每条都有代码/产物层面的证据。
设计文档见 [docs/kv-instance-isolation.md](docs/kv-instance-isolation.md)。

### 0.18.1 数据面产物到底是什么

**数据面产物是 `dist/dataplane.js`（`src/entry-data.ts` 构建），内含 vendor 的 `wsHandler`。
不是「CFNext 原版文件、不二次打包」。** 证据：
`build.mjs` 的 `TARGETS` 含 `{ entry: 'src/entry-data.ts', out: 'dataplane.js' }`；
`packages/deploy-wizard/assets/` 在 git 全历史里**只有** `cfpilot-worker.js`；
产物里含 vendor 特征串（`WebSocketPair` / `preferredIPs` / `CFNext`）。

### 0.18.2 vendor `wsHandler` 的真实签名与行为

对 `vendor/cfnext-dataplane.js` 做精确的花括号配平解析（跳过字符串/模板/注释）后确认：
导出的 `Gt` 签名是 **`Gt(request, config)`**，只吃传进来的 `config`
（`e.uuid` / `e.trojanPassword` / `e.enableTrojan`）—— **不读 KV 也不读 env**。
CFNext 自己的配置加载器 `lt(env)` 只被 vendor 内部默认 fetch 处理器调用，
而本项目只 import `wsHandler` → `lt` 被 esbuild tree-shaking 整个移除。
**因此：数据面走的是 CFPilot 自己的 `loadConfig()`，读 KV 的大写 `CONFIG` 键。**

### 0.18.3 两个由此暴露的真实缺陷（已修）

1. **向导写错了键**：旧 `syncDataPlaneKvConfig()` 往小写 `config` 键写 CFNext schema ——
   数据面根本不读它，更糟的是会**整体覆盖**共栖的 CFNext 项目的配置。
   → 已删除该函数，改为写大写 `CONFIG` 键。
2. **内核的环境变量层有缺口**（违反铁律 1）：`configFromEnv()` 原本只读 `env.UUID`，
   `wsPath` 写死 `/vless` 等 → 向导注入的数据面环境变量全是死的。
   → 已补齐 `WS_PATH`/`PATH`、`TROJAN_PASSWORD`、`ENABLE_TROJAN`/`TROJAN`、`ENABLE_XHTTP`/`XHTTP`。

### 0.18.4 KV 归属：为什么「一个 KV = 一个实例」

键全局平铺、无实例前缀：`CONFIG`、`PANEL_PATH`、`ADMIN_PW_HASH`、`ADMIN_PW_PLAIN`、
`LOCAL_PREFERRED_IPS`、`POOL_DOMAIN_LIBRARY`、`SESSION:*`、`ONETIME:*`、
`SCANNER_TOKEN`、`CFP_DEPLOY_MANIFEST`。判断归属**只能靠清单键**。

`assertKvOwnership` 行为：

| 目标 KV 状态 | 判定 | 行为 |
|---|---|---|
| 空 | `empty` | ✅ 放行 |
| 清单属于本次目标 | `owned` | ✅ 放行（原地更新，沿用凭据） |
| 清单属于**另一个**实例 | `occupied` | ❌ **中止**（`--force-kv` 可强推） |
| 含 CFNext 的 `config` 键 | `foreign` | ⚠️ 只提醒（键不重叠，可共存） |
| 含 `CONFIG` 但无清单 | `stale` | ❌ 中止（残留配置） |

### 0.18.5 旧实现的三个问题（已修）

1. **CLI 的「自动识别复用清单」从未生效**：旧 `--kv` 缺省就无条件新建 KV →
   UUID 与 WS 路径每次都变 → 客户端订阅地址每次都变。
   → 现改为：未指定 `--kv` 时列出账号下所有 KV 并探测清单；恰好一个 → 复用（更新模式）；
   一个都没有 → 新建；有多个 → 要求 `--kv` 明确指定。另加 `--new-kv` 与 `--list-kv`。
2. **GUI 强制复用且不可修改**：旧 `detectAccount()` 取 `namespaces[0]` 立刻落盘锁定。
   → 现改为：凭据页有 KV 下拉（标注归属：● 本工具实例 / ○ 空或他人在用）、
   「新建 KV」按钮、手填 KV ID 输入框。
3. **`fresh` 模式在共用 KV 下是破坏性操作** → 现改为必须绑定未被占用的 KV。

### 0.18.6 一个账号跑多个实例

支持且推荐：每个实例独立 KV。用户若已有**原版 CFNext 的 Pages 项目**（用小写 `config` 键），
与 CFPilot 的键**完全不重叠**，可以共存；向导会提醒但不阻断。
但建议仍为 CFPilot 单独建 KV，避免共享配额与误操作。

---

## 0.11–0.17 运维与工具链实测结论（2026-10-22，仍然有效）

### 0.11 早期的 Pages 对照实验（结论已被 §0.19.4 部分推翻，存查证思路）

当年做过的对照（同账号）：

| 实验 | 结果 |
|------|------|
| cfnext 原版文件（一行未改）→ Pages 全新随机项目名 | 1/3，第 2 次被封 |
| edgetunnel 原版（**完全不用** `cloudflare:sockets`）→ Pages 全新随机项目名 | 4/4 全部成功 |
| 极简 Worker（无 sockets）→ Pages | 4/4 成功 |
| 30 行只含 sockets 的脚本 | 加载正常，`connect()` 返回 `TCP Loop detected` |

~~结论：平台对含 `cloudflare:sockets` 的 Pages 项目第二次部署时拒绝。~~
**更正（§0.19.4）**：上述「内容决定论」已被证伪 —— 数据面产物（含 sockets）
在新项目上 6/6 连续部署成功；8000119 是账号级间歇性风控，与内容无稳定因果。
~~结论：`TCP Loop detected` 是 sockets 的系统性限制。~~
**更正（§0.20.2）**：第三方 IP 的 443 完全可用，被拒的只有 Cloudflare 自家 Anycast。
**双项目拆分架构保留**，但理由不是「sockets 被判代理」，而是：
数据面已承载流量后原地重部署会被持久拒绝（§0.19.4 晚间补充）。

### 0.12 优选器的适用边界（代理工具会毁掉优选结果）

只要本机有代理工具接管流量（Clash TUN、系统代理、规则把待测 IP 走代理），
扫描测的就是**到代理的延迟**：

| 现象 | 实测证据 |
|------|---------|
| 结果全挤在一个 /24 | 用 TUN 扫描得到 12 条全部是 `103.21.247.x` |
| 延迟被拉平 | 全部显示 18ms（真实差异应该是几百到几千 ms） |
| 导入客户端全 -1 | 因为从未真正直连验证过 |

**已实现检测**：`packages/scanner-cli/src/net-env.ts`（CLI 与 GUI 共用），
实测在本机同时命中「Clash Verge 监听 7897」与「fake-ip 198.18.0.82」。
修正路径后逐个探测不同网段，真实握手耗时 990~4696ms 不等 ——
**101 校验机制是通用的**，任何 CF 网段 IP 都能通过；
优选器的价值主要在**延迟排序**，而不是「筛掉不可用 IP」。

### 0.13 测速方案（2026-10-22 重做）

**方案**：先用 101 校验筛出「确实能服务你的域名」的 IP，再只对这些 IP 测速
（同类工具 CFData-WEB 用公开测速地址解决了通用性但跳过真连接校验，
于是选出「速度很快但导入客户端全是 -1」的 IP）。

| 方式 | 适用 | 要求 | 忠实度 |
|------|------|------|--------|
| `probe` | 目标有探针端点 | 对方须提供 `/__edge_probe` 类端点 | 高（走代理真实路径） |
| `url` | **任何项目** | 无 | 中（测候选 IP 到 CF 边缘的带宽） |

`--speed-mode auto`（默认）自动探测选择。**两种都只作用于已过 101 校验的 IP。**

三个精度设计点：① **滑动窗口峰值而非总平均**（实测峰值与总平均差 3 倍，
丢弃前 1 秒 TCP 慢启动样本）；② **默认 3 条并发连接**（单条 TCP 受拥塞窗口/BDP 限制）；
③ **测速地址可用性预检**（避免把「地址不可用」误判成「所有 IP 速度都是 0」）。

关键文件：吞吐测量 `true-probe.ts` 的 `measureThroughput()`；
测速地址预设与预检 `speed-url.ts`；方式决策 `resolveSpeedMode()`；三阶流程 `scan.ts`。

### 0.14 测速地址解析的一个坑（已修）

`parseSpeedUrl` 原本没拦非 http(s) 协议：`ftp://example.com/a` 会被规范化成
`https://ftp://example.com/a`，解析成 `host=ftp` —— **不报错但完全跑不通**。
现在先匹配 `scheme://` 前缀并拒绝非 http(s)。

### 0.15 WS 路径规则

`--path` / GUI 的「WS 路径」**必须与目标项目实际的 WebSocket 路径完全一致**：

| 项目 | 常见路径 |
|------|---------|
| CFPilot / CFNext | `/vless` 或一长串 UUID |
| 部分项目 | 根路径 `/` |
| 不知道 | 分别试 `/` 与 `/vless`，能出结果的那个就是对的 |

**填错路径不会产生假结果**，只会一个都选不出来 —— 因为校验是真的发起
TLS + WebSocket 101 握手，不是看返回码猜。

### 0.16 scanner CLI 的 MSYS 路径污染（同类问题第二次出现）

Git-Bash 下 `--path /vless` 会被 MSYS 转换成
`C:/Users/<用户名>/.../node_modules/@dsh-ops/bash-win32-x64/vless`，
后果是扫描**静默失败**（0 结果且无任何报错）。
已在 `net-env.ts` 的 `isMsysPollutedPath()` 拦截（纯函数单独放这个文件，
因为测试 import 入口文件会触发其模块级 `main()` 把 vitest 进程 exit 掉），
并提示三种绕开方式：`--path=/vless` 等号写法 / `MSYS_NO_PATHCONV=1` / 换 PowerShell。

> 部署向导的 `validateOptions()` 早就拦了同类问题，但 scanner 漏了。
> **新增 CLI 路径参数时务必检查这一点。**

### 0.17 GUI 打包产物的两个坑

1. **GPU 开关必须写在主进程顶部**，不能只放在 `scripts/start.mjs`。
   打包后的 exe 不经过 start.mjs，远程桌面下 GPU 进程起不来（`error_code=18`）→
   进程直接退出、窗口不出现 → 用户误以为「需要管理员权限」。
2. **`setAttribute('disabled', '')` 不等于取消禁用** —— HTML 里只要 `disabled`
   属性存在就生效，设成空串仍然禁用，表现为按钮永久变灰。要用 `el.disabled = busy`。

---

## 0.1–0.10 历史排查档案（2026-10-21~22，结论大多已被推翻，仅供追溯）

> ⚠️ 本节是 10-21/22 的排查流水。**其中的归因（账号风控 / import 位置 /
> 必须拆分架构 / sockets 决定性）均已被后续真机实验证伪或修正**，
> 正确的现行结论以本文 §0、§0.19.4、§0.20 为准。保留只为查证思路与一个仍可用的诊断接口。

### 10-21：workers.dev 通道的三连挫败（§0.1 / §0.4 / §0.6 / §0.8）

当时在本机网络受限（workers.dev / tail 被墙）的情况下，围绕「完整 bundle
在 Workers 通道启动期失败（1101）」做了四轮排查：

| 轮次 | 主要动作 | 结局 |
|------|---------|------|
| §0.1 | 查 Workers Observability / DNS / 自定义域名 | 定位到部署层三缺陷：workers.dev 路由默认关闭、双点域名 DNS 记录、域名绑定后无连通性校验。已修 |
| §0.4 | 全权限 Token 真机排查 | 发现 esbuild 把静态 import 输出到文件中部（真机 500）→ 构建脚本改为提升 import 到顶部并断言 |
| §0.6 | 同 zone 部署 40+ 对照脚本逐项排除 | 排除体积 / 函数数 / KV / 兼容日期 / minify / 打包器；提出「账号级 flag」假设（本账号 QQ 邮箱，BPB FAQ 点名类型） |
| §0.8 | 拿到代理后做决定性对照 | `*.workers.dev` 上的**极简 Hello World 也 1101**（整个子域异常，与本项目无关）；zone 路由上 CFNext 混淆产物稳定；**Pages `_worker.js` 上的 CFPilot 200×10 稳定，面板正常渲染** |

**结局**：Workers 通道放弃，全面转 Pages。当年「账号 flag」「isolate 启动失败」
等假设再无必要追究 —— 产品已迁移到 Pages 双项目 + 自研数据面（修掉出站选路缺陷后），
相关问题再未复现。**仍可用的遗产**：Workers Observability 查询 API
（比 `wrangler tail` 可靠，`tail.developers.cloudflare.com` 在部分网络下 DNS 被污染）：

```bash
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
{ "queryId": "adhoc-1", "timeframe": { "from": <毫秒>, "to": <毫秒> },
  "view": "events",
  "parameters": { "limit": 20,
    "filters": [{ "key": "$workers.scriptName", "operation": "eq", "value": "<脚本名>", "type": "string" }] } }
```

注意：`view` 是**顶层字段**；`timeframe` 是**毫秒时间戳**；前提是脚本 settings 里
`observability.enabled = true`，否则永远返回 0 条。

### 10-22 凌晨：数据面根因与 vendor 方案（§0.9，已被 §0.20 取代）

当时现象：面板/订阅/探针全部正常，但 WS 入站真机恒定 `TCP Loop detected`。
**当年最终方案**：引入 CFNext 的 `wsHandler` 作为数据面库（认证仍在数据面内部完成），
实测代理链路 10/10；代价是内核体积 62KB → 262KB。
**现状**：自研数据面已修掉真正的根因（出站选路连向 CF Anycast + 异常被吞），
并于 §0.20.10 起成为**默认实现**；vendor 保留为 `DATAPLANE=vendor` 回退通道。

### 10-22 凌晨：拆分部署（§0.10，架构保留、归因已更正）

**问题**：整包部署到 Pages 后第二次部署必被 `8000119 blocked`。
当年结论「Cloudflare 的滥用分类器把完整代理组合判为代理服务」**已被 §0.19.4 证伪**
（与内容无稳定因果）；但**双项目拆分架构保留**，真实理由是：
数据面承载流量后原地重部署被持久拒绝（§0.19.4 晚间补充）。

| 组件 | 内容 | 产物 | 可原地更新 |
|------|------|------|-----------|
| 控制面 | 面板 + 订阅 + 探针 | `dist/control.js` | ✅ 无限制 |
| 数据面 | 自研 WS 数据面（vendor 可回退） | `dist/dataplane.js` | ❌ 需新建项目 |

---

## 1. 项目一句话定位

CFPilot 是一个跑在 Cloudflare Workers/Pages 上的**代理微内核 + 真连接优选面板**：
VLESS-WS / Trojan-WS / VLESS-XHTTP 三种入站，直连 / 并发竞速 / ProxyIP / NAT64 /
SOCKS5 / HTTP / HTTPS 代理 / 反代入口多种出站，四层优选池订阅引擎，
以及专门解决「优选 IP 填进客户端全是 `-1`」的**真连接探针**，整合成可一键部署的一套方案。

核心差异点：优选时用**用户自己的 Worker 域名**作 TLS SNI / HTTP Host 去打
`/__edge_probe` 并要求返回 `101 Switching Protocols`，
一次性淘汰 Enterprise 专属 IP、SNI/Upgrade 定向阻断 IP、不匹配端口协议的 IP，
所以优选结果 100% 对应用户自己的域名，而不是借用第三方 CDN 测速。

---

## 2. 当前进展速览

| 子包 | 状态 | 说明 |
|------|------|------|
| `packages/worker-core` | ✅ 功能完成 | 边缘内核 + 中文面板。产物体积：合并版 294KB / 控制面 56KB / 数据面 247KB |
| `packages/scanner-cli` | ✅ **npm 已发布 0.3.0** | 三阶真连接扫描器 + 国家筛选 + 本地桥接服务 |
| `packages/deploy-wizard` | ✅ **npm 已发布 0.3.0** | 全中文部署向导（**Pages 双项目** + **Workers 双脚本**），含 KV 归属校验 / 版本跳过 / DATA_HOST 同步 / 数据面健康探测 |
| `packages/gui` | ✅ 已发布 exe（最新 release v0.1.4） | Electron 图形化工具；包版本 0.3.0，下次 tag `gui-v0.3.0` |
| 单元测试 | ✅ **40 个文件 / 390 个用例全绿** | 协议 / 鉴权 / 订阅清洗 / CF API / Pages 部署 / **Workers 部署** / 优选 / 选路 / DoH / 反代 / 代理 / ECH / 数据面切换 / UA 协商 / 环境检测 / 采样 / 国家 |
| CI | ✅ **全绿** | 类型检查 → 单测 → 构建 → 资产一致性 → GUI 构建 |
| 真实端到端部署 | ✅ **已验证** | Pages 双项目 + 三种入站 + 代理池 + 反代入口 + 面板 + 订阅 + 优选全部真机实测通过 |
| 版本体系 | ✅ **统一 0.3.0** | 根 package.json 单一版本源，`npm run version:bump` 一键升级 |

代码规模：`packages/` 下 TypeScript **123 个文件 / 约 24000 行**（含测试，不含 `dist/` 与生成文件）。

### 部署形态

**两种形态，共用同一份内核产物与同一套 KV 键约定**（但不能共用同一个 KV）。

```
形态 A：Pages 双项目（默认，推荐）
控制面 Pages（无 sockets）           数据面 Pages（自研实现，vendor 可回退）
  面板 / 订阅 / 探针 / 诊断     ←→    VLESS / Trojan-WS / XHTTP 入站
        │                            │
        └──── 共用同一 KV ───────────┘
             （配置、优选池、凭据、清单 CFP_DEPLOY_MANIFEST）

形态 B：Workers 双脚本（实验性）
控制面 Worker（无 sockets）          数据面 Worker（自研实现）
        │                            │
        └──── 共用同一 KV ───────────┘
             （配置、优选池、凭据、清单 CFP_DEPLOY_MANIFEST_WORKERS）
```

| 维度 | Pages 双项目 | Workers 双脚本 |
|------|-------------|---------------|
| 数据面能否运行 | ✅ 真机 5/5 正常 | ❌ 真机 5/5 返回 522（§0.22） |
| 原地重复更新 | ❌ 承载流量后持久拒绝（8000119） | ✅ 5/5 全部成功 |
| 更新操作 | 新建项目 + 切 DATA_HOST + 重发控制面（向导自动） | 直接重跑同一条命令 |
| 默认 | ✅ 是 | ⬜ 需显式选择 |

- 控制面通过环境变量 `DATA_HOST` 指向数据面域名，生成订阅时用作 `sni`/`host`
  （数据面换名后由向导自动同步，见 §0.20.12 问题 3）
- 数据面默认走自研实现（`src/outbound/*` + `src/protocols/websocket-self.ts`），
  `DATAPLANE=vendor` 回退 CFNext `wsHandler`
- 部署清单是识别同源项目与 KV 归属的**唯一依据**：
  Pages → `CFP_DEPLOY_MANIFEST`；Workers → `CFP_DEPLOY_MANIFEST_WORKERS`

---

## 3. 仓库结构与模块职责

```text
CFPilot/
├── AGENTS.md                     # 架构铁律 + 版本号政策（改代码前必读）
├── HANDOVER.md                   # 本文件
├── README.md                     # 用户向文档（中文，含免责声明）
├── cloudflare项目方案.md          # 原始需求方案 + 5 阶段执行计划
├── docs/
│   ├── cloudflare-deployment-diagnosis.md   # 平台限制取证摘要
│   ├── kv-instance-isolation.md             # KV 实例隔离设计
│   └── self-developed-dataplane-design.md   # 自研数据面设计文档
├── archive/
│   └── self-developed-dataplane/ # 归档：第一版自研 WS 数据面（有缺陷，勿直接启用）
├── .github/workflows/
│   ├── ci.yml                    # 类型检查 / 单测 / 构建 / 资产校验 / GUI 构建
│   └── release-gui.yml           # 图形化工具打包发布（tag 与根版本一致性校验）
├── scripts/
│   ├── sync-version.mjs          # 根版本 → 全 workspace 传播（prepublishOnly 兜底）
│   └── bump-version.mjs          # 版本升级唯一入口
└── packages/
    ├── worker-core/              # @cfpilot/worker-core（private，不发布）
    │   └── src/
    │       ├── index.ts          # 合并版入口（仅本地测试用）
    │       ├── entry-control.ts  # 控制面入口 → dist/control.js
    │       ├── entry-data.ts     # 数据面入口 → dist/dataplane.js
    │       ├── version.ts        # 构建版本号（/__cfp_version 端点，⚠️ 手写文件勿覆盖）
    │       ├── routes/           # control.ts / data.ts / shared.ts（UA 格式协商在 shared）
    │       ├── config.ts         # 配置加载（KV CONFIG > env > 默认值）
    │       ├── auth.ts           # 密码 + 会话 Cookie + 一次性扫描令牌
    │       ├── api.ts            # 面板 REST API + SSE
    │       ├── store.ts          # KV / 内存存储抽象
    │       ├── probe.ts          # /__edge_probe（WS 101 校验 + 流式测速）
    │       ├── sub-engine.ts     # 优选池合并 + 脏数据清洗 + 三格式订阅输出
    │       ├── budget.ts         # Free CPU 毫秒预算保护（活跃段计量）
    │       ├── protocols/        # vless / trojan / xhttp / websocket(-self) / stream / address / sha224
    │       ├── outbound/         # dial / route / doh / relay / proxy-pool / socks5 / http-proxy / io
    │       ├── data/pools.ts     # 优选网段与机房-国家表（改后同步 scanner-cli/countries.ts）
    │       ├── vendor/           # CFNext 数据面（原样引入，勿改）
    │       └── ui/panel.html     # 单文件零框架中文面板（构建时压缩进 panel.generated.ts）
    ├── scanner-cli/              # cfpilot-scanner（npm 包，已发布 0.3.0）
    │   └── src/  cli / args / scan / candidates / true-probe / speed-url / server(桥接)
    │              / ip-ranges / countries / net-env / callback / scanner-lib / version
    ├── deploy-wizard/            # cfpilot-deploy（npm 包，已发布 0.3.0）
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
  协议响应头**先回**、出站后台进行（铁律，见 AGENTS.md 10）。
- **出站**：直连 TCP、并发竞速拨号、ProxyIP 池故障转移、NAT64 前缀合成、
  SOCKS5 / HTTP CONNECT / HTTPS 代理池（`#sni=` 显式 SNI、域名自动推导 SNI）、
  **反代入口池**（`relayPool` 可自配、colo 优先、30s 缓存、`USE_BUILTIN_RELAY` 可关）、
  CF 网段候选降权（含域名直连降权）。
- **数据面实现**：默认自研（`websocket-self.ts` + `outbound/*`），
  `DATAPLANE=vendor` 回退 CFNext；自研提供 `/__diag` 分级诊断端点。
- **探针 `/__edge_probe`**：`Upgrade: websocket` → 返回 `101` 并回传 `cf.colo`；
  `?bytes=N` → 流式输出（上限 15 MB，默认 2 MB）用于真实下行测速。
- **订阅**：`/sub/<UUID>`；格式按 **URL 参数 > User-Agent > 默认 base64** 协商；
  节点形态由 `subVariants` 多选控制（默认只 `vless-ws`）；
  订阅名称可改（`subName`，干净输出不带扩展名）；端口多选（`subPorts`，手动池非 443 豁免）；
  ECH 参数可注入三种格式（默认关闭）。
- **优选池四层**：L1 本地真连接结果（KV `LOCAL_PREFERRED_IPS`）→ L2 `ADD` 手动 →
  L3 `ADDAPI` 远程 TXT → L4 `ADDCSV` 远程 CSV（支持 `DLS`/`MAX_LATENCY` 阈值）。
- **脏数据容错**：裸 IP、`IP:Port`、`IP:Port#备注`、`[IPv6]:Port#备注`、优选域名、
  CloudflareSpeedTest 风格 CSV 原文，清洗逻辑集中在 `sub-engine.ts`。
- **面板**：概览（含数据面域名）/ 节点来源 / 订阅 / 入站配置 / 高级 五个页签，单文件零框架。
- **版本端点**：`GET /__cfp_version` 返回构建版本号，供部署向导判断是否需要更新。

### scanner-cli（本地真连接优选器）

- 三阶扫描：TCP 握手初筛 → WS 101 真连接校验 → 真实下行测速（滑动窗口峰值 + 多连接）。
- **国家筛选**：`--countries`（可多选，不选跑全量）；过滤点在 101 校验后、测速前。
- **候选采样**：`--sample N` 按地址族分配预算，精确产出 N 个（§0.21 #24）。
- **直跑模式**：`npx cfpilot-scanner scan --host <域名> --token <令牌>`，跑完自动回填面板 KV。
- **对接任意 VLESS-WS 项目**：`--path /<该项目路径>`；目标没有测速端点时自动跳过测速。
- **可复制输出**：`IP:端口#机房` 列表，一行一个，可直接粘进同类项目的「自定义 IP」框。
- **桥接模式**：`npx cfpilot-scanner serve` 在 `127.0.0.1:19527` 提供
  `/status`、`/start-scan`、`/events`(SSE)、`/results`。
- **网络环境检测**：`net-env.ts` 检测系统代理 / TUN fake-ip / MSYS 路径污染（CLI 与 GUI 共用）。
- **库出口** `src/scanner-lib.ts`：导出 `runScan` / `resolveCandidates` / `formatCopyable` /
  `SUPPORTED_COUNTRIES` 等，供 GUI 进程内直接调用。

### deploy-wizard（全中文部署向导）

- `pages-split` —— **Pages 双项目（唯一推荐通道）**：建项目 → 配 KV 与环境变量 →
  先部署数据面再部署控制面（顺序不可调换：绑定只对之后的部署生效）。
- **同源项目识别**：清单写 KV `CFP_DEPLOY_MANIFEST`（两个项目名、域名、构建版本、凭据），
  更新部署自动读取，**用户不需要记项目名**。
- **KV 归属校验**（`assertKvOwnership`）：越界写入一律中止；`--list-kv` / `--new-kv` / `--kv <id>`。
- **版本跳过**：构建版本一致时跳过部署，避免无谓触发平台审核。
- **沿用凭据**：更新时默认沿用原 UUID / WS 路径 / 面板凭据；`--new-credentials` 重置。
- **DATA_HOST 自动同步**：数据面换名重建后自动重配控制面（§0.20.12 问题 3）。
- **8000119 重试策略**：先原样重试同一项目 3 次，再换名（§0.19.4）；
  数据面承载流量后的更新走「新建项目」流程（§0.19.4 晚间补充）。
- **参数校验**：拒绝被 MSYS 转换的 Windows 路径。
- 支持 `--yes` 非交互与 `--dry-run`；零运行时依赖，`npx -y` 秒级拉起。

### gui（图形化部署与维护工具，Electron）

- 四个页签：Cloudflare 凭据 / 一键部署 / 本地真连接优选 / 说明；下方常驻运行日志。
- **凭据只存本机** `~/.cfpilot-gui/secrets.json`，不经过任何中间层。
- **账号与 KV 自动检测**：Token 查可见账号；KV 下拉标注归属 + 新建按钮 + 手填 ID。
- **域名自动识别**：一键从 KV 清单 + Pages 项目解析数据面域名（自定义域名优先）。
- **优选直接跑**：进程内 import scanner 库；国家多选下拉（列表 IPC 取自 scanner 库）；
  端口固定 443；结果同时给「可复制列表」与表格。
- **数据面实现下拉**：默认自研，可选 CFNext 原版。
- **应用内更新**：查 GitHub Releases → 下载 portable exe → 替换 → 重启。
- **不需要管理员权限**：NSIS 装 `allowElevation: false`；GPU 降级启动（§0.17）。

---

## 5. 未完成项与已知缺口（接手后按此优先级推进）

### 已关闭的缺口

| 原缺口 | 状态 | 说明 |
|------|------|------|
| 缺口 1：面板「一键优选」链路断裂 | ✅ 已修 | `candidates.ts` 抽出，桥接服务在未收到 candidates 时自行生成 |
| 缺口 2：两个 npm 包未发布 | ✅ **已发布 0.3.0** | 用户执行 F2A；`npx -y cfpilot-scanner@latest` / `cfpilot-deploy@latest` 均可用 |
| 缺口 3：npm 包缺 README | ✅ 已补 | 三个包均有 README |
| 缺口 4：没有真实端到端验证 | ✅ 已完成 | 见 §0.4 |
| 缺口 7：WS 数据面代理池不生效 | ✅ 已解决 | 自研数据面接管后代理池全链路真机验证（§0.20.11 / §0.20.13） |

### 仍开放的缺口

| 优先级 | 事项 | 说明 |
|--------|------|------|
| P1 | 缺口 6：README「手动部署」章节 + pages 压缩包 | 目前只有 CLI 与图形化两条路径。压缩包应含 `control/` 与 `data/` 两个目录（各自 `_worker.js`），并说明绑定与变量配置 |
| P1 | DoH TXT 优选库真机验证 | 需要特定域名（普通域名 TXT 是 SPF/验证记录） |
| P2 | 缺口 9：exe 未代码签名 | SmartScreen 会提示；彻底消除需 OV 证书（约 $70-200/年），自签名同样触发 |
| P2 | Phase 5 自动化联调脚本 | 已部分落地：`packages/worker-core/scripts/selfdp-e2e/` + npm script `e2e:echo`/`e2e:dev`/`e2e:test`（预期 7/7）；仍缺「起内核 → 跑 scanner → 校验 101/测速/回填」的一条龙 |
| P2 | GUI 界面人工点验 | 目前仅构建 + 类型检查 + 产物标记验证 |
| — | 数据面内核更新 | 受 8000119 限制停在上一版；下次更新走「新建项目」流程（功能不受影响，本批改动全在控制面侧） |

### 缺口 8（P2）：功能层面明确不支持的部分（设计取舍，非 bug）

- UDP over WebSocket → 返回 400；XHTTP 不支持 UDP → 返回 400。
- Clash / Sing-box 内核不支持 XHTTP，这两种订阅只输出 WS 节点；
  Base64 分享链接同时给 `type=ws` 与 `type=xhttp&mode=stream-one`。
- 方案文档提到的「BPB 风格 TLS Fragment 参数注入」未实现（可选功能，README 也没承诺）。
- 标准 HTTP CONNECT 代理**无法用 Cloudflare Worker 搭**（边缘拒绝转发 CONNECT，见 §0.20.11）。

---

## 6. 接手前必须知道的架构铁律

> **完整清单以 AGENTS.md 为准**（28 条架构铁律 + 版本号政策专节，2026-10-23 版）。
> 以下只列最容易违反、违反即出线上故障的几条：

1. **配置优先级恒为** `KV(CONFIG) > 环境变量 > 内置默认值`；新增配置项必须三层都支持并在 `config.ts` 登记。
   （例外：面板路径与密码 env 优先。）
2. **Worker 产物预算 80 KB**（当前控制面 56KB 达标；合并版/数据面属既有例外）。
   不要往 `worker-core` 塞第三方依赖；面板必须是零框架单文件 HTML。
3. **`/__edge_probe` 不可删除**，必须始终提供「WS 101 握手校验」+「流式下行测速」两项能力。
4. **优选 IP 清洗逻辑只能写在 `sub-engine.ts`**，禁止在别处重复实现。
5. **数据面与控制面分离**：`worker-core` 只处理代理与订阅；不得引入 Node API（`node:*`）。
6. **零运行时依赖**：`scanner-cli` / `deploy-wizard` 不得引入第三方运行时依赖。
7. **一个 KV = 一个实例**；归属只认 `CFP_DEPLOY_MANIFEST`；写入前 `assertKvOwnership`。
8. **绝不要写 CFNext 的小写 `config` 键**（会整体覆盖共栖项目配置）。
9. **数据面默认自研、vendor 可回退**（`DATAPLANE=vendor`）；`src/vendor/` 勿改。
10. **8000119 应对**：新项目先原样重试再换名；已承载流量的数据面必须新建项目更新（§0.19.4）。
11. **Worker 不能连回 Cloudflare 自家 Anycast**；CF 网段目标靠反代入口打通；
    域名解析到 CF 网段时域名直连也要降权。
12. **close reason 必须截断到 123 字节**（RFC 6455，超长 CF 边缘静默丢弃整个 frame）；
    **代理握手必须有超时**；**HTTPS 代理用 `starttls` 不用 `'on'`**。
13. **`connect(address, options)` 的 options 是第二个参数**（放错位置运行时静默忽略）。
14. **Pages 部署 `_worker.js` 的 metadata 不能带 `compatibility_date`**；
    **WS 路径用 `WS_PATH` 且值带前导斜杠**。
15. **版本号单一源**：只改根 package.json，`npm run version:bump` 升级（§0.3）。

### 三个容易踩的「不要动」点

- **`gen-panel.mjs` 的换行归一化与 gzip OS 字节归一化不要改回去。**
  前者消除 CRLF/LF 差异，后者消除 gzip 头第 10 字节的平台差异（Windows `0x0a` / Linux `0x03`）。
  两者都会让 CI 的「资产与构建一致」校验误报失败。
- **CLI 的 shebang 只能由构建脚本注入。** 源码 `cli.ts` 里再写一次 `#!` 会让 esbuild
  产物出现两行 `#!`，Node 只认第一行 → 语法错误，npx 直接不可用。
- **改 `compatibility_date` 时要同时改两处**：`packages/worker-core/wrangler.jsonc` 与
  `packages/deploy-wizard/src/wizard.ts` 的 `COMPATIBILITY_DATE`（当前均为 `2026-01-01`）。

### Electron 相关的两个坑

- **GPU 错误不能用 `app.disableHardwareAcceleration()` 解决**：GPU 进程在 JS 入口
  执行**之前**就已启动。必须在**命令行参数**里禁用（`scripts/start.mjs` 已做逐级降级）。
- **esbuild ESM→CJS 的 `0 && (module.exports = ...)` 守卫**：被 bundle 的模块导出会变成死代码。
  GUI 的 `bridge` / `config-store` / `scanner` 必须**各自独立成文件**，不能内联进 main.js。

---

## 7. 常用命令

```bash
npm install
npm run typecheck     # 各子包 tsc --noEmit（worker-core 会先重新生成面板产物）
npm test              # vitest run —— 39 文件 / 381 用例
npm run build         # 内核 + 两个 CLI + GUI 打包，并同步 assets/cfpilot-worker.js
npm run verify        # build + typecheck + test
npm run clean         # 清理 dist / .wrangler

# 版本管理（单一版本源，详见 §0.3）
npm run version:sync                    # 把根版本同步到全部 workspace
npm run version:bump -- 0.4.0           # 升级（或 major/minor/patch）

# 本地调试用的凭据在 packages/worker-core/.dev.vars（已被 .gitignore 排除，不要提交）
```

### 部署（多实例）

```bash
# 部署第一个实例：未指定 --kv 时自动新建一个命名空间
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN"

# 更新已有实例：自动探测到唯一的实例并复用（UUID 与 WS 路径不变）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN"

# 查看账号下有哪些实例（KV、项目名、域名、部署时间；两种形态都会列出）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --list-kv

# 部署第二个实例：新建独立 KV（一个 KV 只能承载一个实例）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --new-kv

# 账号下有多个实例时，必须用 --kv 明确指定
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --kv <namespace-id>
```

### 部署（Workers 双脚本 · 实验性）

```bash
# 首次部署（数据面可能 522，控制面完全可用；详见 §0.22）
npx -y cfpilot-deploy@latest worker-split --token "$TOKEN"

# 更新：直接重跑同一条命令 —— Workers 原地更新实测 5/5 成功，不会触发 8000119
npx -y cfpilot-deploy@latest worker-split --token "$TOKEN" --kv <namespace-id>

# 绑自定义域名（三个参数要一起给）
npx -y cfpilot-deploy@latest worker-split --token "$TOKEN" --kv <id> \
  --control-host panel.example.com --data-host node.example.com \
  --zone-id <zone-id>

# 强制重传（忽略版本跳过）
npx -y cfpilot-deploy@latest worker-split --token "$TOKEN" --kv <id> --force
```

> ⚠️ Workers 与 Pages 两种形态**不能共用同一个 KV**，向导会检测并拒绝（`--force-kv` 可强推）。
> ⚠️ 部署结束后向导会主动探测数据面 `/__diag`，失败时明确告警并指引改用 `pages-split`。

### 图形化工具

```bash
npm run start -w @cfpilot/gui              # 从源码启动（带 GPU 降级重试）
npm run build -w @cfpilot/gui
cd packages/gui && npm run dist             # 打包 exe → packages/gui/release/
```

> 本地打包需要两个环境条件（Windows 沙箱下尤其明显）：
> 1. `TEMP` 指向可写目录（NSIS 的 makensis 需要创建临时文件）
> 2. `npm_config_allow_scripts=true`（npm 的 allowScripts 策略会拦 electron-builder 的子进程安装）
>
> ⚠️ **本地 electron-builder 打包会被本机沙箱拦截**（safe-delete 守卫清理
> `win-unpacked/locales` 超阈值）——**正式发布必须走 GitHub Actions**
> （`windows-latest` 无此限制）。

### 发布

```bash
# npm 包（需用户执行 F2A；当前两包均已发布 0.3.0）
cd packages/scanner-cli  && npm publish --access public
cd packages/deploy-wizard && npm publish --access public
# prepublishOnly 会自动 sync 版本 + 构建

# 图形化工具：推 tag 触发 CI 自动发布（tag 必须与根版本一致，如 0.3.0）
npm run version:bump -- 0.3.1   # 先升级
git tag gui-v0.3.1 && git push origin gui-v0.3.1
```

### CI

`.github/workflows/ci.yml`：类型检查 → 单测 → 构建 → 校验内置资产与构建一致 → 上传内核产物
→ 独立 job 构建 GUI。
`.github/workflows/release-gui.yml`：推 `gui-v*` 标签或手动触发 → **校验 tag 与根版本一致**
→ 打包 → 上传 Releases → 回写版本号 commit。

---

## 8. 建议的下一步路线

| 优先级 | 事项 | 验收标准 |
|--------|------|----------|
| P1 | README「手动部署」章节 + pages 压缩包 | 压缩包含 `control/` 与 `data/` 两个目录，各自带 `_worker.js`；README 说明控制台逐步操作 |
| P1 | DoH TXT 优选库真机验证 | 用一个 TXT 存优选库的域名，验证 `ADDAPI`/DoH 路径端到端 |
| P1 | 数据面内核更新（新建项目流程） | 用当前内核新建数据面项目 → 切 DATA_HOST → 订阅节点全部可用 |
| P2 | GUI 界面人工点验 | 自动识别域名 / 国家多选 / 订阅名称 / 端口多选逐项点过 |
| P2 | Phase 5 自动化联调脚本 | 一条命令起本地内核并验证 101 握手 / 测速 / 回填 / 脏数据订阅输出 |
| P2 | 代码签名 | 消除 SmartScreen 拦截（需购买 OV 证书） |
| P3 | 可选：TLS Fragment 参数注入 | 与 BPB-Worker-Panel 行为对齐，需同步更新 README 与订阅渲染 |

---

## 9. 关键文件速查

| 想改什么 | 去哪个文件 |
|----------|-----------|
| 面板界面 | `packages/worker-core/src/ui/panel.html`（改完跑 `npm run build`，会重新生成 `panel.generated.ts`） |
| 优选 IP 解析 / 订阅渲染 / 变体与端口语义 | `packages/worker-core/src/sub-engine.ts` |
| 探针行为（101 / 测速） | `packages/worker-core/src/probe.ts` |
| 面板接口 | `packages/worker-core/src/api.ts` |
| 面板鉴权 / 凭据优先级 | `packages/worker-core/src/auth.ts` |
| 代理入站协议 | `packages/worker-core/src/protocols/*`（WS 自研在 `websocket-self.ts`，vendor 在 `vendor/`） |
| 出站拨号 / 选路 / 代理链 / 反代 | `packages/worker-core/src/outbound/*` |
| 控制面 / 数据面路由 | `packages/worker-core/src/routes/`（UA 格式协商在 `shared.ts`） |
| CPU 预算（活跃段计量） | `packages/worker-core/src/budget.ts` |
| 构建版本号与产物可复现 | `packages/worker-core/scripts/build.mjs` |
| 面板压缩与换行归一化 | `packages/worker-core/scripts/gen-panel.mjs` |
| 自研数据面 e2e 工具 | `packages/worker-core/scripts/selfdp-e2e/`（npm script `e2e:*`） |
| 扫描三阶段逻辑 | `packages/scanner-cli/src/scan.ts`、`true-probe.ts` |
| 候选 IP 生成与采样 | `packages/scanner-cli/src/candidates.ts`、`ip-ranges.ts` |
| 国家列表（三端同源） | `packages/scanner-cli/src/countries.ts`（**只允许在 worker-core `data/pools.ts` 改后同步**） |
| 网络环境（代理）检测 | `packages/scanner-cli/src/net-env.ts` |
| scanner 库出口（供 GUI 复用） | `packages/scanner-cli/src/scanner-lib.ts` |
| 本地桥接服务 | `packages/scanner-cli/src/server.ts` |
| 测速地址预设与预检 | `packages/scanner-cli/src/speed-url.ts` |
| **Pages 双项目部署流程** | `packages/deploy-wizard/src/pages-deploy.ts`（清单、版本跳过、DATA_HOST 同步、换名重试都在这里） |
| **Workers 双脚本部署流程** | `packages/deploy-wizard/src/worker-deploy.ts`（独立清单键、原地更新、数据面健康探测） |
| 部署形态选择（GUI） | `packages/gui/src/renderer/index.html`（`name="deployMode"`）+ `renderer.ts` 的 `applyDeployMode()` |
| 面板「部署形态」卡片 | `packages/worker-core/src/ui/panel.html` 的 `renderDeployShape()` |
| CF API 封装 | `packages/deploy-wizard/src/cf-api.ts` |
| 部署向导 CLI | `packages/deploy-wizard/src/cli.ts` |
| GUI 主进程与桥接 / 域名识别 | `packages/gui/src/main/bridge.ts` |
| GUI 界面 | `packages/gui/src/renderer/*` |
| GUI 应用内更新 | `packages/gui/src/main/updater.ts` |
| 版本同步脚本 | `scripts/sync-version.mjs`、`scripts/bump-version.mjs` |

---

## 10. 凭据与安全须知

- Cloudflare Token、面板密码、扫描令牌**一律走环境变量或 KV**，不得写进代码、README、截图或提交记录。
- `packages/worker-core/.dev.vars` 仅供本地调试，已被 `.gitignore` 排除，**不要提交**。
- 面板路径、密码、扫描令牌部署时随机生成；面板路径可随时更换。
- 内核对 `/api/v1/*` 除公开接口（`/session`、`/login`、`/logout`、`/preferred-ips`）外一律要求会话或 Bearer 令牌。
- **GUI 的凭据只写在本机** `~/.cfpilot-gui/secrets.json`，不经过任何中间层、不上传、不随安装包分发。
- 仓库根目录与 `docs/` 下的 `迁移指令文档.txt` **含服务器明文凭据**，已被 `.gitignore` 排除，**禁止入公有仓库**。

---

## 11. 当前线上环境（供接手者参考，2026-10-23 晚）

| 项目 | 说明 |
|------|------|
| Pages `e4kkjet6` | **控制面**，`e4kkjet6.pages.dev`，面板路径 `/p-vgagv2c4`；可原地重部署（不承载代理流量） |
| KV `cfp-kv` | 两个项目共用，存配置 / 优选池 / 部署清单 / 凭据哈希 |
| Pages 数据面项目 | ⚠️ **多变体**：因 8000119 多次换名重建（`cfpilot-dp-rnjw`、`ck12akov-*` 系列都曾服役），控制面 `DATA_HOST` 由向导自动切换；**当前实际域名以 KV `CONFIG` 与部署清单为准，勿假设** |
| Pages `cfnext` | 用户原有的 CFNext 项目，**不要动**（用小写 `config` 键，与 CFPilot 键不重叠） |
| Worker 脚本 | 0 个（数据面走 Pages） |

实例凭据（沿用中，更新部署不变）：UUID `fbe5bd2d-5dca-4bd6-84b8-a8b727df3374`，
WS 路径 `/ooosrkxwbt`。多个数据面旧项目按用户要求保留未删。

> 这些是**用户测试账号**的资源。接手后如果要重新部署，优先用
> `npx -y cfpilot-deploy@latest pages-split`（自动探测并复用清单），
> 不要手工建 Pages 项目，否则清单会指向旧项目。
>
> ⚠️ 数据面要更新内核时，**必须走「新建项目 + 切 DATA_HOST + 重发控制面」**
> （原地重部署会被持久拒绝，见 §0.19.4 晚间补充）。
>
> 账号下已有多个 CFPilot 实例时，`pages-split` 会要求用 `--kv <id>` 明确指定；
> 用 `--list-kv` 查看各实例的 KV 与项目名。
>
> 备注：该账号 2026-10-23 曾触发 Workers KV 免费套餐每日用量 50% 预警（UTC 00:00 重置），
> 大量部署/读写的日子注意节约，遇到 429 换时间窗。

---

## 12. 免责

本项目**仅供学习交流使用**，用于查找资料、学习知识，**不做任何违法行为**。
所有方法均来自互联网，仅供大家交流学习使用，**出现违法问题概不负责**。
使用者需自行遵守所在地法律法规与 Cloudflare 服务条款（尤其 Free 套餐的流量与 CPU 限制）。
MIT 许可，见 [LICENSE](LICENSE)。
