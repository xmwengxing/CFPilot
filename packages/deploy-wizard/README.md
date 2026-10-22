# cfpilot-deploy

CFPilot 全中文部署向导：自动创建 KV、部署内核、绑定自定义域名，并输出面板地址与扫描命令。

零第三方运行时依赖，Node.js ≥ 18.17，可直接 `npx -y` 拉起。

## 快速开始

```bash
# 1) 先做权限预检（推荐）
npx -y cfpilot-deploy@latest token --check --zone example.com

# 2) Pages 双项目部署（推荐）
npx -y cfpilot-deploy@latest pages-split --yes

# 3) Worker 单项目部署
npx -y cfpilot-deploy@latest init --yes
```

部署完成后会打印：

- 面板地址（`https://<域名><随机路径>`）
- 管理密码、扫描令牌
- 订阅地址模板
- 本地优选命令

## 命令

| 命令 | 说明 |
| --- | --- |
| `cfpilot-deploy pages-split` | Pages 双项目部署：控制面 + 数据面（推荐） |
| `cfpilot-deploy init` | Worker 单项目部署 |
| `cfpilot-deploy token` | 列出 Token 可访问的账号与有效期 |
| `cfpilot-deploy token --check` | 逐项探测权限，输出「权限项 / 状态 / 缺失后果」 |
| `cfpilot-deploy --help` | 显示完整帮助 |

常用选项：

```
--token <token>        Cloudflare API Token（或环境变量 CLOUDFLARE_API_TOKEN）
--account <id>         目标账号 ID
--kv <id>              KV 命名空间 ID（pages-split 可用；缺省则自动创建）
--control <name>       控制面 Pages 项目名（默认随机）
--data <name>          数据面 Pages 项目名（默认随机）
--worker <name>        Worker 名称（默认纯随机，不带项目特征）
--zone <domain>        主域名，如 example.com
--domain <hostname>    完整自定义域名，如 cf.example.com
--yes                  非交互模式
--dry-run              只演示流程，不实际上传
```

## Token 所需权限

| 权限项 | 用途 |
| --- | --- |
| Account / Workers KV Storage / Edit | 创建并绑定 KV 命名空间 |
| Account / Workers Scripts / Edit（或 Workers / Edit/Admin） | 上传内核、开启 workers.dev 子域路由、开启 Workers Logs |
| Account / Pages / Edit | `pages-split` 创建项目、配置变量、触发部署 |
| Account / Account Settings / Read | 读取账号列表 |
| Zone / Zone / Read | 列出域名（自定义域名需要） |
| Zone / DNS / Edit | 检测冲突 DNS、创建 CNAME |
| Zone / Workers Routes / Edit | 创建 Route（自定义域名回退路径） |

`token --check` 会把缺失权限翻译成具体后果与修复建议。

## 部署行为说明

- **workers.dev 子域路由默认关闭**，向导会自动开启，否则会一直显示
  `There is nothing here yet`。
- **自定义域名绑定后会主动校验** `GET https://<hostname><面板路径>`：
  超时 / 522 时自动降级为 `Route + CNAME`，仍不可访问则降级为 workers.dev，
  但面板密码照常输出。
- **Pages 的绑定与变量只对之后的部署生效**，因此向导严格按
  「建项目 → 配变量 → 部署」顺序执行，不可调换。
- 内核一旦上传成功，后续步骤全部尽力而为：任何失败只降级并告警，绝不抛出。

## License

MIT
