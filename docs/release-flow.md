# 发布流程手册（提交 / 双 tag 推送 / 内核独立发布）

> 给维护者的操作手册：发版、只更新内核、查工作流状态。
> 所有命令都在仓库根目录执行。GitHub 直连不稳时加代理（见 §5）。

---

## 1. 常规发版（代码 + 内核一起发）

一次发版 = 提交 + 打**两个 tag** + 推送，三个工作流自动接手：

| tag | 触发的工作流 | 产出 |
|---|---|---|
| `v<版本>` | Publish npm | npm 发布两个 CLI 包 |
| `desktop-v<版本>` | Release Desktop | 三平台桌面版 exe + Android APK，追加到 `v<版本>` 同一个 Release |
| （push main 本身） | CI | 类型检查 / 测试 / 哈希自检 |

### 操作步骤

```bash
# 1. 升级版本号（唯一入口，会同步所有子包）
npm run version:bump -- 0.44.0

# 2. 写发布说明（格式红线见 AGENTS.md §5.1：只有 新增/修复/优化 三类，
#    一句一条，只写用户可见变化；禁止写过程/内部文档/验证数字）
#    文件：.release-notes/<版本>.md（被 .gitignore 忽略，必须强制入库）
git add -A
git add -f .release-notes/<版本>.md

# 3. 全量验证（含发布说明检查、内核体积预算、源码哈希）
npm run verify
cd packages/desktop && gofmt -l . && go vet ./... && go test ./... && cd ../..

# 4. 提交 + 双 tag + 推送
git commit -m "release: v<版本> <一句话主题>"
git tag -a v<版本> -m "v<版本>"
git tag -a desktop-v<版本> -m "desktop-v<版本>"
git push origin main --follow-tags
```

### 发版后自查（务必）

```bash
# 工作流状态（三个都要 success）
gh run list --limit 5

# Release 资产齐全（三平台 exe + APK + zip + SHA256SUMS）
gh release view v<版本> --json assets --jq '.assets[].name'
```

⚠️ **推送失败重试**：GitHub 直连经常被重置，重试几次通常能过；
持续失败时走本地代理（见 §5）。推送中途断线后先 `git ls-remote` 核实
哪些 tag 已上去，再补推，**不要重复打 tag**（已推送的 tag 删了重打会让
Release 与产物错位）。

---

## 2. 只更新内核（不发新版本）

**适用场景**：只改了 `packages/worker-core`（内核 / 面板），工具本身
（CLI / 桌面版）没有需要发版的改动。用户点「更新内核」即可获得，
不用发 npm / 桌面版。

```bash
# 1. 提交内核改动
git add -A && git commit -m "feat: <主题>"

# 2. 打内核 tag 并推送（tag 名只要是 kernel-v 开头即可，
#    惯例用 kernel-v<日期时间>，如 kernel-v202611150835）
git tag -a kernel-v202611150835 -m "kernel: <一句话主题>"
git push origin main --follow-tags

# 3. 推 kernel-v* 标签触发 Release Kernel 工作流，
#    它把新内核**覆盖上传**到固定滚动 Release `kernel-latest`
```

### 内核通道的版本判定（为什么这样设计）

- 通道清单 `cfpilot-kernel-VERSION` 里有单调递增的 **seq**
  （UTC `yyyymmddHHMM`，由工作流按发布时间生成），靠它判断「谁更新」；
- 包内置锚点 `cfpilot-kernel-VERSION` 在**构建时生成**，包发布时间
  晚于任何已有内核发布 → 内置序号天然不落后，不会误报「有更新」；
- 用户侧感知：托盘每小时自动检查 + 弹气泡；「检查部署状态」显示
  「可升级」→ 点「重新部署」即拉取新内核部署。

⚠️ **纪律**：发内核前必须过完整 `npm run verify`；`minToolVersion`
只在面板 API / 部署协议**不兼容**时才填（填了旧工具会被要求先升级工具）。

---

## 3. 查工作流状态

```bash
# 最近几次工作流（名称 / 分支 / 状态 / 结论 / 时间）
gh run list --limit 5

# 只看某一类
gh run list --workflow=release-kernel.yml --limit 1
gh run list --workflow=release-desktop.yml --limit 1
gh run list --workflow=publish-npm.yml --limit 1

# 某次运行的 job 明细（哪个 job / 哪个步骤挂了）
gh run view <run-id> --json jobs --jq '.jobs[] | {name, conclusion}'

# 失败日志（只看失败的步骤）
gh run view <run-id> --log-failed
```

不装 gh CLI 也可以直接看网页：仓库 → Actions 标签页 →
按 workflow 名过滤；Release 产物在 Releases 页面。

### 常见失败与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| Release Desktop 的 android job 挂在「编译 APK」 | runner JDK 与 Gradle 版本漂移（2026-11-14 已固定 JDK 17） | 看日志确认，若再次漂移按同样的思路在 workflow 里固定版本 |
| Publish npm 挂在发布 | npm 2FA / 权限 | 需要维护者在 npm 侧操作（自动化无法代替 2FA） |
| CI 的源码哈希自检挂了 | 构建产物与提交内容不一致 | 先 `npm run build`（内核 + CLI）再重新提交 |
| 发布说明检查挂了 | `.release-notes/<版本>.md` 未 `git add -f` 或踩了禁用词 | 按报错补入库 / 改文案 |

---

## 4. 内核通道的验证

发布内核后核对通道内容（seq / build 应该是刚提交的）：

```bash
curl -L https://github.com/xmwengxing/CFPilot/releases/download/kernel-latest/cfpilot-kernel-VERSION
```

预期输出：

```json
{ "seq": 202611150835, "build": "<git短hash>-<内容哈希>", "minToolVersion": "" }
```

`build` 的前半段就是刚才提交的 git 短 hash —— 对得上才算发对了。

---

## 5. 网络受阻时代理推送

GitHub 直连经常被重置（`Connection was reset` / 连接超时）：

```bash
# 走本地代理推送（10808 换成实际代理端口；socks5 代理用 socks5:// 前缀）
git -c http.proxy=http://127.0.0.1:10808 push origin main --follow-tags

# 核实远程是否真的上去了（以 ls-remote 输出为准，不要信 push 的输出）
git ls-remote --tags origin v<版本> desktop-v<版本>
```

⚠️ **以 `git ls-remote` 为准**：push 的输出可能因中途断线产生误导，
tag 是否上去了必须用 ls-remote 核实。

---

## 6. 一页速查

| 要做的事 | 命令序列 |
|---|---|
| 常规发版 | bump → notes → verify → commit → `v*` + `desktop-v*` → push |
| 只发内核 | commit → `kernel-v<时间>` → push → curl 核对 VERSION |
| 查状态 | `gh run list --limit 5` |
| 查失败 | `gh run view <id> --log-failed` |
| 代理推送 | `git -c http.proxy=… push origin main --follow-tags` |
| 核实远程 | `git ls-remote --tags origin <tags>` |
