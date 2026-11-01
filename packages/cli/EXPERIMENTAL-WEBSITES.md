# 实验性网站兼容性检测

`website-check` 检测用户显式指定的 HTTPS 目标，使用本机直连或指定 SOCKS5 代理路径。模块不绑定扫描候选 IP，不接入默认 `scan`、排序或回填，也不读写桌面扫描历史。结果只描述本次目标响应，不代表完整解锁、账号权限、地区资格、登录能力或全部目的站的行为。

```sh
cfpilot website-check --url https://site.example.com/check --label site --expected-text ready --proxy socks5://127.0.0.1:10808
```

`--expected-text` 可省略。代理也可从 `CFPILOT_EGRESS_PROXY` 环境变量提供；含凭据的代理应优先使用环境变量。不会读取或转发出口识别 token、UUID、面板凭据、Cloudflare Token、Cookie。远程 SOCKS5 自身不加密，应位于可信网络或受保护隧道内。

## 安全与预算

- 只接受 HTTPS，无 URL 用户信息和 fragment；拒绝私网/保留 IP 字面量与明显本地域名，允许本地 SOCKS5 代理。域名解析仍依赖操作系统或代理，应仅检测可信用户指定域名，不承诺防 DNS 重绑定。
- GET 请求，无浏览器脚本执行、登录、Cookie jar、重试或自动跟随重定向；SOCKS5 失败不回退直连。HTTPS 严格校验证书链与主机名。
- 每目标总超时最多八秒，包括 TCP、SOCKS5 握手、TLS 和正文接收；`--timeout` 只允许缩短。模块一次最多十个不同标签的目标，串行执行。
- 响应头最多 8 KiB；正文按实际字节最多 16 KiB，声明超限与流式超限均拒绝；不解压。为获得可判定结果，应选择小型健康检查路径，大页面超过预算归为 `invalid_response`，不能解释成网站不可达。
- `expectedText` 是最多 1024 UTF-8 字节的纯文本，不是正则。未配置时允许任意正文类型；配置时正文必须是合法 UTF-8 并包含该文本。
- 不输出响应体、Location、原始异常、代理凭据或 query；目标路径仍不应包含秘密。目标标签应为非敏感文本。

## 结果字段

```json
{
  "targets": [{
    "label": "site",
    "url": "https://site.example.com/check",
    "status": "ok",
    "httpStatus": 200,
    "challengeHeader": false,
    "ms": 120,
    "expectedContentOk": true,
    "transport": "socks5"
  }]
}
```

- `label`：用户标签，1–64 字符，不允许控制字符；同批不能重复。
- `url`：仅 origin 与 pathname，不保存 query。
- `status`：`ok` / `challenge` / `forbidden` / `rate_limited` / `tls_error` / `timeout` / `http_error` / `invalid_response`。
- `httpStatus`：HTTP 状态码，尚未收到响应时为 0。
- `challengeHeader`：仅准确收到 `cf-mitigated: challenge` 时为 true。也可从 HTML 中明确的 `/cdn-cgi/challenge-platform/` 脚本加载标记识别挑战，此时仍为 false；不会凭普通 challenge 单词判定。
- `ms`：从本次请求开始到完成或失败的耗时。
- `expectedContentOk`：仅执行正文条件时出现，表示是否满足该条件。
- `error`：可选固定中文说明，不回显原始网络错误。
- `transport`：`direct` 是 CLI 本机网络基线，`socks5` 是用户指定代理路径。

判定优先级：明确挑战头 → 403 `forbidden` → 429 `rate_limited` → 其他非 2xx（包括不跟随的 3xx）`http_error` → 压缩/超限响应 `invalid_response` → 明确挑战正文 → 可选正文条件 → `ok`。收到 2xx 不证明应用功能正常；应按目标服务选择独立、可解释的小型验证路径和正文条件。

独立模块 `src/experimental/website-compatibility.ts` 暴露 `probeWebsite` 与 `probeWebsites`，输出 `WebsiteTargetResult[]` 可嵌入 IP 质量报告的目标列表；不引入第三方运行时依赖。
