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

## 继续分析的边界

- 没有证据证明 Cloudflare 技术上要求拆分部署；现有拆分方案仅为已测试的临时安排。
- 不再通过混淆、改名、反复新建项目试探或规避明确的平台封禁。
- 应请求 Cloudflare 说明 Pages 限制原因，并关联失败 Ray ID 查询内部诊断。
- 代码审查候选仍需独立验证：WS wrapper 丢弃部分出站配置、ProxyIP/SOCKS5 映射、XHTTP 响应头、重复运行向导的 KV 与凭据保留。这些不应被描述为已修复或已证明的封禁原因。

## 验证

最近执行 npm run typecheck、npm test、npm run build 均成功，15 个测试文件、133 项测试通过。构建仍报告 vendor 重复键与数据面超过 80KB 的警告。本地通过不等于线上稳定可用。

历史排障记录见根目录 HANDOVER.md，其中旧结论以最新复核章节为准。
