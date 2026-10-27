# cfpilot

> Cloudflare Pages 代理部署与优选工具 —— 交互式中文菜单 + 零依赖单文件 CLI。

```bash
npm i -g cfpilot
cfpilot
```

或者不装，直接用：

```bash
npx -y cfpilot@latest
```

---

## 能做什么

| 功能 | 说明 |
|---|---|
| **部署** | 一键部署 Pages 双项目（控制面 + 数据面），自动建 KV、生成凭据、沿用旧配置 |
| **优选 IP** | 三阶真连接校验（TCP → TLS → WS 101 + PING）筛掉「看着快、实际 -1」的 IP |
| **回填** | 把优选结果直接写进面板的「手动优选 IP」 |
| **状态检查** | 对比线上内核 / 应用内置 / 远程最新三个版本，明确告诉你能不能更新 |

## 交互菜单

```
┌──────────────────────────────────────────────────┐
│ cfpilot                                          │
├──────────────────────────────────────────────────┤
│ Cloudflare Pages 代理部署与优选                  │
└──────────────────────────────────────────────────┘

  当前状态
  账号  32724941@qq.com's Account
  实例  ed017c97a67e…
  控制面 cpmanager.pages.dev
  凭据  已配置

  ❯ 部署新实例
    更新现有实例
    查看实例状态
    本地优选（真连接测速）
    修改面板密码
    检查 Token 权限
    配置（Token / 账号 / KV）
    帮助
    退出
```

## 子命令（脚本用）

```bash
cfpilot deploy                          # 部署 Pages 双项目
cfpilot scan --host <数据面域名>         # 本地优选
cfpilot scan --host x --panel y \
             --panel-password z          # 优选并自动回填面板
cfpilot status                          # 查看实例与版本对比
cfpilot token --check                   # 检查 API Token 权限
cfpilot config --token <TOKEN>          # 配置管理
```

完整参数见 `cfpilot scan --help`。

## 部署代码可以独立更新

部署用的内核产物（数据面 / 控制面）**不随应用版本绑死**：

- 部署前会从 GitHub Releases 拉取**最新**的内核
- 拉不到（离线）时自动用内置版本，不影响部署
- `cfpilot status` 会显示三个版本并说明能不能更新：

  ```
  内核版本：线上 0.7.3 ｜ 内置 0.8.0 ｜ 远程 0.8.0
  远程内核 0.8.0 与内置版本一致。
  ```

## 要求

- Node.js ≥ 18
- 一个 Cloudflare API Token（权限见项目 README）

## 相关

- 项目主页：https://github.com/xmwengxing/CFPilot
- 完整文档：https://github.com/xmwengxing/CFPilot#readme
- 图形版（Go，8.3 MB 单文件）：见项目 Releases

## License

MIT
