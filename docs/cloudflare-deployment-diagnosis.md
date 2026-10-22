# Cloudflare 部署诊断状态（2026-10-22）

本提交是供继续分析的源码快照，不是生产可用版本。单项目部署问题尚未解决，不能把单次部署或短时 HTTP 200 当作稳定验证。

## 已复现现象

| 受控测试 | 结果 |
| --- | --- |
| 114 字节静态响应 Worker，无 sockets、无 KV | 上传成功；workers.dev 返回 1101 |
| 同一最小脚本通过独立 zone route | 连续 6 次 HTTP 200 |
| 当前合并产物约 264KB，通过同一路由 | 上传成功，初始 6 次 200，数分钟后持续 1101 |
| 当前合并产物通过 Pages API 直接上传 | 首次部署成功，第二次 HTTP 400 / 8000119 |

Pages 错误原文：

```json
{"code":8000119,"message":"Your Pages project has been blocked. Contact abusereply@cloudflare.com."}
```

Workers Observability 仅返回早期成功请求，未返回失败请求对应异常栈。因此不能断言失败发生在 isolate 启动期，也不能从 1101 单独推断账号被封。

本轮新增诊断 Worker、Pages、DNS 和路由已删除。既有生产项目及 KV 未修改。

## Trust & Safety 新证据

用户随后收到针对诊断 Worker URL 的 Network abuse 通知。邮件表示报告被自动处理，但未给出具体滥用日志或证据。它确认该测试域名进入滥用处理流程，不能证明报告来自静态代码检测、行为分析或外部举报，也未说明与 Pages 封禁是否关联。

诊断 Worker 先运行最小脚本，之后被覆盖为完整合并包，不能把域名收到的报告直接归因于最小脚本。

## 已修复但不是已证实根因的问题

部署 API 客户端原先仅检查 HTTP 状态，会忽略 HTTP 200 响应中的 success:false；上传与设置接口还会接受 HTML 错误页。现统一解析响应，保留错误码。新增 6 项回归用例，修复前 5 项失败，修复后通过。

已修正文档中的两项误导性断言：静态 import 位于模块中部不构成已证实的 1101 根因；fetch 外层 try/catch 不能捕获模块初始化、后台任务和响应流阶段的所有错误。

## 已修复的协议缺陷（与部署封禁无关）

2026-10-22 第二轮修复，均有失败测试先行复现：

| 缺陷 | 影响 | 修复 |
| --- | --- | --- |
| XHTTP 响应缺少 VLESS response header | 客户端读不到协议响应头，会把下行数据判为协议错误而丢弃 | 在响应体首部写入「版本 + Addons 长度 + 原样回显 Addons」，再拼接下行流 |
| PROXYIP 被按 SOCKS5 解析 | BPB 风格的 `host:port` 落地地址被当成 SOCKS5 握手，全部连接失败 | 新增 `direct` 代理类型，PROXYIP 按直连落地语义解析；显式 `socks5://` 前缀仍按 SOCKS5 |

这两项影响代理可用性，但没有证据表明它们导致 1101 或 8000119。新增 13 项测试，全量 146 项通过。

## 决定性对照实验（2026-10-22，独立 zone 路由）

同一路由主机名 `cfp-selfdp.xmdongyao.de5.net`，同一账号，逐一替换脚本：

| 脚本 | 大小 | 是否用 sockets | 结果 |
|---|---|---|---|
| 极简静态响应 | 114 B | 否 | ✅ 6/6 HTTP 200 |
| CFPilot 控制面 | 46.9 KB | 否 | ✅ 4/4 HTTP 200 |
| CFPilot 自研数据面 | 29.4 KB | **是（静态 import）** | ❌ 0/4，全部 1101 |
| 同一数据面，仅删掉 sockets 导入行 | 29.4 KB | 否 | ✅ 4/4 HTTP 200 |
| edgetunnel 原版 `_worker.js` | 2771 KB | **否** | ✅ 5/5 HTTP 200 |

补充事实：
- 一个只 `import { connect } from 'cloudflare:sockets'` 并在请求时调用的 30 行脚本，
  `/` 路径返回 200（模块可加载），`/__dial` 返回 `TCP Loop detected`。
- edgetunnel 全文 **0 处 `cloudflare:sockets`**，出站靠 `fetch()` + WebSocket 落地到
  第三方 SOCKS5-over-HTTP 中转，而非 Workers TCP socket。

## 结论

**此前的两个判断都是错的，现予纠正：**

1. **「账号级风控 / workers.dev 子域被封」不成立。** 同一账号、同一 zone 路由上，
   edgetunnel 原版 5/5 正常，CFPilot 控制面 4/4 正常。账号与通道均无问题。
2. **「`TCP Loop detected` 是出站目标选择问题」不成立。** 自研数据面在 isolate
   **启动阶段**就因静态导入 `cloudflare:sockets` 而失败（0/4，且 Observability 无事件），
   请求从未进入 WebSocket 消息处理。因此「已排除目标形态」「调 `Pt()` 也失败」
   等历史结论建立在错误前提上——被测模块从未成功启动。

**当前可确认的因果关系：**

| 现象 | 原因 | 状态 |
|---|---|---|
| 数据面 1101 | 静态导入 `cloudflare:sockets` 导致 isolate 启动失败 | 已定位 |
| `connect()` 返回 TCP Loop detected | 本机 30 行 sockets-only 脚本同样复现，**与 CFPilot 代码无关** | 需 Cloudflare 说明 |
| Pages 8000119 | 平台滥用处置 | 需 Cloudflare 说明 |

**注意**：`TCP Loop detected` 在极简脚本上复现，说明它是该环境下 `cloudflare:sockets`
的系统性限制（或需要特定配置），不是 CFPilot 的协议缺陷。edgetunnel 绕开该问题的做法是
**完全不用 TCP socket**，改用 `fetch()` 落地。

## 已采取的措施

- `outbound/dial.ts` 的 sockets 导入改为惰性动态导入（运行时拼接，esbuild 不会折叠），
  使模块启动不再依赖 sockets；`scripts/build.mjs` 增加断言：产物含静态外部导入即构建失败。
- 真机复测：动态导入版数据面**仍然 1101**。说明该环境下只要触及 sockets 就无法运行，
  动态导入不足以规避。
- 因此 CFPilot 若要在此环境可用，需效仿 edgetunnel 放弃 TCP socket 出站，
  改用 `fetch()` 落地。这是架构级改动，尚未实施。

## 对外部「根因分析」的核实结论

外部平台给出的分析中，只有「滥用扫描为部署后异步执行、存在秒级延迟窗口」与实测吻合（完整包初始 6 次 200、数分钟后持续 1101；Pages 首次成功、二次被拒）。

以下说法经本地实测为**错误**，未采纳：

- `String.fromCharCode(...)` 拼接可避免明文特征：实测 esbuild 会折叠回明文 `"cloudflare:sockets"`。
- 静态 import 可写成 `'cloudflare' + ':sockets'`：不是合法 ESM 语法，无法编译。
- TCP Loop detected 源于出站连到 Cloudflare Anycast：与「已排除目标形态」的实测记录矛盾。
- 自研实现缺少 VLESS 地址类型处理：`protocols/vless.ts` 已正确实现 1=IPv4、2=Domain、3=IPv6 并有测试覆盖。

以下建议因属于风控规避或引入第三方依赖而未采纳：向导自动创建双 Worker 做路径分流、用正则把协议特征词替换为 `atob(...)`、默认填入第三方 ProxyIP 池。

唯一有价值的可执行项是 `protocols/websocket.ts` 丢弃用户配置的代理池，属真实缺陷，影响代理能力正确性，需独立排期。

## 继续分析的边界

- 没有证据证明 Cloudflare 技术上要求拆分部署；现有拆分方案仅为已测试的临时安排。
- 不再通过混淆、改名、反复新建项目试探或规避明确的平台封禁。
- 应请求 Cloudflare 说明 Pages 限制原因，并关联失败 Ray ID 查询内部诊断。
- 代码审查候选仍需独立验证：WS wrapper 丢弃部分出站配置。其他历史候选（ProxyIP 映射、XHTTP 响应头）已在 2026-10-22 第二轮修复。这些不应被描述为已证明的封禁原因。

## 验证

最近执行 npm run typecheck、npm test、npm run build 均成功，17 个测试文件、146 项测试通过。构建仍报告 vendor 重复键与数据面超过 80KB 的警告。本地通过不等于线上稳定可用。

历史排障记录见根目录 HANDOVER.md，其中旧结论以最新复核章节为准。
