# 归档：自研 WebSocket 数据面

归档时间：2026-10-22

## 为什么归档

该实现本地 161 项测试全绿，但真机对照实验证明：**该部署环境下只要触及
`cloudflare:sockets` 就无法运行**。同一 zone 路由、同一账号：

| 脚本 | sockets | 结果 |
|---|---|---|
| 极简静态响应 114B | 否 | 6/6 正常 |
| CFPilot 控制面 46.9KB | 否 | 4/4 正常 |
| **自研数据面 29.4KB** | 静态 import | **0/4 全部 1101** |
| edgetunnel 原版 2771KB | 否 | 5/5 正常 |

一个只导入 sockets 的 30 行脚本同样复现 `TCP Loop detected`，与 CFPilot 代码无关。
edgetunnel 的做法是**完全不用 TCP socket**，改用 `fetch()` 落地。

## 文件清单

| 文件 | 说明 |
|---|---|
| `websocket-selfdeveloped.ts` | 完整自研 WS 数据面（355 行）：协议解析、攒包、101、响应头、中继 |
| `doh.ts` | DoH 解析（cloudflare-dns / alidns / doh.pub 三提供商故障转移），TXT 优选库 → A → AAAA |
| `colo-relay.ts` | Cloudflare 网段判定 + 机房区域映射；含 CIDR 32 位符号位 bug 修复 |
| `websocket.test.ts` | 4 项端到端测试（真实 socket 对，非 mock） |
| `doh.test.ts` | 11 项测试（CIDR 边界、IPv6、splitHostPort） |
| `ws-shim.d.ts` | `ws` 库最小类型声明（测试环境用） |

## 借鉴来源（实现时参考）

- **CFNext / edgetunnel**：DoH TXT 优选 IP 库 + 落地 IP 竞速
- **BPB**：101 后先回 VLESS 协议响应头，再中继数据
- **cfnew**：首包数据缓存，避免分帧与竞速期间丢数据

## 若要重新启用

需要先解决 sockets 不可用问题，两条路：

1. **改成 `fetch()` 出站**（edgetunnel 路线）——放弃 TCP socket，
   依赖第三方 HTTP 中转落地。架构级改动，会失去 ProxyIP / NAT64 / SOCKS5 出站能力。
2. **等 Cloudflare 说明 `TCP Loop detected` 的触发条件**——若可配置解除，
   自研实现可直接恢复。

恢复方式：把本目录文件复制回 `packages/worker-core/src/` 对应位置，
并将 `src/protocols/websocket.ts` 改回自研版本。

## 已知缺陷（归档时未修）

`websocket-selfdeveloped.ts` 中 `pickOutbound()` 的代理分支逻辑较为粗糙：
同区域过滤条件写的是 `p.kind === 'direct'`，会把 SOCKS5/HTTP 代理全部滤掉。
归档未修，恢复时需重写该函数。
