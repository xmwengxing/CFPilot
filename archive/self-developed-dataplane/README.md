# 归档：自研 WebSocket 数据面

归档时间：2026-10-22

## 为什么归档

> ⚠️ **2026-10-23 更正**：本节原结论「只要触及 `cloudflare:sockets` 就无法运行」
> **已被真机实验推翻**。详见 [docs/self-developed-dataplane-design.md](../../docs/self-developed-dataplane-design.md) §1。
> 正确结论是：**静态导入 sockets 不会导致 1101**，失败发生在**运行时出站**——
> Worker 不能主动连回 Cloudflare 自家 Anycast 地址（`1.1.1.1` / `cloudflare.com` / `104.16.0.1` 等一律被拒）。
> 而本实现的出站选路**必然**踩到这些地址，因此表现为「永远连不上」。
>
> 下表是当时的对照实验记录，保留供追溯；其中「静态 import → 0/4 全部 1101」一行
> **已被证明与 sockets 无关**，真实差异在于出站目标。

该实现本地 161 项测试全绿，但真机部署后代理链路始终不通。同一 zone 路由、同一账号：

| 脚本 | sockets | 结果 |
|---|---|---|
| 极简静态响应 114B | 否 | 6/6 正常 |
| CFPilot 控制面 46.9KB | 否 | 4/4 正常 |
| **自研数据面 29.4KB** | 静态 import | **0/4 全部 1101** |
| edgetunnel 原版 2771KB | 否 | 5/5 正常 |

（2026-10-23 更正：上表第三行当时被归因于「静态 import sockets」，
实际是**出站选路必然连向 Cloudflare 自家 IP**；与 import 形式无关。
另注：edgetunnel 原版根本不用 `cloudflare:sockets`（实测 0 次引用），
它用 `fetch()` + HTTP 代理隧道落地。）

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

**不需要解决「sockets 不可用」——它可用**，需要解决的是**出站选路**：

1. **出站目标不能是 Cloudflare 自家 IP**。这是失败的直接原因（§1.2 实测）。
2. **优选 IP 库不能只装 CF 网段**：CFNext 用的是**域名**（`proxyip.hk.<域名>` 等）
   解析出来的 IP，未必落在 CF Anycast 段。
3. **同区域过滤条件写错了**：`p.kind === 'direct'` 会把 SOCKS5 / HTTP 代理全滤掉，
   退化成直连 CF IP（见下方「已知缺陷」）。
4. **失败必须可诊断**：现在 `tryDial` 的 catch 把异常吞掉只返回 null，
   于是每一层失败都表现为「目标不可达」，看起来像死循环。

新设计的完整方案见 [docs/self-developed-dataplane-design.md](../../docs/self-developed-dataplane-design.md)。

恢复方式：把本目录文件复制回 `packages/worker-core/src/` 对应位置，
并将 `src/protocols/websocket.ts` 改回自研版本。

## 已知缺陷（归档时未修）

`websocket-selfdeveloped.ts` 中 `pickOutbound()` 的代理分支逻辑较为粗糙：
同区域过滤条件写的是 `p.kind === 'direct'`，会把 SOCKS5/HTTP 代理全部滤掉。
归档未修，恢复时需重写该函数。

**2026-10-23 补充**：这个缺陷比归档时认识的更致命 —— 它使流程退化成
「直连优选 IP 库里的 CF 网段地址」，而那些地址在 Worker 运行时**必然**被拒
（`TCP Loop detected`）。配合「异常被 catch 吞掉」，
就形成了「永远部署不了、且日志里找不到任何线索」的死循环。

修复清单见 [docs/self-developed-dataplane-design.md](../../docs/self-developed-dataplane-design.md) §2。
