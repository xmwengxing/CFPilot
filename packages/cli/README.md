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

### 实验性出口识别

```bash
cfpilot egress-identify --url https://identity.example.com/identify --proxy socks5://127.0.0.1:10808
```

仅调用用户自有 HTTPS 识别服务，返回**指定传输路径**观察到的公网出口；省略 `--proxy` 时仅测 CLI 本机直连基线。不绑定候选 IP，不参与默认 `scan`、排序或回填，也不代表逐入口 IP 或 Worker 出口差异。

服务返回 `application/json`，必填 `remote_ip`（实际 TCP 对端的公网 IPv4/IPv6）、`observed_at`（带时区 RFC3339），可选 `egress_kind`、`colo`。不得直接信任客户端 XFF。观察超过五分钟或未来超过 30 秒则拒绝；总超时八秒、响应体最多 16 KiB，不接受压缩或重定向。

可选专用短期 Bearer token 通过 `CFPILOT_EGRESS_TOKEN` 提供，同时设置 `CFPILOT_EGRESS_TOKEN_EXPIRES_AT`（剩余有效期须在五分钟以内）；服务端仍须独立校验真实有效期和专用权限。代理凭据可用 `CFPILOT_EGRESS_PROXY`，凭据不落盘、不输出，代理失败不回退直连。完整命令见 `cfpilot egress-identify --help`，服务协议见源码包内 `EXPERIMENTAL-EGRESS.md`。

### 实验性网站兼容性

```bash
cfpilot website-check --url https://site.example.com/check --label site --expected-text ready --proxy socks5://127.0.0.1:10808
```

仅检测用户明确指定的 HTTPS 目标，省略代理时是直连基线，不登录、不执行脚本、不发送识别 token，不宣称账号权限或完整解锁。默认只判定 2xx；可用 `--expected-text` 要求正文包含标记。挑战、403 禁止、429 限流、TLS 错误、超时和其他 HTTP 错误分别输出，不跟随重定向；响应最多 16 KiB、总超时八秒。

命令输出 `{targets:[...]}`，目标字段与质量报告兼容，不接入默认 `scan` 或排序，不读写扫描历史。模块支持最多十个目标串行检测；完整说明见源码包内 `EXPERIMENTAL-WEBSITES.md` 和 `cfpilot website-check --help`。

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
