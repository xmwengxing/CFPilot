# edge-relay 内置资产目录

`worker.js` / `dashboard.html` / `schema.sql` 由 `scripts/build-desktop.mjs`
从权威 `packages/edge-relay/` 构建产物（packages/cli/assets/edge-relay/）拷入。
本目录保留此 README 仅为 `go:embed` 在资产尚未生成时可编译（与 server/assets 同理）。

- 权威源码：`packages/edge-relay/`（CFPilot 仓库）
- 构建脚本：`scripts/build-edge-relay.mjs`
- CLI 同源实现：`packages/cli/src/edge/deploy.ts`
