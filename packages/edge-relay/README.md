# edge-relay —— 盲中继 / 云监测台 权威源码

本目录是 **CFPilot 盲中继 / 云监测台工程的唯一权威源码**（见 `docs/mesh-integration-plan.md` Phase 0）。

## 权威关系

```
packages/edge-relay/          ← 权威（唯一可手改的地方）
      │  scripts/sync-edge-relay.mjs
      ├──> CFPilot/edge/           同步副本（禁止手改）
      └──> MobiHop/edge/           同步副本（禁止手改）
```

- MobiHop 的核心是组网；**CF 平台部署的权威在 CFPilot**（两仓库同属一个 GitHub 账户）。
- MobiHop 侧 `edge/` 保留实体文件以兼容其 README / 部署脚本 / 文档的既有路径引用，
  但内容由本目录同步，**不得在 MobiHop 侧直接修改 edge/**。
- 品牌保留 MobiHop（用户决策），协议魔数 / Noise 模式 / 日志前缀均为协议身份，不改。

## 文件清单与漂移校验

`FILELIST.json` 记录 16 个权威文件的 SHA256。`scripts/check-edge-relay.mjs` 已挂进
`npm run verify`，校验三处（权威 / CFPilot/edge / MobiHop/edge）逐字节一致。

```bash
node scripts/check-edge-relay.mjs             # 校验（verify 自动跑）
node scripts/check-edge-relay.mjs --write     # 正式改源码后刷新哈希清单

node scripts/sync-edge-relay.mjs              # 从权威同步到两处副本
node scripts/sync-edge-relay.mjs --dry-run    # 预览同步动作
```

⚠️ 改权威源码的正确顺序：**先改本目录 → 跑 sync → 跑 `--write` 刷新清单 → `npm run verify`**。
直接在 `edge/` 副本里改会被 verify 判为漂移而失败。

## 参数化

见 [ADAPTERS.md](./ADAPTERS.md)：Phase 0 只文档化适配点（不改协议源码），
实际参数注入在 Phase 1（CF API 的 D1/DO 原语）与 Phase 2（CLI/GUI 部署命令）实现。

## 工程内容（原样来自 edge/）

- `deploy-cf.ps1`：统一部署向导（Worker 盲中继+监测 API / Pages 面板 / 协议验证）。
- `deploy-cf-monitor-dashboard.ps1`：监测面板 Pages 部署（`__MONITOR_API__` 占位替换）。
- `deploy-cloud-console.ps1`：云控制台 SPA 部署（**CFPilot 侧无对应 ui/dist，Phase 2 不植入**）。
- `cf-worker-relay/`：Worker + Durable Objects（`index.ts` 610 行 / `proto.ts` 267 行 / `cf.d.ts` 82 行），
  migrations `0001_init.sql`（devices）、`0002_auth.sql`（auth/sessions），`dashboard.html` 面板源。
- `test/`：proto 与 DO 语义单测（node --test，零依赖）。

> 原 `wrangler.toml:24` 硬编码的 D1 ID 是别人账户的库，Phase 1 会改为部署时动态建库并注入。
