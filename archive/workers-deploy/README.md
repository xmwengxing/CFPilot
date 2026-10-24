# 归档：Workers 双脚本部署形态（2026-10-24 归档）

> ⚠️ **本目录内容已停止维护，禁止恢复到主线。**
> CFPilot 的唯一受支持部署形态是 **Pages 双项目（pages-split）**。
> Workers 双脚本形态曾作为「实验性选项」短暂存在（提交 `3c0fa3c`，2026-10-24 上午合入、
> 当日晚间归档），归档的决定性原因见下。

## 为什么归档（按证据强度排序）

1. **封号风险（决定性）**：一个 2026-10-23 注册的全新干净 Cloudflare 账号，
   在仅 3 次最小 Worker 脚本部署 + 少量探测后即被封禁；
   而部署过数百次的旧账号只是反复出现 522（未封）。
   结论：**Workers 通道上承载代理特征的 Worker 内容有真实封号风险**。
2. **数据面 522 无解**：同一字节产物在部署后 1–5 分钟内从 200 **回退成 522**
   （疑似风控异步扫描：先受理运行、数分钟后隔离；0.2KB 中性内容两账号从未失败）。
3. **workers.dev 不可依赖**：实验期间对两个账号均为**边缘级 500**（error 1101，
   请求不进 isolate，`wrangler tail` 零日志）——连观测手段都不可靠。
4. **内联方案已证伪**：「把 `outbound/*` 内联进单一入口（edgetunnel 形态）」实测
   与现行形态行为完全一致（都能出生 200、都会回退 522），无收益。

## 本目录内容

| 文件/目录 | 说明 |
|---|---|
| `worker-deploy.ts` | Workers 双脚本部署实现（原 `packages/deploy-wizard/src/worker-deploy.ts`） |
| `worker-deploy.test.ts` | 其 9 个测试用例（原 `packages/deploy-wizard/test/`） |
| `entry-data-self.ts` | Workers 专用纯自研数据面入口（原 `packages/worker-core/src/entry-data-self.ts`） |
| `lab/` | 522 研究实验台：`lab-src/`（8 个变体入口 + relay 转发器）、`scripts/`（build-lab / deploy-lab / deploy-any / rebind-lab / probe-workersdev） |

主线代码已整体回退到 `3c0fa3c^`（双形态提交之前）的稳定状态，
完整上下文可用 `git show 3c0fa3c` 查看。

## 若将来复用注意事项

- `lab/` 下的脚本按当时的路径布局编写（如 `../src/outbound/dial`、`dist-lab/`），
  主线文件已删除/移动，直接运行会报错；复用前需调整相对路径或从 git 历史恢复源文件。
- 实验脚本的账号 ID / zone ID / 域名硬编码在脚本顶部（`deploy-lab.mjs` / `rebind-lab.mjs`），
  令牌一律走环境变量 `CFP_LAB_TOKEN`（未落盘）。
- **任何恢复 Workers 部署形态的尝试都必须先重新评估封号风险**（见 AGENTS.md 铁律）。
