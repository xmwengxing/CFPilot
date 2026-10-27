## CFPilot v0.7.0

**两个 CLI 合并为一个 `cfpilot`，并新增交互式中文菜单。**

---

## 🎯 重大变更：CLI 合并

`cfpilot-scanner` 与 `cfpilot-deploy` 已合并为 **`cfpilot`**。

### 为什么合并

两个包**零依赖、零跨包引用**，`args.ts` 甚至完全重复（77 行）。
合并后：

- 只需装一个包：`npm i -g cfpilot`
- 只记一个命令：`cfpilot`
- 版本号、CI、文档从 2 份变 1 份

> 旧包上月的 npm 下载量均为 **0**，确认无其他用户受影响。

### 命令对照

| 之前 | 现在 |
|---|---|
| `cfpilot-scanner scan` | **`cfpilot scan`** |
| `cfpilot-deploy` | **`cfpilot deploy`** |
| `cfpilot-deploy token` | **`cfpilot token`** |
| — | **`cfpilot`**（交互菜单） |
| — | **`cfpilot status`** |
| — | **`cfpilot config`** |

**原有 `--flag` 全部保留**，只改命令前缀，现有脚本只需替换前缀。

---

## ✨ 新增：交互式中文菜单

```bash
npm i -g cfpilot
cfpilot
```

```
┌──────────────────────────────────────────────────┐
│ cfpilot v0.7.0                                   │
├──────────────────────────────────────────────────┤
│ Cloudflare Pages 代理部署与优选                  │
└──────────────────────────────────────────────────┘

  当前状态
  账号  32724941@qq.com's Account
  实例  ed017c97a67e…
  控制面 cpmanager.pages.dev
  凭据  已配置

  请选择操作（↑↓ 选择, Enter 确认, q 返回）

  ❯ 部署新实例
    更新现有实例
    查看实例状态
    本地优选（真连接测速）
    回填优选结果到面板
    修改面板密码
    检查 Token 权限
    配置（Token / 账号 / KV）
    帮助
    退出
```

### 交互能力

| 能力 | 说明 |
|---|---|
| 方向键选择 | ↑↓ 移动，Enter 确认，数字键快捷选中，q 返回 |
| 多选 | 空格切换（用于机房地区筛选） |
| 密码输入 | 关闭回显 |
| 确认框 | y/n |
| 中文对齐 | CJK 按 2 宽计算，框线不歪 |
| 自动降级 | 非 TTY / NO_COLOR / TERM=dumb → 纯文本 + 数字选择 |

**零第三方依赖**：手写 readline + ANSI，保持「零运行时依赖」铁律。

---

## ✨ 新增：配置持久化

`~/.cfpilot/config.json` 保存 Token / 账号 / KV / 控制面域名。

**查看时脱敏**（只显示前 6 位与后 4 位）：

```json
{
  "token": "cfat_G…8e75"
}
```

Token 优先级：`--token` 参数 → `CLOUDFLARE_API_TOKEN` 环境变量 → 配置文件。

---

## 📦 产物

| 文件 | 体积 |
|---|---|
| cfpilot-0.7.0-windows-amd64.exe | 8.27 MB |
| cfpilot-0.7.0-linux-amd64 | 10.21 MB |
| cfpilot-0.7.0-linux-arm64 | 9.50 MB |
| cfpilot (npm) | 198 KB（含内核资产 95.5 KB） |

---

## ✅ 验证

```
typecheck: 3 个包全过
测试: 341 项 PASS
5 个校验脚本: 全部通过
```

### 真机验证

| 命令 | 结果 |
|---|---|
| cfpilot token | 读出账号 32724941@qq.com's Account |
| cfpilot scan --sample 100 --no-speed | 返回 5 条节点（LAX/AMS） |
| cfpilot deploy --dry-run | 识别现有实例、KV 归属、沿用凭据 |
| cfpilot status | 列出 1 个实例，正确排除 cfnext |
| cfpilot 菜单完整流程 | 主菜单 → 状态 → 真实数据 → 返回 |

---

## ⚠️ 升级提示

旧包 `cfpilot-scanner` / `cfpilot-deploy` 保持在 0.6.5 不再更新，
**建议改用 `cfpilot`**：

```bash
npm uninstall -g cfpilot-scanner cfpilot-deploy
npm i -g cfpilot
cfpilot
```

---

## 说明

本次**无内核改动**，已部署的实例无需重新部署。
图形版（Go）无变化，仍是 0.7.0 产物。
