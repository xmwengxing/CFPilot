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
  --speed-conns <n>      测速并发连接数，默认 3
                         单条 TCP 连接受拥塞窗口限制，多连接更接近真实带宽
  --speed-duration <ms>  测速时长，默认 6000
                          前 1 秒的慢启动样本会被丢弃，只统计之后的稳态吞吐
                          ⚠️ 流量开销 ≈ 时长 × 链路速率 × 连接数：
                          3 条连接、6 秒、1MB/s 链路上约 15MB/候选
                          （30 个候选 ≈ 450MB）。流量敏感时调小它或 --speed-limit
  --speed-concurrency <n>
                         测速阶段的候选并行数，默认 1（串行）
                          带宽由整条链路共享：并行测多个候选会互相抢带宽，
                          每个都只能测到 1/N，数值普遍偏低（老版本报出
                          0.1 MB/s 的主因）。>1 只在千兆以上链路才有意义
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
  --countries <a,b>      国家 / 地区过滤（可多选，逗号分隔，如 US,JP,SG）
                         不选 = 全量。机房来自 101 握手响应。
                         带此参数会自动扩大 101 校验的候选池（120 → 最多 500），
                         否则目标地区可能因延迟排序被提前截断；
                         筛不到时会明确提示「已放宽为全量」而不是静默忽略
  --cidr <a,b>           自定义网段（可重复，用逗号分隔）
  --ip-file <path>       使用本地 IP 列表文件
  --max-latency <ms>     阶段一 TCP 延迟上限，默认 0（不限）
  --tls-timeout <ms>     阶段一 TLS 握手超时，默认 2000
                         超时不再重试（该 IP 在当前网络下就是不可用）
  --probe-limit <n>      进入 101 校验的候选数，默认 120
                         带 --countries 时自动放大到 max(120*4, 500)
  --speed-limit <n>      进入测速的候选数，默认 30
  --speed-bytes <n>      测速字节数，默认 5242880
  --timeout <ms>         阶段一超时，默认 1200
  --seed <n>             采样随机种子，默认 24301
  --json                 以 JSON 输出结果
  --quiet                仅输出结果

serve 选项:
  --port <port>          监听端口，默认 ${DEFAULT_BRIDGE_PORT}
  --host <addr>          监听地址，默认 127.0.0.1

示例:
  ${NAME} scan --host cfpilot.example.com --token abc123
  ${NAME} serve
`
