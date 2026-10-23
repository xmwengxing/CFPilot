# 自研数据面本地端到端验证

用 **本地 workerd**（`wrangler dev --local`）验证自研数据面（`DATAPLANE=self`）的
完整链路：VLESS 握手 → 出站建连 → 请求转发 → 响应回传。

## 为什么值得做

**本地 workerd 完整支持 `cloudflare:sockets`** —— 实测导入、`connect()`、
真实数据交换全部成功。因此不必反复撞真机 Cloudflare 边缘对 WS 升级流量的
间歇性拦截（见 `docs/self-developed-dataplane-design.md` §1.4c）就能把
出站链路验完。

推荐节奏：**本地验功能正确性 → 真机只做最终确认**。

## 组成

| 文件 | 作用 |
|------|------|
| `entry.ts` | 测试 Worker 入口：走自研数据面，暴露 `/__probe`、`/__diag`、`/vl` |
| `wrangler.jsonc` | 本地运行配置（`DATAPLANE=self`） |
| `echo-server.mjs` | **明文 HTTP 回显服务器**（出站目标，端口 18080） |
| `socks5-proxy.mjs` | 最小 SOCKS5 代理（端口 11080），带连接日志 |
| `suite.mjs` | 完整测试套件（7 项断言） |
| `client.mjs` | 单次 VLESS 会话客户端 |
| `probe2.mjs` | 多次采样统计（WS 升级 / VLESS 响应 / 真实 HTTP 响应） |

## 用法

### 1. 起出站目标（明文 HTTP 回显服务器）

```bash
node echo-server.mjs
# [echo] 明文 HTTP 回显服务器已启动: http://127.0.0.1:18080
```

> ⚠️ **必须用明文 HTTP 目标站**。VLESS over WebSocket 是 **TLS 透传代理**：
> TLS 由客户端与目标站直接完成，Worker 只透传字节（见设计文档 §1.4d）。
> 用明文 HTTP 去请求 **HTTPS** 站当然拿不到响应 —— 那是验证方法错误，不是实现缺陷。

### 2. 起本地 Worker（workerd）

```bash
npx wrangler dev --port 8787 --ip 127.0.0.1 --local
```

### 3. 跑测试套件

```bash
node suite.mjs ws://127.0.0.1:8787/vl
```

预期 7/7 通过：

```
✅ VLESS 响应头 [0,0] — 收到 [0,0]
✅ 目标站响应回传 — 446 字节
✅ 目标站收到正确请求 — GET /echo
✅ 1MB 负载逐字节完整 — 收到 1048576 / 1048576 字节
✅ 错误 UUID 被拒绝（无响应头） — 未收到响应头
✅ 错误 UUID 无数据回传 — 0 字节
✅ 不可达目标给出分级诊断 — closeReason=出站失败（…）
```

### 4.（可选）验证代理路径

```bash
node socks5-proxy.mjs          # 另开一个终端
node suite.mjs "ws://127.0.0.1:8787/vl?proxy=socks5%3A%2F%2F127.0.0.1%3A11080"
```

代理日志会打印 `CONNECT #N → host:port` 与隧道字节数，
可据此确认**出站确实经由代理**（而不是静默直连）。

### 5.（可选）真机多次采样

```bash
node compare.mjs 15 tls
```

对照实验脚本：同一时段交替采样 vendor 与 self 两个实例，
输出 `upgrade` / `vless` / `httpOk` 三个计数。
环境变量 `SELF_HOST` / `SELF_PATH` / `SELF_UUID` 指定 self 实例。

### 6.（可选）代理路径验证

```bash
node probe2.mjs "ws://127.0.0.1:8787/vl?proxy=127.0.0.1%3A11080&proxyKind=socks5"
```

`probe2.mjs` 是「从 Cloudflare 边缘探测代理可用性」的 Worker 脚本
（`kind=socks5|http|https`），可用来批量筛出从边缘可达的公共代理。

### 7.（可选）HTTPS 代理（TLS）验证

```bash
python3 tls-proxy.py --port 39190 --cert cert.pem --key key.pem
node suite.mjs "ws://127.0.0.1:8787/vl?proxy=127.0.0.1%3A39190&proxyKind=https"
```

> ⚠️ **本地 workerd 拒绝连私有 IP**（`127.0.0.1` / `192.168.x`），
> 报错文案与真机的「CF 网段被拒」**完全一样**：
> 「proxy request failed, cannot connect to the specified address」。
> 所以本地验 HTTPS 代理要**用公网可达的代理**，
> 或者把探针部署到 Pages 做真机实验。

`probe-starttls.ts` 是 TLS 模式的最小探针，可部署到 Pages 直接对比
`'on'` 与 `'starttls'` 在**真实 Cloudflare 边缘**上的行为：

```bash
npx wrangler dev --config wrangler.starttls.jsonc --port 8788 --local
curl 'http://127.0.0.1:8788/?host=example.com&port=443&mode=starttls'
```

**判读要点**：`socket.secureTransport` 是只读 getter
（返回 `"off" | "on" | "starttls"`）—— 打印它就能确认 `secureTransport`
有没有真的传进运行时。`connect(address, options)` 的 **options 是第二个参数**，
塞进第一个会被静默忽略（详见 AGENTS.md 铁律 22）。

## 工具清单

| 文件 | 作用 |
|------|------|
| `clienthello.mjs` | 构造**真实** TLS ClientHello（手写简化版会被目标站 RST） |
| `capture-clienthello.mjs` | 从 Node 的 tls 抓真实 ClientHello（备选） |
| `compare.mjs` | vendor vs self 对照实验（交替采样） |
| `suite.mjs` | 完整测试套件（7 项断言） |
| `client.mjs` | 单次 VLESS 会话客户端 |
| `probe2.mjs` | 代理探测器 Worker（socks5 / http / https 握手 + 目标响应） |
| `echo-server.mjs` | 明文 HTTP 回显服务器（出站目标） |
| `socks5-proxy.mjs` | 最小 SOCKS5 代理（带连接日志） |
| `tls-proxy.py` | 本地 **TLS 1.3** 代理（HTTPS 代理出站验证用） |
| `probe-starttls.ts` + `wrangler.starttls.jsonc` | TLS 模式探针（`'on'` vs `'starttls'` 对照，可部署到 Pages 做真机实验） |
| `entry.ts` / `wrangler.jsonc` | 本地测试 Worker 入口（`DATAPLANE=self`） |
| `trojan-e2e.mjs` | 真实 Trojan 握手端到端测试 |
| `xhttp-test.mjs` | XHTTP（stream-one）入站端到端测试 |
| `final-check.mjs` | 单次 VLESS 会话快速自检 |
| `clienthello.mjs` | 构造真实 TLS ClientHello（必需，手写简化版会被目标站 RST） |

> ⚠️ `trojan-e2e.mjs` 依赖 `trojan-proto.mjs`（由 `npm run e2e:build` 从
> `src/protocols/trojan.ts` 生成 —— Node 的 crypto 不支持 SHA-224）。

## ⚠️ 测试方法本身的坑（比实现 bug 更浪费时间）

1. **自制 WS 客户端会被 Cloudflare 边缘拒绝** —— 原始 TCP + 手写握手 → 400，
   而 `ws` 库能过。测 IP 可用性用 `curl --resolve` 或 `ws` 库，别用自制客户端。
2. **每次部署后数据面域名都会变**（8000119 换名）——
   测试脚本必须用**当前**域名，否则会全部打在已删除的旧项目上。

## ⚠️ 三个只有真机才暴露的实现坑

1. **workerd 的文本帧（opcode 1）不进服务端二进制分支** —— 必须发二进制帧。
2. **close frame 的 reason 超 123 字节会被 Cloudflare 边缘静默丢弃** ——
   客户端表现为「一直连着但永远等不到关闭」。
3. **代理握手必须带超时** —— 代理连上但不回应时，无超时的读取会永远挂起。

（详见 `docs/self-developed-dataplane-design.md` §1.4d 与第四阶段章节。）

## 两个必须知道的坑

1. **必须发二进制帧（opcode 2）**。
   workerd 对文本帧（opcode 1）的处理与二进制帧不同 ——
   文本帧不会进入服务端的二进制处理分支，**服务端收不到任何字节**。
   用 `ws` 库时传 `Buffer` 即可（不要传字符串）。

2. **VLESS 地址字段的长度字节不能被域名首字符覆盖**。
   布局是 `[地址类型(1)] + [长度(1)] + [域名内容]`。
   若写成 `[地址类型] + 域名内容`，域名首字符（如 `'1'` = 0x31）会占掉长度字节，
   解析结果完全错乱（表现为「发送成功但服务端毫无反应」）。

## 相关文档

- `docs/self-developed-dataplane-design.md` —— 架构设计与真机实验结论
- `HANDOVER.md` §0.20.9 —— 真机验证记录
