# 实验性指定路径出口识别

`egress-identify` 仅调用用户自有识别服务，不使用公共第三方识别接口，也不接入默认 `scan`、优选排序、回填或 Worker 内核。它报告的是**指定传输路径**的观察结果：直连是 CLI 本机网络基线；`--proxy` 是用户指定 SOCKS5 代理路径。它不绑定候选 IP，不证明不同入口 IP 的出口不同，也不证明所有目的站均走同一出口。

## 调用

```sh
cfpilot egress-identify --url https://identity.example.com/identify
cfpilot egress-identify --url https://identity.example.com/identify --proxy socks5://127.0.0.1:10808
```

可选鉴权通过 `CFPILOT_EGRESS_TOKEN` 和 `CFPILOT_EGRESS_TOKEN_EXPIRES_AT` 环境变量提供；过期时间必须为带时区 RFC3339，剩余有效期须大于零且不超过五分钟。CLI 不签发令牌，也不能从不透明 token 判断服务端真实有效期；服务端必须独立校验签名或随机 token、有效期和专用识别权限，推荐单次使用、至少 128 bit 随机熵。不要复用 UUID、面板密码、扫描令牌或 Cloudflare Token。

SOCKS5 支持无认证及用户名/密码认证。包含凭据时通过 `CFPILOT_EGRESS_PROXY` 提供代理 URL，避免进入命令行历史。令牌和代理凭据不落盘、不写入结果或网络错误。代理握手失败直接失败，绝不回落直连。SOCKS5 自身不是加密协议，远程代理应置于可信网络或已加密隧道中；识别服务 HTTPS 证书仍严格校验。

## HTTP 协议 v1

- 服务地址仅接受 HTTPS，禁止 URL 用户信息和 fragment，拒绝私网/保留地址字面量及明显本地域名。仅允许用户明确拥有并信任的服务域名；代理侧 DNS 由代理负责，本模块不承诺阻止恶意域名解析或 DNS 重绑定。
- 发起一次 `GET`，发送 `Accept: application/json`、`Accept-Encoding: identity`、`Cache-Control: no-store`；可选 `Authorization: Bearer <短期token>`。不添加 X-Forwarded-For 或任何面板/部署凭据。
- 不重试、不跟随重定向、不使用系统代理隐式改变路径。SOCKS5 CONNECT 的域名目标由代理解析；IP 字面量使用对应 IPv4/IPv6 地址类型。
- 总超时八秒，覆盖代理 TCP/认证/CONNECT、TLS、HTTP 响应头和全部响应体，可用 `--timeout` 缩短；响应头最多 8 KiB，正文最多 16 KiB，按实际接收字节计数，不能靠省略或伪造 Content-Length 绕过。
- 只接受 HTTP 200、`application/json`（可带 charset 参数）、无压缩响应和合法 UTF-8 JSON；其他状态、压缩、HTML、截断、流式超限均失败。

响应示例：

```json
{
  "remote_ip": "8.8.8.8",
  "observed_at": "2026-11-01T04:00:00Z",
  "egress_kind": "user-proxy",
  "colo": "HKG"
}
```

- `remote_ip` 必须是服务端从**实际 TCP 对端**取得的公网 IPv4/IPv6 字面量，不允许域名、端口、私网、组播、文档、映射或转换地址。服务部署在可信反代后时，必须由受控服务链确认真实对端；不得直接信任客户端提交的 XFF、Forwarded 或 query。
- `observed_at` 是服务端本次观察的 RFC3339 时间，必须显式带时区；未来最多容差 30 秒，超过五分钟的观察失效。服务端应返回 `Cache-Control: no-store`，不缓存鉴权响应。
- `egress_kind`、`colo` 可省略；若存在必须是 1–128 字符的无控制字符文本。这些字段是用户自有服务的声明，不代表 CLI 独立验证的网络归属。
- 额外字段一律不透传；结果输出 `remoteIp`、`observedAt`、`fetchedAt`、`ageMs`、`transport` 和可选标签。`sourceUrl` 只保留 origin 与 pathname，丢弃 query，服务 URL 路径仍应避免放入秘密。

独立模块 `src/experimental/egress-identity.ts` 暴露 `identifyEgress` 和纯结果校验方法，无第三方运行时依赖。失败返回稳定的 `code` 与中文说明，不回显原始异常、响应正文、URL query 或代理凭据。
