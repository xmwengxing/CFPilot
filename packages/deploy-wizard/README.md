# cfpilot-deploy

CFPilot 全中文部署向导：自动创建 KV、部署 Worker 内核、开启 workers.dev 路由与 Workers Logs、绑定自定义域名，并输出面板地址与扫描命令。

零第三方运行时依赖，Node.js ≥ 18.17，可直接 `npx -y` 拉起。

## 快速开始

```bash
# 1) 先做权限预检（推荐）
npx -y cfpilot-deploy@latest token --check --zone example.com

# 2) 部署（交互式）
npx -y cfpilot-deploy@latest init

# 3) 非交互部署 + 指定域名
CLOUDFLARE_API_TOKEN=xxx npx -y cfpilot-deploy@latest init \
  --domain cf.example.com --zone example.com --yes

# 只使用 workers.dev 地址
npx -y cfpilot-deploy@latest init --workers-dev --yes
```

部署完成后会打印：

- 面板地址（`https://<域名或 workers.dev><随机路径>`）
- 管理密码、扫描令牌
- 订阅地址模板
- 本地优选命令（`npx -y cfpilot-scanner@latest --host ... --token ...`）

## 命令

| 命令 | 说明 |
| --- | --- |
| `cfpilot-deploy init` | 执行部署（支持 `--yes` / `--dry-run`） |
| `cfpilot-deploy token` | 列出 Token 可访问的账号与有效期 |
| `cfpilot-deploy token --check` | 逐项探测权限，输出「权限项 / 状态 / 缺失后果」 |
| `cfpilot-deploy --help` | 显示完整帮助 |

常用选项：

```
--token <token>        Cloudflare API Token（或环境变量 CLOUDFLARE_API_TOKEN）
--account <id>         目标账号 ID
--worker <name>        Worker 名称（默认 8~10 位纯随机小写字母数字，不带项目特征）
--zone <domain>        主域名，如 example.com
--domain <hostname>    完整自定义域名，如 cf.example.com
--kv-title <title>     KV 命名空间标题
--workers-dev          强制使用 workers.dev，不绑定自定义域名
--yes                  非交互模式
--dry-run              只演示流程，不实际上传
```

## Token 所需权限

| 权限项 | 用途 |
| --- | --- |
| Account / Workers KV Storage / Edit | 创建并绑定 KV 命名空间 |
| Account / Workers Scripts / Edit（或 Workers / Edit/Admin） | 上传内核、开启 workers.dev 子域路由、开启 Workers Logs |
| Account / Account Settings / Read | 读取账号列表 |
| Zone / Zone / Read | 列出域名（自定义域名需要） |
| Zone / DNS / Edit | 检测冲突 DNS、创建 CNAME（回退路径） |
| Zone / Workers Routes / Edit | 创建 Route（自定义域名 522 时的回退路径） |

`token --check` 会把缺失权限翻译成具体后果与修复建议，例如：

```
DNS 记录（必需）  ❌ 缺失  无法检测冲突 DNS、无法创建 CNAME；自定义域名失败时无法降级 Route + CNAME
   · DNS 记录：HTTP 403：Authentication error
     → 修复：Token 中添加 Zone → DNS → Edit
```

## 部署流程要点

1. 校验 Token → 选择账号 → 生成纯随机 Worker 名称。
2. 创建 KV 命名空间 → 生成随机面板路径 / 密码 / 扫描令牌。
3. 上传内核。
4. **自动开启 workers.dev 子域路由**：Worker 上传后该路由默认关闭，不开启会一直显示
   `There is nothing here yet`。
5. **自动开启 Workers Logs（observability）**：设置接口只接受 `multipart/form-data`，
   JSON body 会返回 415；失败只告警，不阻断部署。
6. 绑定自定义域名后**主动校验** `GET https://<hostname><面板路径>`：
   - 2xx：绑定真的生效；
   - 超时 / 非 2xx / 522：自动降级为 `Route + CNAME`；
   - Route 也失败（常见 403）：明确提示 `Token 缺 Zone → Workers Routes → Edit`；
   - 仍不可访问：降级为 workers.dev 临时地址，但面板密码照常输出。
7. 绑定前若检测到同名 DNS 记录，会打印记录详情与删除建议。

## 开发

```bash
npm run typecheck -w cfpilot-deploy
npm test
npm run build -w cfpilot-deploy
node packages/deploy-wizard/dist/cli.js token --help
```

`assets/cfpilot-worker.js` 由 `npm run build -w cfpilot-deploy` 从
`packages/worker-core/dist/worker.js` 自动同步，请勿手工修改。

## License

MIT
