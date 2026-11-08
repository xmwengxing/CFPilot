/**
 * cfpilot scan 的帮助文本
 */

import { NAME, VERSION } from '../shared/version'
import { DEFAULT_SPEED_URL } from './speed-url'
import { DEFAULT_BRIDGE_PORT } from './server'

export const SCAN_HELP = `
${NAME} v${VERSION}
CFPilot 本地真连接优选器 —— 用你自己的 Worker 域名做 SNI/Host，
完成 WebSocket 101 真连接校验，只保留真正可用的 IP。

用法:
  ${NAME} scan [选项]        执行三阶优选扫描
  ${NAME} scan compare      双栈对照报告（IPv4 vs IPv6，同参数跑两轮）
  ${NAME} scan relay        反代入口候选的出站体检（从 Worker 内部发起）
  ${NAME} scan serve [选项]   启动本地桥接服务（供面板一键唤醒）
  ${NAME} scan ips [选项]     打印 Cloudflare 官方网段
  ${NAME} --help             显示帮助
  ${NAME} --version          显示版本

scan 选项:
  --host <domain>        必填：你的 Worker 自定义域名（作为 TLS SNI 与 HTTP Host）
  --port <port>          端口，默认 443
  --panel <domain>       控制面域名（如 cpmanager.pages.dev），回填必填
                         与 --host 不同：--host 是数据面，面板接口在控制面
  --panel-password <pw>  面板密码，配合 --panel 自动获取临时令牌
  --token <token>        回填令牌（不想给密码时手动指定）
  --callback <url>       自定义回填地址（默认由 --panel 推导）
  --no-callback          只打印结果，不回填
  --path <path>          阶段二校验的 WebSocket 路径，默认 /__edge_probe
                         （对接其它项目时填它自己的 WS 路径，例如 /vless 或 /<uuid>）
  --probe-path <path>    probe 模式的测速路径，默认 /__edge_probe
                         显式指定后，阶段二的内容校验也会走这个路径
                         （对接第三方项目时用；探针端点不是 /__edge_probe 时必填）
  --speed-mode <mode>    测速方式：auto（默认）/ probe / url
                         auto  = 目标有探针端点就用它，否则自动改用公开测速地址
                         probe = 只用目标项目的探针端点（最忠实，要求对方有该端点）
                         url   = 只用公开测速地址（任何项目都能测）
  --speed-url <url>      公开测速地址，默认 ${DEFAULT_SPEED_URL}
                         可换成任意返回大文件的地址
  --speed-conns <n>      测速并发连接数，默认 8，最大 8
                          跨境链路单条 TCP 受丢包 / 拥塞窗口限制。实测同一个 IP：
                          1 条 0.12 MB/s、3 条 0.47、8 条 1.15、16 条 2.22 ——
                          用 1~3 条会系统性低估 2~4 倍；8 条更贴近浏览器真实行为
  --speed-duration <ms>  测速时长，默认 6000，最大 10000
                          前 1 秒的慢启动样本会被丢弃，只统计之后的稳态吞吐
                          ⚠️ 流量开销 ≈ 时长 × 链路速率 × 连接数：
                          8 条连接、6 秒、1MB/s 链路上约 48MB/候选
                          （30 个候选 ≈ 1.4GB）。流量敏感时调小它或 --speed-limit
  --speed-concurrency <n>
                         测速阶段的候选并行数，默认 1（串行）
                          带宽由整条链路共享：并行测多个候选会互相抢带宽，
                          每个都只能测到 1/N，数值普遍偏低（老版本报出
                          0.1 MB/s 的主因）。>1 只在千兆以上链路才有意义
  --two-stage-speed      两轮测速（默认关闭）：对**全部** 101 通过候选先做短测粗排，
                         再对粗排前 --speed-limit 名做完整精测
                         解决「握手稍慢但下行明显更快的 IP 被延迟排序截掉」
                         粗筛串行 1.2s × 2 连接，最多 120 个、总预算 4 分钟；
                         粗测速度只用于排序，**不写进结果**，速度仍来自精测
  --coarse-speed-limit <n> 粗筛候选上限，默认 120
  --coarse-duration <ms> 粗筛单次时长，默认 1200
  --coarse-conns <n>     粗筛连接数，默认 2
  --coarse-timeout <ms>  粗筛单次整体预算，默认 3000
  --coarse-budget <ms>   粗筛阶段总预算，默认 240000（到点剩余按延迟兜底）
  --retries <n>           每个探测的尝试次数（含首次），默认 2
                          真机偶发失败率 3~5%，重试取第一次成功的结果
  --no-verify            阶段二只做 101 握手，跳过响应体校验
                          （默认校验：发 PING 并验证数据面回 {"pong":true}）
                          目标没有探针端点时会自动降级为纯 101 校验
  --no-speed             跳过测速，只按延迟排序
  --top <n>              返回条数，默认 8
  --concurrency <n>      阶段一 TCP 并发，默认 300
  --tls-concurrency <n>  阶段一 TLS 握手并发，默认 64
                          TLS 握手是 CPU 密集型操作，过高会让本机成为瓶颈
  --sample <n>           候选 IP 采样数，默认 6556（与界面一致；不宜超过 23000）
                          建议 6556 起：阶段一按 TLS 握手耗时筛选，而握手快慢
                          与 TCP 延迟几乎无关（实测 TCP 9ms 的 IP 可能要 3.5 秒），
                          采样小了根本碰不到握手快的 IP
  --family <auto|v4|v6|both>
                          地址族，默认 auto
                          auto = 先做 IPv6 环境预检（本机公网地址 + 默认路由 +
                          活跃段金丝雀连通），通了才让 IPv6 参与采样；
                          不通则退回纯 IPv4，并给出「当前网络环境不具备
                          IPv6 测速条件」与排查建议 —— 不会把一半预算
                          烧在必然超时的候选上。
                          v6 / both = 明确要求，预检只作提示不阻断。
  --push-mode <incremental|overwrite>
                          回填面板的写入方式，默认 overwrite
                          overwrite   —— 清空面板优选池后写入
                          incremental —— 保留池里已有的 IP，只补真正新的
                          （也接受 append / replace，与面板接口字段同名）
  --countries <a,b>      国家 / 地区过滤（可多选，逗号分隔，如 US,JP,SG）
                         也接受分组关键字：ASIA = 亚洲组、US = 美国组，
                         可与国家码混写（如 ASIA,US）；不填 = 全量。
                         机房来自 101 握手响应。
                         带此参数会自动扩大 101 校验的候选池（120 → 最多 500），
                         否则目标地区可能因延迟排序被提前截断；
                         筛不到时会明确提示「已放宽为全量」而不是静默忽略
  --cidr <a,b>           自定义网段（可重复，用逗号分隔）
  --ip-file <path>       使用本地 IP 列表文件
  --ip-url <链接>        使用远程 IP 列表（http/https，上限 2MB，与 --ip-file 二选一）
  --from-pool            从本地外部候选池分层取样（默认关闭，关闭时行为完全不变）
                         池由 cfpilot source sync 长期积累；取样只取端口 == --port 的条目
  --pool-sample <n>      --from-pool 的取样上限，默认 200（不会放大测速并发）
  --max-latency <ms>     阶段一 TCP 延迟上限，默认 0（不限）
  --tls-timeout <ms>     阶段一 TLS 握手超时，默认 2000
                         超时不再重试（该 IP 在当前网络下就是不可用）
  --probe-limit <n>      进入 101 校验的候选数，默认 120
                         带 --countries 时自动放大到 max(120*4, 500)
  --speed-limit <n>      进入测速的候选数，默认 30
  --speed-bytes <n>      测速字节数，默认 5242880
  --timeout <ms>         阶段一超时，默认 1200
  --neutral-sampling     中性采样：忽略网段权重、按网段大小等比抽取
                         （选国家筛选时会自动启用；只保留 TCP 层不可达的网段）
  --speed-repeat <n>     每个候选重复测速次数，默认 1（>1 时取中位数并显示 ±抖动）
  --uuid <uuid>          真实隧道校验用的 VLESS UUID（给了才会跑阶段二点五）
  --trojan-password <pw> 真实隧道校验用的 Trojan 口令（与 --uuid 二选一）
  --verify-target <host> 隧道校验访问的目标域名，默认 baidu.com
  --unlock               出口体检：按机房去重，标注 [AI] / [NF]
                         需要 --uuid（端点鉴权）与面板开启「出口体检」开关
                         结果按机房缓存 10 分钟，同一机房只打一次外部请求
  --no-verify-ws-path    跳过「真实 WS 路径 101」这项额外校验
  --seed <n>             采样随机种子。默认每次随机 —— 保证每次探索不同的 IP 子集
                          （写死种子会让每次跑都测同一批 IP，抽到劣质段就永远测不出好 IP）
                          显式指定则固定、结果可复现（排查 / 对比时用）

  自适应采样（实验性，默认关闭）:
  --adaptive             开启「按网络档案自适应网段权重」
                          网段可用性因网络而异：按本机网络档案的历史成败调整采样权重，
                          不同档案的历史互不混用（档案存在 ~/.cfpilot/network-profiles.json）
  --isp <code>           运营商：ct 电信 / cu 联通 / cm 移动 / other，默认 other
  --region <name>        地区（粗粒度即可，如「福建」），可留空
  --access <type>        接入类型：fixed 固定宽带 / mobile 移动网络，默认 fixed
  --explore-rate <pct>   探索预算比例（5~100），默认 20
                          探索比例保证历史结论不会永久锁死采样池
  --explore-zero         允许在探索预算里重新验证静态零权重网段
                          （这些网段在本机网络里可能其实可用）
  --json                 以 JSON 输出结果
  --quiet                仅输出结果

serve 选项:
  --port <port>          监听端口，默认 ${DEFAULT_BRIDGE_PORT}
  --host <addr>          监听地址，默认 127.0.0.1

示例:
  ${NAME} scan --host cfpilot.example.com --token abc123
  ${NAME} serve
`

/**
 * `scan compare` 的帮助。
 *
 * 与 SCAN_HELP 分开：对照是独立子命令，选项少得多，
 * 混在一长串里用户找不到重点。
 */
export const SCAN_COMPARE_HELP = `
${NAME} scan compare —— 双栈对照报告（IPv4 vs IPv6）

用法:
  ${NAME} scan compare --host <数据面域名> [选项]

做什么:
  同一目标、同一环境、**相同参数**跑两轮（先 IPv4 后 IPv6），
  输出两族的通过率、延迟、吞吐与机房分布对照，最后给一句结论。

  ⚠️ 两轮各自用相同的 --sample 生成候选（不是 auto 拆一半）——
     预算相等才有可比性，否则通过率会被采样规模污染。
  ⚠️ 只比较「本机 → Cloudflare 边缘」的入口质量，不代表出口 IP 信誉。

选项:
  --host <domain>        数据面域名（TLS SNI 与 HTTP Host），必填
  --port <n>             端口，默认 443
  --path <p>             真实 WebSocket 路径，默认 /__edge_probe
  --probe-path <p>       探针端点路径，默认 /__edge_probe
  --sample <n>           **每族**的采样数，默认 3000
  --top <n>             每族保留条数，默认 8
  --countries <a,b>      国家 / 地区过滤（两族共用）
  --no-speed             跳过测速（只比可用率与延迟）
  --speed-conns <n>      测速连接数，默认 8，上限 8
  --speed-duration <ms>  测速时长，默认 6000，上限 10000
  --neutral-sampling     忽略网段权重（只保留不可达段为 0）
  --seed <n>             固定采样种子（两轮各自可复现）
  --json                 输出机器可读的完整数据（含失败分布）
  --quiet                只输出表格与结论
  -h, --help             显示本帮助

示例:
  ${NAME} scan compare --host cfpilot.example.com
  ${NAME} scan compare --host cfpilot.example.com --sample 2000 --json
`

/**
 * `scan relay` 的帮助 —— 反代入口候选的出站体检。
 *
 * 与 SCAN_HELP 分开：它要的是控制面密码与一个候选文件，
 * 语义（从 Worker 内部发起）也与普通优选完全不同。
 */
export const SCAN_RELAY_HELP = `
${NAME} scan relay —— 反代入口（ProxyIP 池）候选的出站体检

做什么:
  用**本机**开一条 VLESS/WS 隧道到你的数据面，让 Worker 去连候选 IP:443，
  再由本机在这条隧道上完成 TLS 握手（SNI = 你的数据面域名）并请求 /__cfp_version。

  两个条件同时成立才算通过：
    · 证书按你的域名校验通过 → 该候选确实把 SNI 转发到了 Cloudflare
    · 返回的 build 等于数据面自己的 build → 落点确实是你的实例

  ⚠️ 为什么不让 Worker 自己做 TLS：生产的反代链路是**明文管道**
     （Worker 把客户端的 ClientHello 原样转发）。真机实测 Worker 侧
     connect()+startTls() 到这类代理读不到任何字节，而同一批 IP 从本机测全部 200。

用法:
  ${NAME} scan relay --file <候选文件> --host <数据面域名> \\
                     --ws-path <WS 路径> --uuid <UUID> [选项]
  ${NAME} scan relay --url <清单链接> --host <数据面域名> \\
                     --ws-path <WS 路径> --uuid <UUID> \\
                     --push incremental --panel <控制面> --panel-password ***

选项:
  --file <path>          候选 IP 文件（每行一个，支持 CSV 与 # 注释）
  --url <链接>           远程候选清单（http/https，上限 2MB），与 --file 二选一
  --host <domain>        数据面域名（隧道与 SNI 都用它）
  --ws-path <path>       数据面的 WebSocket 路径
  --uuid <uuid>          VLESS UUID（隧道鉴权，必需）
  --rounds <n>           轮数，默认 2
  --timeout <ms>         单目标超时，默认 12000
  --out <path>           写出可**直接粘贴**进 ProxyIP 池的清单（只含全通项，按质量排序）
  --top <n>              与 --out / --push 配合：最多取几条，默认 10
  --push <mode>          直接写入面板 ProxyIP 池：incremental 增量 / overwrite 覆盖
                         需要同时给 --panel 与 --panel-password
  --panel <domain>       控制面域名（--push 时必填）
  --panel-password <pw>  面板登录密码（--push 时必填）
  --json                 输出机器可读 JSON
  --quiet                只输出结果
  -h, --help             显示本帮助

产出怎么用:
  通过率高的前几条填进面板「入站配置 → ProxyIP 池」（每行一条）。
  该池**不进订阅**，只影响 Worker 的出站选路，日常转发性能不受影响。

示例:
  ${NAME} scan relay --file docs/relay-ip-candidates.csv \\
    --host data.example.com --ws-path /xxxx --uuid 00000000-0000-0000-0000-000000000000
`
