# edge-relay —— 盲中继 / 云监测台 受校验副本

本目录是 CFPilot 侧的**受校验参照副本**，供 `scripts/check-edge-relay.mjs` 与
`FILELIST.json` 做漂移检测。**内容上游是 MobiHop**，见
`E:\Projects\MobiHop\docs\reports\CROSS_PROJECT_SYNC.md §1`。

## 权威关系（2026-11-18 起）

```
MobiHop/edge/cf-worker-relay/     ← 上游源（协议演进的唯一发生地）
      │  cfr 拉取（本仓库 scripts/sync-edge-relay.mjs 只做「参照 → 副本」分发）
      ├──> packages/edge-relay/   受校验参照副本（内容必须与上游逐字节一致）
      ├──> CFPilot/edge/          同步副本（禁止手改）
      └──> MobiHop/edge/          上游本体（同步脚本对其为幂等写入）
```

- **协议演进只发生在 MobiHop**（ADR-0016 v2 就是这么来的）；CFPilot 拉取后刷新
  `FILELIST.json`，**禁止反向推送**改动给 MobiHop。
- CF 平台部署脚本的维护仍可由 CFPilot 发起，但涉及 `cf-worker-relay/` 协议字节的
  改动必须先落到 MobiHop 上游，再由本目录拉取。
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
