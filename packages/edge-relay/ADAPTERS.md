# edge-relay 适配点清单（Phase 0 文档化）

> 本文件是 Phase 0 对"参数化"的落地：**不改协议源码**，只把需要参数化的值逐项列清。
> 实际参数注入在 Phase 1（CF API 部署原语）与 Phase 2（CLI/GUI 部署命令）实现。
> 这样既保住 `FILELIST.json` 的逐字节基线，又让后续部署逻辑有明确的参数契约。

## 1. 部署标识类（Phase 1/2 注入）

| 适配点 | 当前硬编码位置 | 现状值 | 参数化后来源 |
|---|---|---|---|
| Worker 名 | `wrangler.toml:7` `name` / ps1 `--name` | `mobihop-edge-relay` | CLI `--edge-worker-name` / GUI 表单 |
| D1 库名 | `wrangler.toml:23` `database_name` | `mobihop-monitor` | 动态建库返回值（Phase 1） |
| **D1 库 ID** | `wrangler.toml:24` `database_id` | `f18c66ff-…`（**别人账户的库，必须替换**） | 动态建库返回值（Phase 1） |
| DO 类名 | `wrangler.toml:13` `class_name` | `MeshRoom` | 保持常量（协议相关） |
| Pages 项目名 | `deploy-cf-monitor-dashboard.ps1:3` / ps1 | `mobihop-monitor-dashboard` | CLI `--dashboard-project` / GUI 表单 |
| 监测 API URL | `dashboard.html` `__MONITOR_API__` 占位 | 部署时替换 | WorkerUrl 参数（已有机制） |
| 面板默认 API | `dashboard.html:101` | `relay.shijingtian.de5.net` | 占位符替换后失效（保留仅为本地预览） |
| 自定义域名 | `deploy-cf.ps1 -Domain` / `wrangler.toml:35` 注释 | 交互输入 | CLI `--domain` / GUI 表单 |

## 2. 凭据类（Phase 1/2 注入）

| 适配点 | 当前位置 | 参数化后来源 |
|---|---|---|
| Cloudflare Token | `.local/devices.env` `MH_CLOUDFLARE_TOKEN` / 环境变量 | CFPilot 现有凭据体系（profile / Token） |
| Account ID | `MH_CLOUDFLARE_ACCOUNT_ID` / 环境变量 | CFPilot 现有账号解析 |
| MONITOR_TOKEN secret | `MH_MONITOR_TOKEN` / `wrangler secret put` | 部署时生成或用户填写，写入 Worker secret |
| 监测台初始密码 | `deploy-cf.ps1` 交互/自动生成，调 `/auth/setup` | CLI `--monitor-password` / GUI 表单 |

## 3. 协议类（**保持常量，不参数化**）

以下值属于 MobiHop 协议身份，两个仓库必须完全一致；品牌保留 MobiHop（用户决策），不改为 CFPilot：

- 32B 帧魔数 `0x4D`、版本 `0x01`（`proto.ts`、`src/proto.ts`）
- Noise 模式 `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s`、PSK context `mobihop/psk/v1`
- 日志前缀 `[mh-edge]`、WSS 路由 `/mesh/<hash>?peer_id=`
- 426/400 响应文案里的 "MobiHop edge relay"（`src/index.ts:368,372`）

> 这些值如果参数化，反而会让两个仓库的协议实现产生分歧，违背"权威单一"的初衷。

## 4. 限速/容量类（Phase 2 表单暴露）

| 变量 | 默认值 | 来源 |
|---|---|---|
| `WINDOW_MS` | `1000` | CLI `--window-ms` / GUI 表单 |
| `MAX_BYTES_PER_WINDOW` | `1048576` | CLI / GUI |
| `MAX_PACKETS_PER_WINDOW` | `2000` | CLI / GUI |
| `MAX_PEERS_PER_ROOM` | `512` | CLI / GUI |

## 5. 断链修复（Phase 2 处理）

`deploy-cf.ps1:192` 引用的 `tools/netlab/cf-edge-probe.mjs`、`:181` 的 Pages 部署、
以及 `deploy-cloud-console.ps1:82` 的 `ui/dist/cloud.html` 在 CFPilot 仓库**均不存在**。
Phase 2 的 CLI/Go 实现应直接调 CF API 完成等价工作，不依赖这些外部文件；
`--probe` 协议验证改为 CFPilot 自带的 WSS 101 校验（复用 `packages/cli` 的探针逻辑）。
