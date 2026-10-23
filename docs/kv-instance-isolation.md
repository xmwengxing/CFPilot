# KV 实例隔离与部署归属校验（设计 + 实施记录）

> 日期：2026-10-22　｜　状态：**已实施**
> 背景：部署向导 / GUI 的「自动检测 KV」逻辑在多项目场景下会误复用他人命名空间。
>
> 实施过程中还查清了数据面产物的真实行为，推翻了本文初稿的若干前提，
> 详见 [HANDOVER.md §0.18](../HANDOVER.md) 与本文 §5。

---

## 0. 一句话结论

**需要调整。** 根因不是「检测算法不够聪明」，而是当前用「探测字段值」回答「这个 KV 属于谁」——而字段值不具备唯一性，且 KV 内所有键全局平铺无实例前缀。

正确方向：把「一个 KV 命名空间 = 一个部署实例」从**隐式契约**升级为**显式契约 + 可校验契约**，并让归属由**用户显式选择**、由**部署前校验**兜底。

---

## 1. 现状：三处行为不一致

### 1.1 CLI：`--kv` 不传就新建 → 「自动识别复用清单」从未生效

`packages/deploy-wizard/src/cli.ts:183-189`

```js
if (!kvId) {
  const title = flagString(args, 'kv-title') || `cfpilot-kv-${Date.now().toString(36)}`
  const ns = await client.createKvNamespace(resolvedAccount, title)
  kvId = ns.id
}
```

「首次还是更新」的判据是读该 KV 的 `CFP_DEPLOY_MANIFEST`（`pages-deploy.ts:457`）。
新建的 KV 必然没有清单 → **永远首次部署** → UUID / WS 路径每次重新生成 → 客户端订阅地址每次都变。

与以下两处自相矛盾：

- CLI 帮助文本（`cli.ts:132-137`）：「更新部署：KV 里有清单 → 自动找到同源项目、沿用 UUID 与 WS 路径…… 你不需要记项目名」
- `HANDOVER.md` §0：「更新部署：沿用原 UUID 与 WS 路径，**客户端订阅地址不用改**」

> 该承诺目前仅在用户手动传 `--kv <id>` 时成立。

### 1.2 GUI：盲选 + 落盘锁定 + 无法修改

`packages/gui/src/main/bridge.ts:263-276`

```js
let kvId = secrets.kvNamespaceId.trim()
if (!kvId) {
  const namespaces = await client.listKvNamespaces(account.id)
  if (namespaces.length > 0) {
    kvId = namespaces[0]!.id          // 无脑取第一个
  } else {
    const created = await client.createKvNamespace(...)
  }
  saveSecrets({ accountId: account.id, kvNamespaceId: kvId })
}
```

| # | 问题 | 位置 |
|---|---|---|
| G1 | 取 `namespaces[0]`，不判断是否属于 CFPilot | `bridge.ts:268` |
| G2 | 账号内只要有 ≥1 个 KV，GUI 就**永不新建** | `bridge.ts:267-274` |
| G3 | 落盘即锁定，UI 只读无修改入口 | `index.html:243`（`<span id="detKv">`） |
| G4 | `saveCredentials` 支持 `kvNamespaceId`，但 renderer 从不传 → 死通路 | `renderer.ts:75-78` |
| G5 | 换 Token 后 `accountId` 永不更新（`saveSecrets` 只在 `if (!kvId)` 内） | `bridge.ts:275` |
| G6 | 不检测则报「尚未保存 KV 命名空间 ID」→ 无法部署 | `bridge.ts:156-159` |

### 1.3 「首次部署」在共用 KV 下是破坏性操作

`pages-deploy.ts:507` 的 `fresh` 模式只**跳过读清单**，但后续仍然：

- `writeManifest` 覆盖共栖者的 `CFP_DEPLOY_MANIFEST`（`pages-deploy.ts:652-670`）
- `syncDataPlaneKvConfig` 覆盖共栖者的 `config` 键（`pages-deploy.ts:368-419`）

即：`fresh` 不是「隔离」，是「覆盖」。

---

## 2. 共用 KV 的风险分级

### 2.1 不同 KV 之间字段值相同 → **无风险**

KV 命名空间是硬隔离的，`namespace_id` 不同则毫无关系。清单、凭据各存各的。
用户担心的「多个项目使用多个 KV 空间」本身是安全的。

### 2.2 同一 KV 被两个 CFPilot 部署共用 → **有风险**

| 键 | 冲突后果 |
|---|---|
| `CFP_DEPLOY_MANIFEST` | 单键。后部署覆盖先部署；再更新时会把 A 的项目名当成自己的 → **覆盖 A 的 Pages 项目** |
| `CONFIG`（大写） | uuid / WS 路径 / 面板凭据 / 优选池 / 代理池 整体串味 |
| `PANEL_PATH` / `ADMIN_PW_HASH` | 面板路径与密码互相覆盖 |
| `LOCAL_PREFERRED_IPS` | 优选池互相清空 |
| `SESSION:*` / `ONETIME:*` | 会话令牌跨实例可复用 |

### 2.3 同一 KV 被 CFPilot 与既有 CFNext 项目共用 → **严重**

向导写的小写 `config` 键正是 CFNext 数据面的配置键。vendor 内：

```js
const a = await t.K.get("config", { cacheTtl: 30 })
if (a) { const t = JSON.parse(a); Object.assign(e, t) }   // ← 整体覆盖
```

`Object.assign` 是**整体覆盖**语义。向导写入的 `uuid` / `path` / `trojanPassword`
会把该项目原有的值直接改掉 → **该项目的代理链路当场失效**。

而 `HANDOVER.md` §11 明确记录线上存在「Pages `cfnext` —— 用户原有 CFNext 项目，**不要动**」。
GUI 的 G1（盲选 `namespaces[0]`）恰好可能选中它使用的命名空间。

> 注意：写坏不需要被读到才会生效。**写方污染读方**同样成立。

### 2.4 数据面产物口径不一致（**已查清**，见 §5）

初稿写作时这里存疑：「数据面到底读不读小写 `config` 键」。
**实施阶段已用产物级证据查清**：

- 数据面产物是 `dist/dataplane.js`（`entry-data.ts` 构建），**不是** CFNext 原版文件；
- vendor 导出的 `wsHandler` 签名是 `Gt(request, config)`，**既不读 KV 也不读 env**；
- CFNext 自己的配置加载器 `lt(env)` 被 esbuild tree-shaking 移除。

**因此小写 `config` 键在当前路径下数据面并不读取** ——
`syncDataPlaneKvConfig` 属于纯粹的有害冗余：它不产生任何效果，
却会**污染共栖的 CFNext 项目**（见 2.3）。已删除。

---

## 3. 根因陈述

> 「KV 是谁」不能用探测字段值来回答。字段值（标题、uuid、路径）不唯一，
> 且 KV 内所有键平铺无实例前缀，因此**「一个 KV = 一个部署实例」只能是契约，不能是探测结论。**

---

## 4. 方案

### 4.1 设计原则

1. **契约显式化**：一个 KV 命名空间 ↔ 一个 CFPilot 部署实例（控制面 + 数据面）。这是 CFNext `config` 键无法加前缀所决定的硬约束（vendor 键名固定），不应试图让一个 KV 承载多实例。
2. **归属由用户选择**：工具列出候选并展示证据，归属由人确认，不由工具猜。
3. **部署前强制校验**：越界写入一律中止，不靠事后排查。
4. **检测是辅助，不是决策**：探测只用于**展示信息**与**发现可复用对象**，不用于自动锁定。

### 4.2 推荐路径（改动小、直击痛点）

#### A. CLI：缺省改为「探测 → 复用唯一候选 → 否则显式指定」

```
--kv 缺省时：
  1. 列出账号下所有 KV
  2. 逐个探测 CFP_DEPLOY_MANIFEST
  3. 命中数 = 0  → 新建 KV（标题带可识别前缀）
     命中数 = 1  → 复用该 KV，进入更新模式（沿用 UUID / WS 路径）
     命中数 ≥ 2  → 非交互模式报错要求 --kv 指定；交互模式列出候选让用户选
```

> 这才是帮助文本承诺的「自动识别并复用清单」的真实实现。
> 探测成本：每次一次 KV list + N 次 KV get（N 通常 < 50）。

#### B. GUI：KV 从「自动锁定的隐式值」改为「显式可选的表单字段」

- 凭据页新增 **KV 选择器**：
  - 下拉列出账号下所有 KV，每项标注：`标题 · 是否含 CFPilot 部署 · 清单里的项目名 / 域名`；
  - 提供「**新建 KV**」按钮（标题自动生成 `cfpilot-<项目名>-<时间戳>`）；
  - 提供**手填 KV ID** 输入框（支持从别处导入）。
- `detectAccount` 拆分职责：
  - `detectAccount()` → 只解析账号（保留现状）；
  - `listKvOptions()` → 返回候选 KV 及其归属证据，供下拉渲染；
  - **不再自动 `saveSecrets(kvNamespaceId)`**，改由用户选中后再落盘。
- 打通死通路：`renderer` 保存凭据时一并提交 `kvNamespaceId`（preload / globals 已就绪，只差 renderer 传值）。
- 修正 G5：每次检测都更新 `accountId`。
- 解除 G6 死锁：未选 KV 时部署按钮给出明确指引（而非笼统报错），并允许「就地新建 KV」。

#### C. 部署前归属校验（防串的核心）

在 `deployPagesSplit` 写入任何键**之前**执行 `assertKvOwnership()`：

| 目标 KV 状态 | 判定 | 动作 |
|---|---|---|
| 空（无任何 CFPilot/CFNext 键） | 全新 | ✅ 放行 |
| 含 `CFP_DEPLOY_MANIFEST`，项目名 == 本次目标 | 同实例更新 | ✅ 放行（沿用凭据） |
| 含 `CFP_DEPLOY_MANIFEST`，项目名 ≠ 本次目标 | **他人实例** | ❌ **中止**，提示该 KV 已被 X 占用，请改用其他 KV 或 `--force` |
| 含 `config` 但无 CFPilot 清单 | **疑似他人在用**（如 CFNext 项目） | ❌ 中止并警告「写入 config 会整体覆盖其配置」，需显式 `--force` |
| 含大写 `CONFIG` 但无清单 | 疑似残留 | ⚠️ 警告，放行 |

`--force` 语义收紧为「明知会覆盖仍然继续」，并在日志中逐条打印被覆盖的键。

#### D. `fresh` 模式语义修正

`fresh` = 全新实例 ⇒ 必须绑定**全新的 KV**，而非在旧 KV 上覆盖。
若目标 KV 已含清单：`fresh` 应直接拒绝并提示「该 KV 已被占用，fresh 模式请指定新 KV / 使用新建按钮」。

### 4.3 备选 / 不推荐

| 方案 | 判断 |
|---|---|
| 一个 KV 承载多实例（键加实例前缀） | ❌ 不可行。vendor 读固定键名 `config`，加前缀后数据面读不到；且需改 vendor（AGENTS.md 明令「原样引入，勿改」） |
| 继续加启发式探测（按标题前缀匹配 `cfpilot-` 等） | ❌ 不推荐。仅降低误判概率，不消除；且会与用户自建标题冲突 |
| 部署后回滚 KV 写入 | ❌ 不推荐。KV 无事务，且部分写已生效时无法回滚 |

### 4.4 建议的契约落文

在 `AGENTS.md` 增加一条铁律：

> **一个 KV 命名空间对应且仅对应一个 CFPilot 部署实例。**
> 控制面与数据面共用同一 KV 属于**同一实例**，是允许的；
> 不同部署实例之间**必须**使用不同 KV。部署向导在写入前必须校验归属，
> 越界写入一律中止。

---

## 5. 实施中发现的额外事实（初稿前提被推翻）

初稿基于「数据面读 KV 的小写 `config` 键」这一假设，**该假设是错的**。
实测结论：

1. **数据面产物是 `dist/dataplane.js`**（`src/entry-data.ts` 构建，内含 vendor 的 `wsHandler`），
   不是「CFNext 原版文件、不二次打包」。`packages/deploy-wizard/assets/` 在 git 全历史里
   从未存在 `dataplane.js`。
2. **vendor 导出的 `wsHandler` 签名是 `Gt(request, config)`**：
   体内 `t.K` 出现 0 次、`get("config")` 出现 0 次 —— **既不读 KV 也不读 env**，
   只吃传进来的配置对象。CFNext 自己的配置加载器是另一个函数 `lt(env)`，
   只被 vendor 内部的默认 fetch 处理器调用；本项目只 import 了 `wsHandler`，
   因此 `lt` 被 esbuild **tree-shaking 整个移除**（产物里 `WARP_ENDPOINTS` /
   `MASQUE_SNI` / `YXURL` / `HOME_WAN` / `OUTBOUND` / `ALPN` 等特征串全为 0）。
3. **因此数据面走 CFPilot 自己的 `loadConfig()`，读的是大写 `CONFIG` 键**，
   路径路由也由 `src/routes/data.ts` 用 `config.wsPath` 判断。
4. 由此暴露两个真实缺陷并已修复：
   - 向导写的小写 `config` 键**数据面根本不读**，写了没用，
     却会**整体覆盖**共栖 CFNext 项目的配置（vendor 侧 `Object.assign` 整体覆盖）；
   - 内核的**环境变量层有缺口**（违反 AGENTS.md 铁律 1）：
     `configFromEnv()` 原本只读 `env.UUID`，`wsPath` 写死 `/vless`、
     `trojanPassword` 写死空串、`enableTrojan`/`enableXhttp` 写死 `true`，
     导致向导注入的数据面环境变量**全是死的**。

---

## 6. 实施记录（2026-10-22）

### 6.1 实际改了什么

| 文件 | 改动 |
|------|------|
| `packages/deploy-wizard/src/pages-deploy.ts` | 新增 `assertKvOwnership()` / `inspectKvOwnership()` / `listCfPilotNamespaces()`；`fresh` 模式改为要求未被占用的 KV；**删除** `syncDataPlaneKvConfig()`（写错了键），改为 `writeEffectiveConfig()` 写大写 `CONFIG` 键；新增 `force` 选项 |
| `packages/deploy-wizard/src/cli.ts` | `--kv` 缺省改为探测复用唯一候选；新增 `--new-kv` / `--list-kv` / `--force-kv`；多个实例时要求 `--kv` 明确指定 |
| `packages/worker-core/src/config.ts` | 补齐环境变量层：`WS_PATH`/`PATH`、`TROJAN_PASSWORD`、`ENABLE_TROJAN`/`TROJAN`、`ENABLE_XHTTP`/`XHTTP` |
| `packages/worker-core/src/types.ts` | `Env` 补齐上述变量声明 |
| `packages/gui/src/main/bridge.ts` | `detectAccount()` 只解析账号（不再盲选 KV、不再落盘锁定）；新增 `listKvOptions()` / `createKvNamespace()`；`runDeploy()` 支持 KV 覆盖与 `forceKv`；修正 `accountId` 不更新 |
| `packages/gui/src/main/main.ts` | 新增 `kv:list` / `kv:create` IPC |
| `packages/gui/src/preload/preload.ts`、`globals.d.ts` | 暴露新 API 与类型 |
| `packages/gui/src/renderer/index.html`、`renderer.ts` | 凭据页新增 KV 下拉（含归属标注）、「新建 KV」、「刷新列表」、「手动指定 ID」、「保存选择」；部署页显示本次使用的 KV 并新增「覆盖 KV 归属校验」选项 |
| `AGENTS.md` | 新增铁律：「一 KV 一实例」「绝不写小写 `config` 键」 |
| `HANDOVER.md` | 新增 §0.18 实证章节；更正 §0 关键约束、§0.10、§6 铁律、§7 命令、§11 线上环境 |
| `README.md`、`packages/gui/README.md` | 同步部署流程与 KV 语义 |

### 6.2 归属判定最终行为

| 目标 KV 状态 | 判定 | 行为 |
|---|---|---|
| 空 | `empty` | ✅ 放行 |
| 清单属于本次目标 | `owned` | ✅ 放行（原地更新，沿用凭据） |
| 清单属于**另一个**实例 | `occupied` | ❌ **中止**（`--force-kv` / GUI 勾选可强推） |
| 含 CFNext 的 `config` 键 | `foreign` | ⚠️ **只提醒不阻断** |
| 含 `CONFIG` 但无清单 | `stale` | ❌ 中止（残留配置） |

`foreign` 之所以不阻断：CFPilot 读写的键（`CONFIG` / `PANEL_PATH` / `SESSION:*` / …）
与 CFNext 读写的键（`config` / `usageColo` / `initPool` / …）**完全不重叠**，
且本项目不再往小写 `config` 写任何东西，两者可以安全共存。
这直接支撑了「用户已有原版 CFNext Pages ≈ 多实例共存」的需求。

### 6.3 多实例使用方式

**CLI**

```bash
# 部署第一个实例（自动新建 KV）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN"

# 更新（自动探测到唯一实例并复用；UUID 与 WS 路径不变）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN"

# 查看账号下有哪些实例
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --list-kv

# 部署第二个实例（独立 KV）
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --new-kv

# 多个实例并存时必须明确指定
npx -y cfpilot-deploy@latest pages-split --token "$TOKEN" --kv <id>
```

**GUI**：凭据页点「新建 KV」为每个实例各建一个，分别选中后部署。


---

## 7. 改动清单

| # | 文件 | 改动 | 验收标准 |
|---|---|---|---|
| 1 | `deploy-wizard/src/pages-deploy.ts` | 新增 `assertKvOwnership()`，在写入前调用 | 共用 KV 时中止且给出可执行提示 |
| 2 | `deploy-wizard/src/pages-deploy.ts` | `fresh` 模式拒绝已占用的 KV | fresh + 已占用 KV → 中止 |
| 3 | `deploy-wizard/src/cli.ts` | `--kv` 缺省改为探测复用；命中 ≥2 要求显式指定 | 连续两次 `pages-split` 第二次走更新模式，UUID 不变 |
| 4 | `deploy-wizard/src/cf-api.ts` | 新增 `listKvNamespaces` 分页与 `getKvValue` 复用 | 单账号多 KV 时候选完整 |
| 5 | `gui/src/main/bridge.ts` | `detectAccount` 拆分；新增 `listKvOptions()`；修 accountId 不更新 | 账号切换后部署账号随之切换 |
| 6 | `gui/src/main/bridge.ts` | 新增「新建 KV」与「手填 KV ID」通路 | GUI 能为新项目开干净 KV |
| 7 | `gui/src/renderer/renderer.ts` | 提交 `kvNamespaceId`；新增 KV 下拉与新建按钮 | 检测结果可改、可保存 |
| 8 | `gui/src/renderer/index.html` | KV 选择控件 UI | 「检测结果」不再是只读 span |
| 9 | `gui/src/main/bridge.ts` | 部署前归属校验提示 | 误选 KV 时给出明确阻断 |
| 10 | `packages/deploy-wizard/test/pages-deploy.test.ts` | 补归属校验 / fresh 拒绝 / CLI 探测用例 | 新增用例全绿 |
| 11 | `AGENTS.md` / `HANDOVER.md` | 落文「一 KV 一实例」契约；修正 §0 更新部署表述 | 文档与实现一致 |
| 12 | `README.md` | 说明 KV 选择与 `--kv` 语义 | 用户可预期行为 |

**提交前必须通过**：`npm run typecheck && npm run test && npm run build`（AGENTS.md §4）。

---

## 8. 两个待澄清问题的结论（已解决）

1. **数据面产物到底是哪一个？** → 已查清：**`dist/dataplane.js`**（`entry-data.ts` 构建，
   内含 vendor 的 `wsHandler`），不是 CFNext 原文件。详见 §5.1。
   连带结论：小写 `config` 键数据面不读 → `syncDataPlaneKvConfig` 已删除，改为写大写 `CONFIG`。
2. **是否需要支持「一个账号同时跑多个 CFPilot 实例」？** → **需要，已实现**。
   每个实例一个独立 KV；CLI 提供 `--new-kv` / `--list-kv` / `--kv`，
   GUI 提供下拉选择 + 「新建 KV」。用户已有的原版 CFNext Pages 项目与 CFPilot
   键不重叠，可共存（判定为 `foreign`，只提醒不阻断）。

---

## 9. 免责

本项目仅供学习与自建网络研究使用，使用者需自行遵守所在地法律法规与 Cloudflare 服务条款。



---

## 10. 后续追加（2026-10-23）

同一天又完成三件事，详见 [HANDOVER.md §0.19](../HANDOVER.md)：

| # | 事项 | 结论 |
|---|------|------|
| 1 | **Clash Verge 导入失败** | 根因不是 YAML 模板，而是**订阅格式只看 URL 参数、不看 User-Agent**。已加 `resolveFormatByUserAgent()` |
| 2 | **Clash YAML 模板** | 模板语法合法，但 `external-controller` 会与客户端端口冲突、`port`/`socks-port` 非 mihomo 字段、缺 `dns` 段。已修 |
| 3 | **ECH 特性** | 参考 edgetunnel 实现，**默认关闭**；三种订阅格式都注入对应参数 |
| 4 | **8000119 归因更正** | 真机对照实验证明它是**间歇性**的账号级风控，与内容/配置无稳定因果。已把部署重试改为「先原样重试同一项目 3 次，再换名」 |

第 4 条对本文件的意义：**「一 KV 一实例」的契约不受影响**（那是内核 KV 键平铺导致的硬约束），
但**失败重试策略**必须改 —— 换名之前先同名重试，否则会留下用不上的空项目。
