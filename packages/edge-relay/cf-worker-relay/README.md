# MobiHop CF 边缘盲中继（P4.2）

零知识、房间隔离的 WebSocket 边缘中继：**Cloudflare Workers + Durable Objects**。
把 P2.2 的「盲中继房间模型」搬到 CF 边缘，让双端无公网 IP 的节点经 WSS 完成首次发现与
保底互通，而不需要任何 VPS。

> **安全边界（与 ADR-0010 一致）**：TLS 只是传输伪装层，**不是身份认证层**。
> 端到端身份仍由 MobiHop Noise IKpsk2 握手 + E2E AEAD 保证；本中继只看 32B 明文头，
> 绝不解密载荷、不持有任何网络密钥。

## 目录

```
edge/cf-worker-relay/
├─ wrangler.toml          # DO 绑定 + migrations + 限速变量
├─ src/
│  ├─ index.ts            # Worker 路由 + MeshRoom Durable Object（Hibernation API）
│  ├─ proto.ts            # 纯函数：帧头解析 / 转发决策 / TTL 改写 / 滑动窗口
│  └─ cf.d.ts             # 离线可用的最小 CF 类型声明
├─ test/proto.test.mjs    # node --test：协议纯函数覆盖（零依赖）
└─ test/do.test.mjs       # node --test：Worker 路由 / DO 转发语义（内存 fake）
```

## 协议

- 路由：`wss://<domain>/mesh/<network_hash>?peer_id=<16 hex>`
  - `network_hash`：8–64 位小写 hex；**同名 = 同一个 Durable Object 实例 = 一个房间**；
  - `peer_id`：16 位小写 hex（MobiHop NodeId）。
  - 推荐把 `network_hash` 取为 **PSK 派生**值（如
    `hex(BLAKE3_keyed(psk, "mobihop/edge-room/v1"))`，64 hex），避免网络名可枚举
    （与 ADR-0009 的 `room_tag` 同一思路；`network_id` hex 也可用作兼容值）。
- 帧：一个 WS 二进制消息 = 一个完整 MobiHop 帧（32B 头 + 载荷，≤ 1432 字节）。
  `magic=0x4D`、`version=0x01`、`dst@16..24`（全 `0xFF` = 广播）。
- 转发：单播按 `dst` 的 peer_id 找目标连接；广播发给房间内**除发送方外**全部连接；
  未知目标 / 自我单播 / TTL 耗尽 / 超长 / 畸形一律丢弃并计数。
- 限速：**每连接**滑动窗口（默认 1000ms / 1 MiB / 2000 pkt，可用变量覆盖），
  语义与 P2.2 中继一致；被拒帧不计入已准入流量。
- 零知识：日志只有 `room` **前 4 字符** + `peer_id` + 包长；绝不打印载荷；
  DO 不落盘任何载荷（仅内存限速窗口 / 计数，Hibernation 唤醒后重置）。
- 同一 `peer_id` 重连：新连接踢掉旧连接（close code 4001），避免同一 NodeId 双链路。

## 部署

```bash
cd edge/cf-worker-relay
npm install                     # 安装 wrangler + typescript（需联网）
npx wrangler login              # 登录 Cloudflare 账号
npx wrangler deploy             # 部署 Worker + DO（首次自动创建 v1 迁移）
```

自定义域名（推荐，WSS URL 使用该域名）：

```toml
# wrangler.toml
routes = [{ pattern = "edge.example.com", custom_domain = true }]
```

限速 / 容量变量（dashboard 或 `wrangler deploy --var`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDOW_MS` | `1000` | 滑动窗口长度 |
| `MAX_BYTES_PER_WINDOW` | `1048576` | 每连接窗口字节上限 |
| `MAX_PACKETS_PER_WINDOW` | `2000` | 每连接窗口包数上限 |
| `MAX_PEERS_PER_ROOM` | `512` | 单房间连接上限（硬上限 4096） |

部署后验证：

```bash
curl -i "https://<domain>/mesh/0123456789abcdef?peer_id=0011223344556677" \
  -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
# 期望 HTTP/1.1 101 Switching Protocols
```

## 客户端配置（Rust 节点）

```toml
[[seeds]]
addr = "100.64.0.1:51820"             # 仍需要填写（UDP 侧占位；ws_only 时可不建 UDP）
node_id = "<对端 NodeId>"
ws = "wss://edge.example.com/mesh/<network_hash>?peer_id=<你的 peer id>"
# CF 公共证书会轮换，pinning 不适用；TLS 仅伪装层（身份由 Noise/E2E 保证）
ws_insecure_skip_verify = true         # 仅当无法 pin 证书时；生产请评估
ws_connect_ip = "198.51.100.7"         # P4.2：CF 优选 IP（只改 TCP 目标，SNI/Host 不变）
```

`ws_connect_ip` 是 P4.2 新增的可选字段：TCP 连到优选 IP，但 TLS SNI / HTTP `Host` /
WebSocket 握手 URL 仍是 `ws` URL 的原域名（证书按原域名校验，路由按原域名解析）。

## 本地验证

```bash
node --test test/*.test.mjs          # 协议 + Worker/DO 语义（17 项，零依赖）
npx tsc --noEmit -p tsconfig.json    # 类型检查（离线可用 ui/node_modules 的 tsc）
```

> 无 CF 账号时**未真机部署**：真实全球边缘 RTT、Hibernation 实测均未跑。
> 详见 `docs/reports/P4.2-cf-edge-relay.md`。

## 运维要点

- 升级：`npx wrangler deploy` 即可；DO 迁移用 `wrangler.toml` 的 `migrations` 追加 tag。
- 观测：`npx wrangler tail` 看 `[mh-edge]` 日志（只有 room 前 4 字符 / peer / 包长）。
- 容量：单房间受 `MAX_PEERS_PER_ROOM` 限制；跨房间天然分片（每 room 一个 DO 实例）。
- 滥用：限速 + 房间名白名单；若遭扫描，建议把 `network_hash` 换成 PSK 派生的不可枚举值。
