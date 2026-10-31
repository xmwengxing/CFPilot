/**
 * cfpilot deploy 的帮助文本
 */

import { NAME, VERSION } from '../shared/version'

export const DEPLOY_HELP = `
${NAME} deploy —— 双面部署（控制面 Pages + 数据面 Pages/Workers）

⚠️ 控制面必须留在 Pages；数据面可选 Pages 或 Workers。
   合并成单项目会触发 8000119 风控。

用法:
  ${NAME} deploy [选项]

选项:
  --token <token>        Cloudflare API Token（也可用环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         目标账号 ID
  --kv <id>              KV 命名空间 ID（两个面共用）
  --kv-title <title>     新建 KV 时使用的标题
  --new-kv               强制新建一个 KV 命名空间（用于部署第 2、3… 个实例）
  --list-kv              列出该账号下的 KV 与其中的 CFPilot 实例，不执行部署
  --control <name>       控制面 Pages 项目名（默认随机）
  --data <name>          数据面名称（Pages 项目名 / Worker 脚本名，默认随机）
  --data-plane <mode>    数据面部署形态：pages（默认）/ workers
                         不传 = 沿用部署清单里记录的形态；
                         显式传且与清单不同 = 切换形态（新数据面上线后自动删除旧的）
                         ⚠️ workers 模式只部署到 *.workers.dev，**自定义域名要你自己到
                            控制台绑**，绑好后到面板「设置 → 数据面域名」填一次即可
  --panel-path <path>    面板访问路径（默认随机）
  --mode <mode>          部署模式：auto（默认，自动判断）/ fresh（强制首次）/ update（强制更新）
  --force                忽略版本检查，强制重新部署
  --force-kv             跳过 KV 归属校验（明知该 KV 属于别的实例仍然继续）
  --resolve-preferred=false
                          关闭出站前自动 DoH 解析优选 IP（默认开启）
  --new-credentials      更新部署时也重新生成 UUID / WS 路径 / 面板凭据
                          （默认沿用旧凭据，客户端订阅地址不变）
  --yes                  非交互模式

首次还是更新？
  向导把部署清单写在 KV 的 CFP_DEPLOY_MANIFEST 键里，记录上次用的两个
  Pages 项目名与凭据。因此：
    · 首次部署：KV 里没有清单 → 创建新项目、生成随机凭据
    · 更新部署：KV 里有清单 → 自动找到同源项目、沿用 UUID 与 WS 路径
  你不需要记项目名，也不需要判断是不是首次。

  ⚠️ **一个 KV 命名空间只能承载一个 CFPilot 部署实例**。
     内核在 KV 里用的是全局平铺的键（CONFIG / PANEL_PATH / SESSION:* …），
     没有实例前缀；两个实例共用一个 KV 会互相覆盖凭据与面板密码。
     要在同一账号下跑多个实例，请给每个实例一个独立 KV（--new-kv）。

  未指定 --kv 时，向导会：
    1. 列出账号下所有 KV，逐个探测清单
    2. 恰好一个含清单 → 复用它（进入更新模式，沿用 UUID 与 WS 路径）
    3. 一个都没有     → 新建一个（首次部署）
    4. 有多个         → 列出候选，请用 --kv <id> 明确指定
  用 --list-kv 可随时查看账号下已有哪些实例。

版本跳过:
  每次构建会生成 git短hash-时间戳 的版本号并写入产物。
  线上版本与本地一致时跳过部署，避免无谓触发平台审核。
  加 --force 可强制重新部署。

产物来源:
  packages/worker-core/dist/control.js  控制面（面板 + 订阅 + 探针，无 sockets）
  packages/worker-core/dist/dataplane.js 数据面（VLESS/Trojan-WS/XHTTP，自研实现）

部署顺序（不可调换）:
  1. 创建控制面 Pages 项目（数据面按形态创建 Pages 项目或 Worker）
  2. 配置 KV 绑定与环境变量（Pages 的绑定只对之后的部署生效）
  3. 先部署数据面，再部署控制面（控制面需要数据面域名生成订阅）

Token 所需权限:
  Account / Pages / Edit              创建项目、配置变量、触发部署
  Account / Workers KV Storage / Edit 创建 KV（若未提供 --kv）
  Account / Workers Scripts / Edit    部署 Workers 数据面（--data-plane workers）
                                      （不需要 Workers Routes / DNS —— 工具不碰自定义域名）
`
