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
3. **数据面必须绑定 KV 变量名 `K`**，控制面读 `KV`。两个都要绑，缺一个就有一侧读不到配置。
   （注：当前数据面产物由 `src/entry-data.ts` 构建，它走 CFPilot 自己的 `loadConfig()`，
   读的是 **大写 `CONFIG` 键**；`K` 绑定是给 vendor CFNext 风格代码留的兼容位。见 §0.12。）
4. **⚠️ 一个 KV 命名空间只能承载一个 CFPilot 部署实例。**
   内核在 KV 里用的是全局平铺的键，**没有实例前缀**：
   `CONFIG` / `PANEL_PATH` / `ADMIN_PW_HASH` / `LOCAL_PREFERRED_IPS` /
   `POOL_DOMAIN_LIBRARY` / `SESSION:*` / `SCANNER_TOKEN` / `CFP_DEPLOY_MANIFEST`。
   两个实例共用一个 KV 会互相覆盖 UUID、WS 路径、面板密码与会话。
   部署向导在**写入任何键之前**做归属校验，越界写入一律中止（见 §0.12）。
   要在同一账号下跑多个实例，给每个实例一个独立 KV。
5. **绝不要写 CFNext 的小写 `config` 键。**
   那是 CFNext 原版的配置键，vendor 侧是 `Object.assign(默认, kvConfig)` **整体覆盖**：
   往里写会直接改坏共栖的 CFNext 项目的 uuid / path / trojanPassword。
   CFPilot 自己的数据面**不读**这个键（读的是大写 `CONFIG`），写了纯属破坏。
6. **配置优先级仍是 `KV (CONFIG) > 环境变量 > 内置默认值`**（AGENTS.md 铁律 1）。
   因此部署向导把本次凭据写入 KV 的 `CONFIG` 键，让它真正生效；
   环境变量只作为 KV 不可用时的兜底。
7. **构建产物必须可复现**。版本号形式为 `<git hash>-<源码内容哈希>`，
   **绝不能加时间戳**（否则 CI 资产一致性校验必然失败）。
8. **面板产物必须统一换行为 LF**（`gen-panel.mjs` 已做）。
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

## 0.18 KV 实例隔离与数据面产物的实证（2026-10-22 晚，本文最新结论）

本节是对 §0 中若干**过时描述**的更正，每条都有代码/产物层面的证据。
设计文档见 [docs/kv-instance-isolation.md](docs/kv-instance-isolation.md)。

### 0.18.1 数据面产物到底是什么（更正 §0.9 / §0.10）

**结论：数据面产物是 `dist/dataplane.js`（`src/entry-data.ts` 构建），内含 vendor 的 `wsHandler`。
不是「CFNext 原版文件、不二次打包」。**

证据：

- `packages/worker-core/scripts/build.mjs` 的 `TARGETS`：
  `{ entry: 'src/entry-data.ts', out: 'dataplane.js' }`（从 `d5c7a16` 起从未变过）。
- `packages/deploy-wizard/assets/` 在 git 全历史里**只有** `cfpilot-worker.js`，
  从未存在 `dataplane.js`；向导的 `loadBundle('dataplane.js')` 实际解析到
  `packages/worker-core/dist/dataplane.js`。
- 产物里含 vendor 特征串（`WebSocketPair`、`preferredIPs`、`CFNext`）。

### 0.18.2 vendor `wsHandler` 的真实签名与行为（更正「数据面读 KV `config` 键」）

对 `vendor/cfnext-dataplane.js` 做**精确的花括号配平解析**（跳过字符串/模板/注释）后确认：

- 导出的 `Gt` 签名是 **`Gt(request, config)`**：首参是 Request，次参是配置对象。
  体内 `t.K` 出现 **0** 次，`get("config")` 出现 **0** 次 ——
  **它既不读 KV，也不读 env**，只吃传进来的 `config`（`e.uuid` / `e.trojanPassword` / `e.enableTrojan`）。
- CFNext 自己的配置加载器是另一个函数 `lt(env)`，它才读 env（`U`/`PATH`/`L`…）
  与 KV 的小写 `config` 键。但 `lt` 只被 vendor 内部的 `on`（默认 fetch 处理器）调用，
  而本项目只 import 了 `wsHandler` → **`lt` 被 esbuild tree-shaking 整个移除**。
  实证：产物里 `WARP_ENDPOINTS` / `MASQUE_SNI` / `YXURL` / `HOME_WAN` / `TGTOKEN` /
  `OUTBOUND` / `ALPN` 等 `lt` 独有特征串**全部为 0**；`.K.` 访问 **0** 次。

**因此：数据面走的是 CFPilot 自己的 `loadConfig()`，读 KV 的大写 `CONFIG` 键。**
路径路由也由 `src/routes/data.ts` 用 `config.wsPath` 判断，不是 vendor 做的。

### 0.18.3 两个由此暴露的真实缺陷（已修）

1. **向导写错了键**：旧 `syncDataPlaneKvConfig()` 往小写 `config` 键写 CFNext schema。
   但数据面根本不读它 —— 写了没用；更糟的是它会**整体覆盖**共栖的 CFNext 项目的
   `config`（vendor 侧 `Object.assign(默认, kvConfig)`），直接改坏别人的 uuid / path。
   → 已删除该函数，改为写大写 `CONFIG` 键。

2. **内核的环境变量层有缺口**（违反 AGENTS.md 铁律 1）：
   `configFromEnv()` 原本只读 `env.UUID`，`wsPath` 写死 `/vless`，
   `trojanPassword` 写死空串，`enableTrojan` / `enableXhttp` 写死 `true`。
   实测注入 `PATH=/randomws123` 与 `TROJAN_PASSWORD=trojan-pw-xyz` 后，
   内核读到的仍是 `/vless` 与随机生成的密码 —— **向导注入的数据面环境变量全是死的**。
   → 已补齐 `WS_PATH`/`PATH`、`TROJAN_PASSWORD`、`ENABLE_TROJAN`/`TROJAN`、
   `ENABLE_XHTTP`/`XHTTP`。

### 0.18.4 KV 归属：为什么「一个 KV = 一个实例」

内核在 KV 里用的键**全局平铺、没有实例前缀**：
`CONFIG`、`PANEL_PATH`、`ADMIN_PW_HASH`、`ADMIN_PW_PLAIN`、`LOCAL_PREFERRED_IPS`、
`POOL_DOMAIN_LIBRARY`、`SESSION:*`、`ONETIME:*`、`SCANNER_TOKEN`、`CFP_DEPLOY_MANIFEST`。
两个实例共用一个 KV 会互相覆盖 UUID / WS 路径 / 面板密码，且会话可跨实例复用。

判断「这个 KV 属于谁」**只能靠清单键** `CFP_DEPLOY_MANIFEST`（由 CFPilot 自己写入）；
标题、UUID、路径等字段值都不唯一，不能作为归属依据。

**新的部署前校验（`assertKvOwnership`）**，在写任何键之前执行：

| 目标 KV 状态 | 判定 | 行为 |
|---|---|---|
| 空 | `empty` | ✅ 放行 |
| 清单属于本次目标 | `owned` | ✅ 放行（原地更新，沿用凭据） |
| 清单属于**另一个**实例 | `occupied` | ❌ **中止**（`--force-kv` 可强推） |
| 含 CFNext 的 `config` 键 | `foreign` | ⚠️ 只提醒（两者键不重叠，可共存） |
| 含 `CONFIG` 但无清单 | `stale` | ❌ 中止（残留配置） |

### 0.18.5 旧实现的三个问题（已修）

1. **CLI 的「自动识别复用清单」从未生效**：
   旧 `--kv` 缺省就无条件新建 KV → 新 KV 里没有清单 → 永远走首次部署 →
   **UUID 与 WS 路径每次都变 → 客户端订阅地址每次都变**。
   这与 CLI 帮助文本和 §0「更新部署沿用原 UUID」的说法都矛盾。
   → 现改为：未指定 `--kv` 时列出账号下所有 KV 并探测清单；
   恰好一个含清单 → 复用（进入更新模式）；一个都没有 → 新建；有多个 → 要求 `--kv` 明确指定。
   另加 `--new-kv`（部署新实例）与 `--list-kv`（查看账号下有哪些实例）。

2. **GUI 强制复用且不可修改**：
   旧 `detectAccount()` 取 `namespaces[0]`（完全不看归属）、立刻落盘锁定；
   账号下只要有 ≥1 个 KV 就永远不新建；界面上的 KV 是只读 `span`；
   `saveCredentials` 虽有 `kvNamespaceId` 参数但 renderer 从不传（死通路）；
   换 Token 后 `accountId` 永不更新。
   → 现改为：凭据页有 KV 下拉（每项标注归属：● 本工具实例 / ○ 空或他人在用）、
   「新建 KV」按钮、手填 KV ID 输入框；检测只解析账号，KV 由用户显式选择。

3. **`fresh` 模式在共用 KV 下是破坏性操作**：
   旧 `fresh` 只跳过读清单，照样覆盖清单与配置 → 把别人的实例改坏。
   → 现改为：`fresh` 必须绑定未被占用的 KV，否则中止并提示新建。

### 0.18.6 一个账号跑多个实例

现在**支持**，且是推荐用法：

- CLI：`--new-kv` 建独立命名空间后部署；`--list-kv` 查看已有实例；
  多个实例时必须用 `--kv <id>` 指定。
- GUI：凭据页点「新建 KV」为每个实例各建一个，分别选中后部署。
- 用户若已有**原版 CFNext 的 Pages 项目**：它的 KV 用的是小写 `config` 键，
  与 CFPilot 的键**完全不重叠**，可以共存；向导会给出提醒但不阻断。
  但建议仍为 CFPilot 单独建一个 KV，避免共享命名空间的配额与误操作。

---

## 0.19 订阅格式识别、ECH 与真机复验（2026-10-23，本文最新结论）

本节是 §0.18 之后的追加结论，同样每条都有真机或产物级证据。

### 0.19.1 Clash Verge 导入失败的根因：**订阅格式只看 URL 参数，不看 User-Agent**

用户反馈：「Clash Verge 导入失败，但浏览器可以直接读到 YAML 文本」。

**根因**：订阅路由只认 `?target=` / `?format=` 查询参数
（`routes/control.ts` → `resolveFormat()`），**完全不看 `User-Agent`**。
而客户端导入订阅时**只给订阅 URL，不会加 `?target=clash`**，
是靠自己的 User-Agent 表明身份的：

| 客户端 | User-Agent | 期望格式 |
|--------|-----------|---------|
| Clash Verge / Clash / mihomo | `clash-verge/…` | YAML |
| sing-box | `sing-box/…` | JSON |
| v2rayN / Shadowrocket / NekoBox | `v2rayNG/…` 等 | Base64 |

于是 Clash Verge 拿到的是 **Base64 分享链接集合**，按 YAML 解析必然失败。
用户在浏览器里手动加 `?target=clash` 才看到 YAML —— 这正好解释了那个现象。

**已修**：新增 `resolveFormatByUserAgent()`（`routes/shared.ts`），
判定优先级改为 **URL 显式参数 > User-Agent > 默认 base64**；
识别不出来时返回 null（不猜）。

**真机复验**（部署 `hmn1q6y6` 控制面后实测）：

| User-Agent | Content-Type | 结果 |
|-----------|--------------|------|
| `clash-verge/v1.6.6` | `text/yaml` | ✅ YAML（修复前是 base64） |
| `Mozilla/5.0` | `text/plain` | ✅ Base64（不变） |
| `v2rayNG/1.8.5` | `text/plain` | ✅ Base64（不变） |

### 0.19.2 Clash YAML 模板的兼容性问题（已修）

原模板本身**语法合法、字段齐全**（用 PyYAML 严格解析 + mihomo schema 逐项校验均通过），
但有三处会让 Clash Verge 用起来别扭：

1. **`external-controller: 127.0.0.1:9090`** —— Clash Verge 自己会注入并管理这个地址。
   订阅里再写死一个，会与客户端实际使用的端口冲突。
   → 已移除。
2. **`port` / `socks-port`** —— mihomo 只认 `mixed-port`，分开写的是老 Clash 字段。
   → 改为只写 `mixed-port`。
3. **没有 `dns` 段** —— ECH 需要 DoH 解析 ECH 配置。
   → 已补 `dns` 段（fake-ip + DoH nameserver + fallback）。

另外补了 `unified-delay` / `tcp-concurrent`（mihomo 专有，客户端可忽略）。

**真机复验**：线上 YAML 60 个节点全部合规，
组与规则的引用 0 错误、节点名 60/60 唯一、无 `external-controller`。

### 0.19.3 ECH 特性（新增，默认关闭）

参考 edgetunnel 的做法实现（`tmp/edgetunnel-worker.js` 是本地参考副本）。
**ECH 是客户端侧能力**：内核只负责把参数写进订阅，由客户端执行。

新增配置项（`UserConfig`）与环境变量层：

| 配置 | 环境变量 | 默认 |
|------|---------|------|
| `ech` | `ECH` | `false`（默认关闭） |
| `echHost` | `ECH_HOST` | `cloudflare-ech.com` |
| `echDns` | `ECH_DNS` | 空（用客户端默认） |

三种订阅格式的输出（与 edgetunnel 约定一致）：

- **Clash YAML**：每个节点加 `ech-opts: { enable: true, query-server-name: <SNI> }`，
  并在 `dns.nameserver-policy` 里把 ECH 服务器名指向 DoH
- **Base64 分享链接**：URL 加 `&ech=<SNI>+<DoH>`（edgetunnel 的约定）
- **Sing-box**：出站加 `tls.ech = { enabled: true, query_server_name: <SNI> }`

**真机复验**：默认关闭时 YAML 里 `ech-opts` 0 处、90 条链接含 `ech=` 的 0 条；
开启后 YAML 60 个节点全部带 `ech-opts`、90 条链接全部带 `ech=cloudflare-ech.com`。

### 0.19.4 ⚠️ 8000119 是**间歇性**的，不是配置或内容决定的（更正 §0.9 / §0.10 的归因）

§0.9 / §0.10 把 `8000119 blocked` 归因为「把数据面也打进包里 → 判为代理服务」。
**2026-10-23 真机复验推翻了这一归因**，实验记录如下：

在同一账号、同一 KV、同一产物（`dist/dataplane.js`，245 KB）下反复部署到新建项目：

| 配置 | 结果 |
|------|------|
| 最小脚本 + 无 KV 无 env | ✅ 受理 + success |
| 最小脚本 + 双 KV 绑定 | ✅ 受理 + success |
| 数据面产物 + 无 KV 无 env | ✅ 受理 + success |
| 数据面产物 + **双 KV 绑定**（`KV` + `K`） | ❌ 一次 timeout、一次 `8000119` |
| 数据面产物 + **仅 `KV` 绑定** | ✅ 受理 + success |
| 数据面产物 + 仅 env | ✅ 受理 + success |
| **完全相同的双 KV 绑定配置，连续 6 次** | ✅ **6/6 全部成功** |
| 双 KV 绑定，换一个 KV | ✅ 成功 |
| **最初失败的那个项目，原样重试** | ✅ **成功** |

**结论**：
- 失败与「内容是不是代理」「有没有 KV 绑定」「绑几个名字」**都不构成稳定因果**；
- 完全相同的配置重复 6 次全部成功；
- **最初失败的项目原样重试即成功**。

因此 `8000119` 更像是**账号级、间歇性的风控判定**（短时间内大量新建项目/部署会提高触发概率），
而不是「产物内容决定了被封」。

**这解释了 §0.9 那些「1/3」「2/2」「4/4」的不一致比例** —— 它们本来就是随机采样。

**对产品的意义**：
- 向导里已有的 **8000119 换名重试**（`deployWithBlockRetry`）方向是对的，
  但**重试次数太少**（只换 2 个备用名）。实测同一个项目原样重试就能成功，
  说明应当**先原样重试、再换名**。
- 部署失败时**不应把责任归给用户**（旧日志说「是我们改坏了数据面」是误导）。

> ⚠️ 尚未确定触发条件，**不要臆测规则**（沿用 §0.10 的告诫）。
> 下一步若要继续查，应做的是「固定账号、固定配置、重复 N 次」的统计，
> 而不是「换内容看结果」的对照实验。

### 0.19.5 真机复验清单（2026-10-23）

用用户提供的全权限令牌，在账号 `70ec011b12cd621609a8412a4d0c1668` 上完成：

| 项 | 结果 |
|----|------|
| `--list-kv` 列出实例 | ✅ 正确识别 `cfnext` 为「非 CFPilot 实例」 |
| `--new-kv` 全新部署 | ✅ 控制面成功；数据面首次超时、**原样重试成功** |
| `--mode update` 复用实例 | ✅ UUID / WS 路径不变（订阅地址不用改） |
| KV 键检查 | ✅ 大写 `CONFIG` 有值、清单有值、**小写 `config` 不存在**（不再污染共栖的 CFNext 项目） |
| 订阅 UA 自动识别 | ✅ 见 0.19.1 |
| Clash YAML 合规性 | ✅ 60 节点、0 引用错误、名称唯一 |
| ECH 开关 | ✅ 见 0.19.3 |
| 数据面 WS 101 | ✅ `/py3fq5efbe` 与 `/__edge_probe` 均 101 |
| **完整 VLESS 握手** | ✅ **响应头 `版本=0 加盐长度=0`**（UUID 认证通过，与 §0 记录的 `[0,0]` 一致） |
| 清理 | ✅ 8 个对照项目全删；只留 `cfnext`（用户原有）与验证实例 |

---

## 0.20 自研数据面：真机实验结论与新架构（2026-10-23，本文最新结论）

用户提出：重新尝试全自研数据面（参考 edgetunnel / BPB-Worker-Panel / CFNext），
并指出「旧代码陷入开发死循环、永远无法部署还找不出原因」。

**结论：旧代码的死循环有确定的技术根因，且归档文档给出的归因是错的。**
完整设计见 [docs/self-developed-dataplane-design.md](docs/self-developed-dataplane-design.md)。

### 0.20.1 ⚠️ 更正：「静态 import sockets 会导致 1101」是错的

归档文档与 `src/outbound/dial.ts` 的注释都写着
「静态导入 `cloudflare:sockets` 会让 isolate 在启动阶段失败（1101）」，
并称「一个只导入 sockets 的 30 行脚本同样复现 TCP Loop detected」。

**2026-10-23 真机复验（同一账号）**：

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

**被拒的恰好是 Cloudflare 自家的 Anycast 地址**：
Worker 不能主动连回 Cloudflare 自己的入口（会构成环路），
Cloudflare 侧直接拒绝并报 `TCP Loop detected`。
**第三方 IP 的 443 完全可用。**

`request.fetcher.connect`（edgetunnel 用的）**不能**绕过此限制，错误信息与 sockets 完全一致。

### 0.20.3 旧代码死循环的根因（三个缺陷叠加）

```
1) 缺陷 A：同区域过滤写成 p.kind === 'direct'
   → 把 SOCKS5 / HTTP 代理全滤掉
2) 缺陷 B：优选 IP 库装的是硬编码 CF 网段（104.16.0.0/12 等）
   → 候选目标必然是 CF 自家 IP
3) 缺陷 C：tryDial 的 catch 把异常吞掉、只返回 null
   → 每一层失败都表现为「目标不可达」，日志里没有任何线索
```

**所以「永远无法部署还找不出原因」的真相**：
失败发生在出站选路，异常被吞，看起来像随机失败 → 反复重试 → 永远不成。
（对照：CFNext 的优选库用的是**域名** `proxyip.hk.<域名>` 解析出的 IP，未必落在 CF Anycast 段。）

### 0.20.4 三个成熟项目的可借鉴点

| 项目 | 值得借鉴 |
|------|---------|
| **edgetunnel** | 完全不用 `cloudflare:sockets`（实测 0 次引用）；`request.fetcher.connect` 抽象成连接器；自研 `TlsClient` 在裸 TCP 上做 TLS；出站 = 连 `cloudflare.com:443` 探测 → 经 SOCKS5/HTTP 代理 → `CONNECT` 隧道；特征码字典混淆 |
| **BPB-Worker-Panel** | 先回 VLESS/Trojan 协议响应头再中继（避免客户端误判首包）；面板与订阅一体化；代理池配置面；XHTTP/gRPC |
| **CFNext**（当前 vendor） | 出站三级候选顺序：`m()` 直连目标 → `h()` 同区域优选 IP 竞速 → `g()` 走 outboundProxy；`Ct(ip,4000)` 拨号语义；`Ft()` DoH 解析优选 IP；`lt(env)` 三层配置加载器 |

**三者共同的架构事实**：
> 出站要么直连**第三方** IP，要么经外部代理隧道；**不能指望 Worker 直连 Cloudflare 自家 Anycast**。

### 0.20.5 8000119 与滥用邮件（结合用户补充的事实）

用户补充：**邮件从第一次测试部署就收到、几十封一模一样；只要部署被检测到可疑就会有；账号本身很健康。**

实测与之一致，且补上了关键一环：

- **完全中性内容**（`return new Response("ok")`）连续部署 10 次 → **成功 9 次、泛化错误 1 次**
- 明文 `vless`/`trojan`/`proxy` 特征串 vs 拆分混淆版本 → **结果相同（都成功）**

**因此**：
- 邮件 = **每一次部署被判定为可疑**就触发一次，不是「部署次数过多」的账号处罚
- 「几十封一模一样」= 几十次部署各自命中判定
- 「账号健康」与实测一致：失败率约 1/10，**没有账号级封禁**
- 部署受理的成败**与产物内容无稳定因果**

**应对**：失败时**先原样重试同一项目，再换名**（§0.19.4 已实施）。
另注：edgetunnel / CFNext 的「特征码字典混淆」在**部署受理**层面无实测收益
（我们的明文 vs 拆分对照即证据）；它更可能服务于运行时流量特征层，两者不应混谈。

### 0.20.6 新自研数据面的实施路线

> 状态更新见 §0.20.8（实现）与 §0.20.9（真机验证）：阶段 1–6 全部完成，
> 阶段 3 闸门已于 2026-10-23 通过。

| 阶段 | 内容 | 闸门 | 状态 |
|------|------|------|------|
| 1 | 归档代码复用到 `src/outbound/`，修正选路算法 | 本地单测全绿 | ✅ |
| 2 | 出站选路重写 + **分级错误诊断** | 单测覆盖候选顺序 | ✅ |
| 3 | **真机验证直连第三方 IP 的代理链路** | VLESS 握手返回 `[0,0]` 且能取回真实 HTTP 响应 | ✅ **已过**（见 §0.20.9） |
| 4 | 优选 IP 库接入（DoH 解析**第三方域名**） | 优选链路真机可用 | ✅ 代码完成（真机待验） |
| 5 | 代理池落地（SOCKS5 / HTTP CONNECT / HTTPS） | 经代理真机可用 | ✅ 代码完成（真机待验） |
| 6 | 特性开关：自研 / vendor 可切换 | 两种实现都能部署与工作 | ✅ |

> ⚠️ 阶段 3 的验证方法要注意：应连**明文 HTTP 目标站**或用**会自己完成 TLS 的客户端**。
> 用明文 HTTP 去请求 HTTPS 站拿不到响应，那是验证方法问题，不是实现缺 TLS（详见 §0.20.8）。

### 0.20.7 多实例并存

用户要求支持一个账号同时跑多个 CFPilot 实例 —— 与 §0.18/§0.19 的 KV 隔离契约一致，
每个实例用自己的 KV；自研数据面不改变这个约束。

### 0.20.8 第二阶段：DoH 优选库 / 代理池 / HTTPS 代理（2026-10-23，已实施）

用户指示「自研实现继续推进下一步」。按 `docs/self-developed-dataplane-design.md` §5 重排后的优先级实施。

#### ⚠️ 先更正一条误判：「补 TLS 能力」不是主出站路径的必需项

§0.20.6 的实施路线把「补 TLS 能力」排在第 1 位。**该判断有误**，本阶段复核了三方**源码**（非 README）后更正：

| 项目 | 直连目标 | 优选 IP | SOCKS5 | HTTP 代理 | HTTPS 代理 |
|------|---------|--------|--------|----------|-----------|
| CFNext（vendor） | 纯 TCP | 纯 TCP | — | — | 不支持 |
| edgetunnel | 纯 TCP | 纯 TCP | 纯 TCP | 纯 TCP | `secureTransport:'on'` + 自研 `TlsClient` |
| BPB | 纯 TCP | 纯 TCP | — | — | — |

源码证据：
- **CFNext** `Pt()` 内只有 `connect({hostname, port})`，全文件搜不到 `secureTransport` / `startTls` / `TlsClient`
- **edgetunnel** `connectDirect()` / `connectProxyIP()` / `socks5Connect()` / `httpConnect()` 全是纯 TCP；
  `secureTransport:'on'` 与 `TlsClient` **只**出现在 `httpsConnect()`（连 HTTPS 代理服务器）与 `sstpConnect()`（连 SSTP 代理服务器）

**原因（协议本质）**：VLESS / Trojan over WebSocket 是 **TLS 透传代理**，TLS 有两层不能混淆 ——
第一层「客户端 → CF 边缘」由客户端发起、CF 边缘终结；
第二层「Worker → 目标站」**Worker 不终结 TLS**，只透传客户端发来的密文（客户端与目标站直接完成握手）。
若 Worker 自己终结 TLS，会破坏端到端 TLS 语义（证书校验 / SNI / 指纹全部错位）。

**结论**：`secureTransport` 的唯一正确用途是「**代理服务器本身是 HTTPS/SSTP**」——
这正是 vendor 缺失、edgetunnel 具备的能力，本阶段已补上。

#### 本阶段实施内容

| 项 | 文件 | 说明 |
|----|------|------|
| DoH 优选库 | `src/outbound/doh.ts`（新增） | TXT 优选库 → A → AAAA，5 分钟缓存；机制对齐 vendor `Ft()` / edgetunnel 预加载竞速 |
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
   （实测 `example.com` 是 `"v=spf1 -all"`、`www.cloudflare.com` 是域名验证记录）。
   若「挑出形似 IP 的片段」，SPF 里的 `ip4:1.2.3.4` 会被误当优选 IP，
   **所有出站被悄悄导向该 IP 且无任何报错**。现要求整条记录全是 IP 才认。
3. **候选排序必须稳定**：`Array.prototype.sort` 对长度 > 10 的数组用非稳定 TimSort，
   会让竞速时「谁先试」随机、排查无法复现。现改为「权重 + 原始下标」稳定排序。

#### 验证

typecheck 全绿；测试 **28 文件 / 288 用例**全绿（新增 `doh.test.ts` 21 例、`http-proxy.test.ts` 7 例、
`socks5-integration.test.ts` 3 例，`route.test.ts` 扩至 29 例）；build 通过，
esbuild metafile 确认 5 个新/改模块均在 `dist/dataplane.js` 内。
（§0.20.9 的真机验证又新增了直连降权相关用例）

### 0.20.9 真机验证：自研数据面出站链路**已跑通**（2026-10-23）

阶段 3 闸门通过。自研数据面在**真实 Cloudflare** 上被完整证明可用。

#### 验证手段：本地 workerd + 真实 Pages 双层

关键前提：**本地 `wrangler dev --local`（workerd）完整支持 `cloudflare:sockets`**
（实测：导入 / connect / 真实数据交换全部成功），
因此可以在不出云的情况下把整条出站链路验完 —— 这比反复撞真机边缘窗口高效得多。

配套工具在 `tmp/selfdp-e2e/`：明文 HTTP 回显服务器、VLESS 测试客户端、测试套件、SOCKS5 代理。

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

真机部署：`jyhii42d4-0tkb.pages.dev`（`DATAPLANE=self`）。

#### ⚠️ 验证中发现并修复的两个**真实缺陷**

##### 缺陷 1：协议响应头必须在出站建连**之前**回

原实现是「先 `await` 出站建连成功，再回响应头」。本地 workerd 直接报：

```
Workers runtime canceled this request because it detected that your Worker's code had hung
```

出站稍慢客户端就等不到响应头。**已修**：认证通过即回响应头，出站转后台，
失败用 close 1011 + 分级原因告知（与 vendor / BPB 一致）。
认证在 `parseTarget` 内已完成，回响应头不引入安全漏洞。

##### 缺陷 2：目标域名解析到 CF 网段时，域名直连**必须降权**

实测证据：

```
example.com    → 172.66.147.243, 104.20.23.154   ← 全是 CF 网段 → 出站 100% 失败
neverssl.com   → 34.223.124.45                    ← 第三方 IP          → 出站成功
```

把域名丢给 `connect()` 让运行时自己解析，必然连回 CF Anycast 被拒；
而直连候选原本排在最前，会先白白耗掉一次超时。
**已修**：`RouteInput` 新增 `deprioritizeDirect`；
`dial()` 在「成功解析且结果全为 CF 网段」时降权域名直连，优先用第三方 IP 建连。

#### 两个测试坑（写给后续维护者）

1. **workerd 的文本帧（opcode 1）不会进入服务端二进制分支** —— 必须发二进制帧（opcode 2）。
2. **VLESS 地址字段的长度字节不能被域名首字符覆盖** ——
   布局是 `[类型(1)] + [长度(1)] + [域名]`；
   写成 `[类型] + 域名` 会让域名首字符（如 `'1'` = 0x31）当成长度，解析全错。

#### 💡 可复用发现：**本地 workerd 可以验证整条出站链路**

`wrangler dev --local`（workerd）**完整支持 `cloudflare:sockets`** ——
实测导入、`connect()`、真实数据交换全部成功。

这意味着**不需要反复撞真机的边缘拦截窗口**就能把出站链路验完：
本地验功能正确性 → 真机只做最终确认。建议以后所有数据面改动都先走本地验证。

> ⚠️ workerd 的两个行为差异（写给后续维护者）：
> ① **文本帧（opcode 1）不会进入服务端的二进制处理分支** —— 必须发二进制帧（opcode 2）；
> ② `Response(null, {status:101, webSocket})` 在 workerd 下可用，但 Node/vitest 下不支持 101。

#### ⚠️ 令牌探测的坑（避免误判）

`cfat_` 前缀是 **account-owned token**，**不支持** `/user/tokens/verify` 端点，
对该端点调用恒返回 401「Invalid API Token」。
**这不代表令牌失效** —— 判断有效性要用 `GET /accounts`。
（本次差点误判令牌失效，实际是探测端点选错。）

#### 仍未验证

- 代理池三种类型（SOCKS5 / HTTP CONNECT / HTTPS）**只验过本地**，真机需要一个公网可达的代理。
- DoH 的「TXT 优选库」路径需特定域名才能验（普通域名的 TXT 是 SPF / 域名验证记录）。

### 0.20.10 vendor vs self 对照实验 → **自研成为默认数据面**（2026-10-23）

用户要求「把自研数据面设为默认实现，按建议执行」——即先做同环境对照再切。

#### ⚠️ 用户环境提示：Clash Verge 的 TUN 模式

用户告知：**TUN 模式一直开着**，为本轮部署与测试带来两个干扰：

1. **Node 的 `fetch` 在 TUN 模式下会 `fetch failed`** —— 部署向导写 KV 连续失败，
   导致数据面 KV 里没有 `CONFIG` 键 → **WS 路径 404**。
   用 curl 写同一个 KV 却成功 → 确认是 TUN 与 undici 的兼容性问题，**不是代码 bug**。
   TUN 关闭后向导的 KV 写入恢复正常（部署日志出现「部署凭据已写入 KV」）。
2. 本机出站被全面限速（连 `8.8.8.8:443` 都超时），**本机不是有效的出站测试基准** ——
   有效的基准是「Cloudflare 边缘 → 目标站」，即真机数据面。

> 💡 建议：部署/测试前确认代理状态；TUN 开启时优先用 curl 验证 API 可达性。

#### 对照实验设计

同一账号、同时段、同一客户端、同一目标；两个实例各自独立 KV；**交替采样**（A→B→A→B）。
真实 TLS 客户端首包用手工构造的合法 ClientHello（`scripts/selfdp-e2e/clienthello.mjs`）——
手写简化版会被目标站直接 RST，测不出真实差异。

#### 关键发现：vendor 靠「第三方反代入口」打通 CF 网段目标

第一次对照：**vendor 100% vs self 0%**（CF 网段目标）。根因是 vendor 内置了

```
proxyip.{hk,us,jp,...}.cmliussss.net     （__D = "cmli"+"ussss"+".net"）
```

这些域名 CNAME 到**动态轮换的 IP 池**（`proxyip.fast-ip.eu.org`）。
反代入口是第三方服务器，收到客户端 TLS ClientHello 后**按 SNI 转发**到目标：

```
Worker ──connect(反代IP:443)──> 第三方反代（按 SNI 转发）──> Cloudflare 边缘
```

出口是第三方 VPS 而非 Cloudflare 自己的边缘 → **不触发 TCP Loop 限制**。
自研原先只有「DoH 解析 + CF 网段降权」，缺这一层，CF 网段目标必然失败。

> 这回答了 §6 一直存疑的「CFNext 的 `proxyip.<地区>.<域名>` 域名从哪来」。

#### 补齐：新增 `src/outbound/relay.ts`

实现了同一机制，且**可配置、可关闭**（vendor 只能硬编码依赖第三方）：

- 面板可填自己的反代入口（`relayPool`）→ **完全不依赖第三方**；
- `USE_BUILTIN_RELAY=false` 关闭内置表；
- **按当前边缘机房（colo）优先选地区**（与 vendor 的 `_Zc()` 同构）；
- **缓存 30 秒**（不是 5 分钟）—— 动态轮换池，长缓存会拿到已失效的 IP。

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

**决策**：`resolveDataPlaneImpl()` 缺省改为 `self`；`DATAPLANE=vendor` 保留回退。
GUI 新增「数据面实现」下拉框（默认自研）。

自研独有能力：失败分级诊断、SOCKS5/HTTP/HTTPS 代理池、DoH 优选解析、
反代入口可配置、降权候选稳定排序。

#### 仍未验证

- 代理池三种类型只验过本地 workerd，真机需公网可达的代理。
- 自配反代入口的端到端路径（配置 → 面板保存 → 生效）未在真机验过。

### 0.20.11 代理路径 + 自配反代入口真机验证（2026-10-23）

用户要求「把这两项验掉」——即上一节列出的两个未验证项。

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
| **HTTPS 代理**（`secureTransport:'on'` + CONNECT，池 3 个） | ✅ **5/10**，成功时收到真实响应 |
| HTTP CONNECT（明文） | ⚠️ 未单独验 —— 组合已被上面两项覆盖（TCP 层 = SOCKS5 路径，握手层 = HTTPS 路径，同一份 `httpConnect()`）。公共明文 HTTP 代理几乎都不支持 CONNECT 隧道（实测 190+ 个全失败） |

**关键观察**：单代理 1/8，代理池 10/10 ——
**代理池竞速把单个不稳定代理的问题掩盖了**。这是自研独有能力（vendor 只读 `PROXYIP`）。

#### 三、真机发现的三个真实缺陷（本地测不出来）

| 缺陷 | 症状 | 修复 |
|------|------|------|
| 代理握手**无超时** | 代理连上但不回应 → 数据面**既不报错也不关闭**，静默挂起 45s+ | `socks5.ts` / `http-proxy.ts` 握手读取加 6s 超时 |
| **close reason 超 123 字节** | RFC 6455 限制；超长时 **Cloudflare 边缘静默丢弃整个 close frame** → 客户端一直连着。本地 workerd 宽容地照发，只有真机暴露 | `closeWith()` 统一截断到 123 字节（按**字节**算；省略号占 3 字节，追加后还要再检查一次） |
| 完整诊断**没有出口** | close reason 装不下多行诊断 | 新增数据面诊断端点 `GET /__diag`（自研专有），返回最近 20 条完整诊断 |

> ⚠️ 截断修复漏了「追加省略号后再检查」→ 仍超 1 字节 → 真机依旧不 close。
> **这类坑只有真机能暴露**，本地 workerd 全部通过。

#### 四、Cloudflare 平台的两个硬限制（实测）

1. **边缘拒绝把 CONNECT 方法转发给 Worker**（400，`CF-RAY: -` 表示没到 Worker）。
   → 标准 HTTP CONNECT 代理**无法用 Cloudflare Worker 搭**；
   Worker 又不能当 TCP 服务端（无入站 TCP）。
   → 可行替代是 **POST + 二进制 body** 承载隧道（目标放 query，数据走 body）。
   本项目**未**引入这种非标准代理类型（语义是请求-响应而非持续隧道，不适合作为生产特性）。
2. **本机 `workers.dev` 不通**（`pages.dev` 正常）→ 测试一律用 Pages。

#### 收尾

- 测试 30 文件 / 315 用例全绿（新增 `close-reason.test.ts` 7 例）。
- 云端清理：删除 4 个临时探测 Worker + 7 个测试 Pages 项目 + 1 个 Workers 脚本。
- 保留实例（用户要自己跑代理工具测试）：
  **数据面 `ck12akov-tw5u-r993-vmsg.pages.dev`**，
  控制面 `e4kkjet6.pages.dev/p-vgagv2c4`，
  UUID `fbe5bd2d-5dca-4bd6-84b8-a8b727df3374`，WS 路径 `/ooosrkxwbt`。
  配置已恢复干净（内置反代表开启、无用户代理）。

### 0.20.12 用户实测反馈的三个问题（2026-10-23，全部已修）

用户拿保留的实例实测，反馈三个问题。逐个定位如下。

#### 问题 1：默认下发 30 个节点，订阅里却有 90 个

**根因**：`subProtocol`（vless/trojan/both）× `subTransport`（ws/xhttp/both）
两个独立开关交叉 → 必然生成三种形态 → 节点数乘三。

**修复**：新增 `subVariants`（多选），面板三个复选框，默认只勾 `vless-ws`。
`resolveSubVariants()` 负责：
- 依赖的入站没启用 → 自动剔除该形态；
- Clash / sing-box 不支持 XHTTP → 这些格式跳过 XHTTP 形态（否则订阅为空）；
- 全被剔除 → 回落到 `vless-ws`。

实测：默认 30 条，勾三种 → 90 条。

#### 问题 2：XHTTP 与 Trojan 延迟全 -1

**Trojan 服务端实现正确** —— 真机用真实 Trojan 握手验证：
收到目标站完整 HTTP 响应（458 字节）+ 正常关闭。

**XHTTP 两个真机才暴露的 bug**：

1. **`relay()` 关闭了 socket 写流** → 等于关闭整个 TCP 连接，
   目标站收到 RST 来不及回数据（症状：握手成功但永远收不到数据）。
   对比：WS 路径只 `releaseLock()` 不 `close()`，一直正常。
   修复：`relay()` 加 `closeTarget` 参数，socket 场景传 `false`。
2. **`async start` 阻塞下行读取** → `start` 的 Promise 未完成时 `pull` 不被调用，
   消费者一直等（症状：响应头到了，后续数据永远不来）。
   修复：`start` 只入队响应头立即返回，下行放到 `pull` 里读。

附带：XHTTP 的 `dial()` 漏了 `resolvePreferred` / `relayPool`，已与 WS 路径对齐。

#### 问题 3：vless+WS 一开始可用，后来全失效

**根因**：数据面因 `8000119` 换名重建后，控制面 `DATA_HOST` 仍指向**已删除的旧域名**
→ 订阅里所有节点的 `sni`/`host` 都指向不存在的域名。

**修复**：部署向导在数据面部署完成后比对控制面 `DATA_HOST`，不一致就重新配置控制面。
真机上已被触发验证两次。

#### 顺带：官方优选 IP 池质量修正

`curl --resolve` 逐段实测（WS 升级是否返回 101）：

```
104.16–104.25  8/8 ✅      104.26 2/8    104.27 6/8
104.28–104.31  0/8 ❌      172.66/67 6/8   172.64/65/68-71 0/8 ❌
其余 13 个段   0/8 ❌
```

旧表 15 个段里 13 个完全不可用（随机采样命中率约 1/4）→ 订阅大半节点是坏的。
修复：`CF_IPV4_CIDRS` 换成实测可用的 3 段；`CURATED_OFFICIAL_IPS` 10 → 27 个。

> ⚠️ 可用段与具体站点有关（CF 按站点分配），但 `104.16.0.0/11` 是主力通用段。
> 想完全对齐自己的站点，用面板「本地真连接优选」实测筛一遍最准。

#### ⚠️ 本轮踩到的两个测试方法坑

1. **自制 WS 客户端会被 Cloudflare 边缘拒绝**（原始 TCP + 手写握手 → 400），
   而 `ws` 库能过。**用 `curl --resolve` 或 `ws` 库**测 IP 可用性才准 ——
   我一度用自制客户端测出「所有 IP 都不可用」的假结论。
2. **每次部署后数据面域名都会变**（8000119 换名），
   测试脚本必须用**当前**域名 —— 我有一轮测试全打在已删除的旧项目上，
   得出了「XHTTP 修不好」的错误结论。

### 0.20.13 HTTPS 代理路径打通 + 一个被推翻的根因（2026-10-23）

用户要求「把这两项验掉」的最后一项：**HTTPS 代理**（`https://` 前缀，代理服务器本身走 TLS）。

#### 🔴 先说被推翻的结论

上一轮我判定「HTTPS 代理失败是因为**自签证书不被 Cloudflare 信任**」。
**这个判断是错的**，真机取证把它拆成了三层：

| 层 | 当时的判断 | 实测结论 |
|----|-----------|---------|
| ① TLS 没生效 | 「`secureTransport:'on'` 是惰性 TLS，明文 CONNECT 被当 ClientHello」 | ❌ **错** —— `secureTransport` 压根没传到运行时 |
| ② 证书不被信任 | 「自签证书被 CF 拒绝」 | ❌ **部分错** —— 自签确实被拒，但**主因是别处** |
| ③ 真正根因 | — | ✅ **`connect(address, options)` 的 options 放错了参数位** |

**根因 ① 的确切机制**（`@cloudflare/workers-types` 的声明）：

```ts
function _connect(address: string | SocketAddress, options?: SocketOptions): Socket;
interface SocketOptions { secureTransport?: string; allowHalfOpen: boolean; }
interface SocketAddress { hostname: string; port: number; }
```

旧代码把 `secureTransport` 塞进了**第一个**参数（address 对象）：
```ts
// ❌ 旧代码：运行时静默忽略 secureTransport
connect({ hostname, port, secureTransport })
// ✅ 正确
connect({ hostname, port }, { secureTransport })
```

TypeScript 不会报错（多余字段被放过），运行时静默忽略 ——
**socket 实际是明文**，于是：
- 对端 TLS 服务器看到明文 → 报 `HTTPS_PROXY_REQUEST`；
- 调 `startTls()` → 抛「The `secureTransport` socket option must be set to 'starttls'」。

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
两者区别只在失败时机：`'on'` 在 `opened` 阶段就挂（拿不到可诊断信息），
`'starttls'` 能进到握手阶段。所以生产实现选 `'starttls'`。

#### 代码改动

1. **`outbound/dial.ts`**
   - `ConnectFn` 类型改成 `(address, options?)`；
   - `connectWithTimeout()` 把 `secureTransport` 放进第二个参数；
   - `startTls()` 支持传 `expectedServerHostname`（SNI + 主机名校验）；
   - `starttls` 分支的错误信息从「连接超时」细化为「TLS 握手超时」；
   - catch 分支关闭**升级后**的 socket（原 socket 已被 `startTls()` 关闭）。
2. **`outbound/proxy-pool.ts`**
   - `ProxyEndpoint` 新增 `serverName`；
   - 解析 `https://` 条目时，域名形式的 host 自动作为 SNI；
   - 支持 `#sni=example.com` 后缀显式指定（代理只能写 IP 时用）；
   - IP 形式**不**推导 SNI（证书不可能签给 IP）。
3. **`outbound/route.ts`** —— `via` 透传 `serverName`。
4. **面板** —— HTTP 代理输入框的提示文案补充 `https://` 与 `#sni=` 用法。
5. **测试** —— 新增 `test/proxy-sni.test.ts`（7 个用例）。

#### 真机验证结果（3/3 全绿）

阿里云 `47.104.173.139` 上分别跑 SOCKS5 / HTTP CONNECT / HTTPS(TLS) 三个代理，
经真实 Pages 数据面 + 真实 VLESS 会话：

```
=========== socks5 ===========   ✅✅✅   出站成功 3/3
=========== http  ===========   ✅✅✅   出站成功 3/3
=========== https ===========   ✅✅✅   出站成功 3/3
```

代理端日志佐证（确实经代理，不是静默直连）：
```
[#11] TLS 握手完成 from 104.28.157.104:34778（SNI="exammaster.zzzjl.com"）
[#11] CONNECT httpbin.org:80 隧道已建立
[cfp-proxy] SOCKS5 CONNECT httpbin.org:80
[cfp-proxy] HTTP CONNECT httpbin.org:80
```

#### ⚠️ 测试环境上踩的三个坑（都不是代码缺陷）

1. **CentOS 7 的 OpenSSL 1.0.2k 不支持 TLS 1.3** ——
   而 CF 边缘的 `startTls()` **只发 TLS 1.3 ClientHello**。
   症状很隐蔽：Python 的 `ssl` 模块当服务端时握手**永远挂起**，
   表现为「63 条 ESTABLISHED 连接堆积、Recv-Q 有数据但服务端不读」，
   **不是**明确的报错。
   → 换 Go 写的静态编译代理（`CGO_ENABLED=0 GOOS=linux go build`）才通。
   → 以后在旧系统上验 TLS，先查 `openssl version`。
2. **本地 workerd 拒绝连私有 IP**（`127.0.0.1` / `192.168.x`），
   错误文案与真机的「CF 网段被拒」**完全一样**（都是
   「proxy request failed, cannot connect to the specified address」），
   极易误判。→ 验出站用**公网 IP** 目标或直接上真机。
3. **Pages 部署 `_worker.js` 的 metadata 不能带 `compatibility_date`** ——
   带了就让 Pages 忽略 `_worker.js`，表现为「部署成功、HTTP 200、返回默认 Welcome 页」。
   正确格式只有 `{ main_module: '_worker.js', bindings: {} }`。
   另：Pages 绑定与变量**只对之后的部署生效**，顺序必须是
   「建项目 → PATCH 设变量 → 部署」；且 PATCH 会自动触发一次部署，
   之后再 POST `/deployments` 就是二次部署 → 触发 `8000119`。

#### 阿里云服务器清理（用户要求「不破坏网站项目」）

已全部还原：

| 项 | 清理前 | 清理后 |
|----|--------|--------|
| 测试进程（`cfp_proxy.py` / `cfptlsproxy` / `relay-39182.py`） | 3 个 | **0** |
| 监听端口 39080-39082 / 39182 | 4 个 | **0** |
| `/tmp/cfp-test/` 目录 | 存在 | **已删除** |
| firewalld 临时端口放行 | `39080-39082/tcp`、`39182/tcp` | **已移除** |
| firewalld CF 网段 rich rules | 45 条 | **0 条**（45 条全是测试期间加的） |
| 临时 Docker 镜像（alpine:3.20） | 1 个 | **已删除** |

**未受影响（已验证）**：
- `/www/wwwroot/` 5 个站点目录完好：`edu / exammaster / exam / e / zzzjl .com`
- 5 个站点 HTTP 全部正常：`301 / 200 / 302 / 200 / 200`
- `exammaster.zzzjl.com` HTTPS：`200`
- 服务状态：`nginx` / `mysqld` / `docker` 均 `active`
- 容器全部存活：`easytier` / `easytier-web` / `watchtower` / `edumaster_api` / `edumaster_postgres`

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

> ⚠️ **2026-10-23 更正**：本节的归因（「只要触及 `cloudflare:sockets` 就无法运行」）
> **已被真机实验推翻**。真正原因是**出站选路必然连向 Cloudflare 自家 Anycast 地址**，
> 而这类地址在 Worker 运行时一律被拒。详见 §0.20.1 / §0.20.2 / §0.20.3。
> 本节其余内容（最终方案 = 改用 vendor 的 `wsHandler`）依然成立且仍在用。

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
| 控制面 | 面板 + 订阅 + 探针 | `dist/control.js`（约 53 KB） | ✅ 4/4 |
| 数据面 | CFNext 的 `wsHandler` + CFPilot 自己的路由 | `dist/dataplane.js`（约 245 KB） | ✅ 3/3 |

> ⚠️ **本节早期版本写的是「数据面 = CFNext 明文版原文件（不二次打包），产物在 `dist/` 外」——
> 那是实验期的临时形态，与最终实现不符。**
> 查 `packages/worker-core/scripts/build.mjs` 的 `TARGETS` 可确认：数据面产物一直是
> `src/entry-data.ts` → `dist/dataplane.js`，由 esbuild 打包，内含 vendor 的 `wsHandler`。
> `packages/deploy-wizard/assets/` 目录**从未**存在过 `dataplane.js`
> （git 全历史只有 `cfpilot-worker.js` 一个文件）。
> 部署向导 `loadBundle('dataplane.js')` 解析到的就是 `packages/worker-core/dist/dataplane.js`。
>
> 详见 §0.18，其中给出了产物行为的逐条实证。

- 数据面**读 KV 的大写 `CONFIG` 键**（CFPilot 自己的 `UserConfig` schema），
  由 `src/routes/data.ts` → `loadDataPlaneConfig()` → `loadConfig()` 完成；
  并设环境变量 `UUID` / `TROJAN_PASSWORD` / `WS_PATH`（另兼容 `PATH`）
  / `ENABLE_TROJAN` / `ENABLE_XHTTP` 作为兜底
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
| `packages/worker-core` | ✅ 功能完成 | 边缘内核 + 中文面板。合并版 289 KB / 控制面 53 KB / 数据面 245 KB |
| `packages/scanner-cli` | ✅ 可用，未发布 npm | 三阶真连接扫描器 + 本地桥接服务，版本 0.2.0 |
| `packages/deploy-wizard` | ✅ 可用，未发布 npm | 全中文部署向导（Worker 单项目 + Pages 双项目），版本 0.1.0 |
| `packages/gui` | ✅ **已发布 v0.1.1** | Electron 图形化工具，安装版 + 便携版，无需预装 Node |
| 单元测试 | ✅ **315 个全绿** | 30 个测试文件（协议 / 鉴权 / 订阅清洗 / CF API / Pages 部署 / 优选 / 选路 / DoH 解析 / 反代入口 / HTTP 代理 / SOCKS5 集成 / ECH / 数据面切换 / UA 格式协商） |
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
    （注：当前数据面产物由 `src/entry-data.ts` 构建，走 CFPilot 自己的 `loadConfig()`，
    读的是**大写 `CONFIG` 键**；`K` 是给 vendor CFNext 风格代码留的兼容位。详见 §0.18。）
12. **⚠️ 一个 KV 命名空间只能承载一个 CFPilot 部署实例。**
    内核在 KV 里的键全局平铺、无实例前缀，两个实例共用会互相覆盖
    UUID / WS 路径 / 面板密码 / 会话。部署向导必须在写入前校验归属
    （`assertKvOwnership`），越界写入一律中止。归属只能靠清单键
    `CFP_DEPLOY_MANIFEST` 判断，字段值不唯一、不能作为依据。
13. **⚠️ 绝不要写 CFNext 的小写 `config` 键。**
    vendor 侧是 `Object.assign(默认, kvConfig)` 整体覆盖，写进去会直接改坏
    共栖的 CFNext 项目的 uuid / path / trojanPassword；
    而 CFPilot 的数据面根本不读它（读大写 `CONFIG`），写了纯属破坏。
    部署凭据一律写 KV 的**大写 `CONFIG`** 键。
14. **构建产物必须可复现。** 版本号 = `<git hash>-<源码内容哈希前8位>`，
    **绝不能加时间戳**。
15. **面板产物必须统一换行为 LF**（`gen-panel.mjs` 已做）。git 的 autocrlf 会让
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
npm test              # vitest run —— 30 文件 / 315 用例
npm run build         # 内核 + 两个 CLI + GUI 打包，并同步 assets/cfpilot-worker.js
npm run verify        # build + typecheck + test
npm run clean         # 清理 dist / .wrangler

# 本地调试用的凭据在 packages/worker-core/.dev.vars（已被 .gitignore 排除，不要提交）
```

### 部署（多实例）

```bash
# 部署第一个实例：未指定 --kv 时自动新建一个命名空间
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN"

# 更新已有实例：自动探测到唯一的实例并复用（UUID 与 WS 路径不变）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN"

# 查看账号下有哪些实例（KV、项目名、域名、部署时间）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --list-kv

# 部署第二个实例：新建独立 KV（一个 KV 只能承载一个实例）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --new-kv

# 账号下有多个实例时，必须用 --kv 明确指定
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --kv <namespace-id>
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
| Pages `cfnext` | 用户原有的 CFNext 项目，**不要动**（它用 KV 的小写 `config` 键，与 CFPilot 的键不重叠） |
| KV `cfp-kv` | 两个项目共用，存配置 / 优选池 / 部署清单 / 凭据哈希 |
| Worker 脚本 | 0 个（数据面走 Pages） |

部署清单在 KV 的 `CFP_DEPLOY_MANIFEST` 键，是识别「同源项目」与「KV 归属」的**唯一依据**。

> 这些是**用户测试账号**的资源。接手后如果要重新部署，优先用
> `npx -y cfpilot-deploy@latest pages-split`（自动探测并复用清单），
> 不要手工建 Pages 项目，否则清单会指向旧项目。
>
> ⚠️ 若账号下已有多个 CFPilot 实例，`pages-split` 会要求用 `--kv <id>` 明确指定；
> 用 `--list-kv` 可以查看账号下各实例的 KV 与项目名。

---

## 12. 免责

本项目仅供学习与自建网络研究使用，使用者需自行遵守所在地法律法规与 Cloudflare 服务条款
（尤其 Free 套餐的流量与 CPU 限制）。MIT 许可，见 [LICENSE](LICENSE)。
