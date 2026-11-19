# +mesh 真机 E2E 验收手册

> 2026-11-19 实测记录。这份文档存在的目的：**下次改动组网代码后，能按同样的步骤
> 在 10 分钟内证明「还能连通」**，而不是靠界面看起来正常。

## 拓扑

```
A（Windows / Linux 任选）         B（另一台机器）
  TUN cfpilot0  10.97.0.1           TUN cfpilot0  10.97.0.2
  UDP 51820                         UDP 51820
        └──────── 直连 UDP ──────────┘
```

- 两台机器的虚拟 IP 必须**同一 /24、末位不同**（TUN 固定按 /24 配置且不加对端主机路由）。
- 两端通过某个共同可达地址互连（同一局域网 / 覆盖网 / 公网 UDP 均可）。
- 两台都需放行 UDP 51820：
  - Windows：`New-NetFirewallRule -DisplayName "CFPilot Mesh UDP" -Direction Inbound -Protocol UDP -LocalPort 51820 -Action Allow`
  - Linux：`sudo ufw allow 51820/udp`（或直接关掉测试环境防火墙）

## 1. 生成两端配置

```bash
cd packages/desktop
go run ./cmd/mesh-e2e-gen -dir ../../e2e -addr-a <A 可达地址> -addr-b <B 可达地址>
```

输出 `e2e/mesh-A.json` / `mesh-B.json`：固定种子派生身份，`nodeId` 为 16 hex，
`staticPub` 为 64 hex（**面板/邀请链接同款编码**），正好覆盖 JSON 编解码路径。

## 2. 启动两端守护进程

Windows（需要管理员；`--console` 是调试用前台模式，正式安装走服务）：

```powershell
copy wintun.dll 到 exe 同目录（+mesh 安装包会自动做）
.\cfpilot-meshd.exe --console
```

Linux：

```bash
sudo ./cfpilot-meshd          # 前台；或装 deb 后 systemctl start cfpilot-mesh
```

## 3. 下发配置

```bash
curl -X POST http://127.0.0.1:19727/api/mesh/start \
     -H 'Content-Type: application/json' --data-binary @mesh-A.json
# 另一端同理用 mesh-B.json
```

## 4. 验收判据（缺一不可）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | `GET /api/mesh/status`（两端） | `running=true`、`peers[].state=已连接`、`online=true`、`handshakeOk≥1` |
| 2 | `peers[].rttMs` | 有真实数值（不是 0），与 `ping` 延迟量级一致 |
| 3 | `peers[].lossRate` | 稳定后接近 0（样本 <5 时按 0 上报，不误报） |
| 4 | A → B `ping 10.97.0.2` | ≥20 包，**0% 丢包** |
| 5 | B → A `ping 10.97.0.1` | ≥20 包，**0% 丢包** |
| 6 | 计数 | `txFrames`/`rxFrames` 随 ping 增长 |
| 7 | 重启 A（stop→start）后 ping | 自动重建会话；首包可能丢 1 个（拨号窗口），之后 0% |
| 8 | 重启 B（stop→start）后 ping | 同上 |
| 9 | `POST /api/mesh/stop` | 秒级返回（Windows <0.5s、Linux <0.1s），不得挂起 |
| 10 | 面板「组网状态」卡 | 每 2 秒刷新，节点/状态/RTT/丢包与 API 一致 |

## 5. 2026-11-19 实测结果（Windows ↔ Ubuntu，overlay 直连）

| 项 | 结果 |
|---|---|
| A→B | 20/20，0% 丢包，RTT 4–9ms |
| B→A | 20/20，0% 丢包，RTT 5–10ms |
| A 重启后 | 首次 ping 19/20（首包在握手窗口丢失），状态恢复「已连接」 |
| B 重启后 | A→B 10/10，0% 丢包 |
| stop | Windows 390ms；Linux 修复后 19ms（修复前 56s） |
| status | 实时反映 `handshakeOk/rtt/loss/tx/rx`（修复前是启动快照，永远全 0） |

## 6. 这一轮真机暴露并修掉的缺陷（防止回归）

1. **启动后不握手**：只在「有出站 IP 包」时才发起，双方都在等 → 永远没动静。
   现在：小 NodeId 启动即发 Init；探针 1s 循环（同时给 RTT、NAT 保活）；需要发数据
   而无会话时**强制发起**（`StartOutboundForce`）。
2. **状态快照不刷新**：meshd 返回的是 Start 时拍的快照 → 界面上永远 0。
   现在：每次请求都调用 `life.Status()`。
3. **Stop 死锁（两处）**：
   - 持 `m.mu` 调 `wg.Wait()`，而退出路径要拿同一把锁 → 永久挂起；
   - Linux TUN 阻塞读不会被 `close(fd)` 唤醒（实测 56s）→ 改 `poll(100ms)` + ctx。
4. **wintun 关闭函数名错**：写成 `WintunDeleteAdapter`（不存在）→ `syscall` panic、
   适配器永不清理。正确是 `WintunCloseAdapter`。
5. **重启后不重连**：一端重启，另一端仍持有失效会话且不会重新握手。
   现在：收到 Init 时若无 pending 即接受（旧会话在新 KeyMaterial 到达后才替换，
   不会被伪造 Init 直接打掉）；需要发数据时强制发起 Init。
6. **JSON 字段**：`nodeId`（16 hex）与 `staticPub`（64 hex）此前没有 JSON 编解码，
   面板一点启动就 400。现在同时接受 hex 与 base64。
7. **网络名静默丢失**：UI 键名 `network` 与 Go 字段 `NetworkName` 不匹配 → 恒为空。

### 6.1 P4-lite：去覆盖网的真实内核验证（netns LAN，2026-11-19 实测）

在 Ubuntu 上用两个 network namespace + veth 组成直连 LAN（**不经过 easytier**），
每个 netns 内跑真实 meshd + TUN：

```bash
sudo ip netns add n1; sudo ip netns add n2
sudo ip link add v1 type veth peer name v2
sudo ip link set v1 netns n1; sudo ip link set v2 netns n2
sudo ip netns exec n1 ip addr add 192.168.50.1/24 dev v1; sudo ip netns exec n1 ip link set v1 up
sudo ip netns exec n2 ip addr add 192.168.50.2/24 dev v2; sudo ip netns exec n2 ip link set v2 up
# 每个 netns 内启动 meshd 并 POST 对应配置（对端地址填 192.168.50.x:51820）
sudo ip netns exec n1 /tmp/cfpilot-meshd
```

实测（2026-11-19）：

| 项 | 结果 |
|---|---|
| `ping 10.97.0.2`（n1→n2） | **10/10，0% 丢包，RTT 0.36–0.57ms** |
| 状态 | 两端 `已连接`、`via=udp`、`addr=192.168.50.x`、`handshakeOk=1` |
| 计数 | tx/rx 随 ping 增长，txDropped/rxDropped 0 |

结论：数据面与握手在不依赖覆盖网的真实内核栈上可用；这条证据**只覆盖同 LAN 直连**，
不代表跨 NAT 打洞已验收（后者需要真实 NAT + 中继信令）。

### 6.2 P4：两台真实机器（Windows 主机 ↔ Ubuntu VM，VMware LAN）

`win` 主机（192.168.107.1）与 Ubuntu VM（192.168.107.128）在同一 VMware 网段，
数据路径不经 easytier（对端地址直接用 LAN IP）：

| 项 | 结果（latest meshd，含 STUN/Punch） |
|---|---|
| Windows → Ubuntu `ping 10.97.0.2` | 9/10（首包在握手窗口丢失），之后 0% |
| Ubuntu → Windows `ping 10.97.0.1` | **10/10，0% 丢包，RTT 0.63–0.92ms** |
| 两端状态 | `已连接`、`via=udp`、`addr=192.168.107.x`、`handshakeOk≥1`、`natType=Unknown` |
| 计数 | tx/rx 随 ping 增长，Ubuntu 侧 txDropped/rxDropped 0 |

`natType=Unknown` 是因为两台机器都在 VMware NAT 后面、公共 STUN 端点不可达
（不是实现故障）；真实跨 NAT 打洞需要能访问公网 STUN + 中继信令的环境。

### 6.3 节点转发（P4 前置，已实现）

非本机目标的帧按 32B 头 `dst` 转发给已知链路：TTL-1、置 RELAYED、version/key_meta
与载荷原样保留（改这些会让接收侧 AEAD 失败）；广播帧向除来源外扇出并本地继续处理。
单测覆盖：已知目标转发/来源不回发/TTL=0 丢弃/未知目标不吞帧/广播扇出。

用途：为「打洞信令经第三方节点中转」提供最小转发能力；仍缺 MobiHop Router 的
路由表与多跳寻路。

### 6.4 P4：经盲中继的真机打洞（未成功，如实记录）

拓扑：本机 Win（192.168.31.19）↔ 另一台 Win（192.168.31.139，同一 LAN），
经已部署盲中继 `edge.shijingtian.dpdns.org` 房间 `0123456789abcdef` 作信令。

实测结果（2026-11-19）：

| 项 | 结果 |
|---|---|
| WSS 中继握手 | **成功**：两端 `handshakeOk=1`、`via=wss`、RTT 1–5ms |
| 切 WSS 后主动打洞 | 已触发（日志「经中继向 xxx 发起打洞（候选 6 个）」） |
| 打洞升级直连 | **未成功**：`via` 始终停在 wss；`txFrames` 暴涨（探针在发）但 `rxFrames` 不增长 |
| STUN | `natType=Unknown`（四个公共 STUN 端点在本环境均不可达，无 reflexive 候选） |
| 双向 ping | B→A 通（450ms，走中继绕道）；A→B 100% 丢包 |

结论与待查：中继路径（P1）已真机验证可用；打洞（P3）代码已触发但未能完成升级。
可能原因：对端 active link 为 WSS 时，打洞探针发到其 UDP 端口后由 UdpHub.demux
接收，但当前接收循环绑在 WssLink 上，来自 UDP 候选地址的探测帧未被处理
（待下一轮在 dispatch/recv-loop 层对齐）。此状态**不算跨 NAT P2P 已验收**。

### 6.5 按 CROSS_PROJECT_SYNC 2026-11-19 追加节对齐

MobiHop 在干净环境（去 easytier）实测确认：同 LAN 双向 20/20、盲中继 WSS 20/20、
公共 STUN 可用（NAT3）；打洞失败是 netlab 装置语义（端口受限 masquerade）所致，
不是本体缺陷。wire 层无需变更，需对齐三个语义：

1. **HolePunch/RelayMgmt 走独立入站观察通道**：UdpHub.dispatch 在分流前按真实源地址
   交给 onControl，不进活跃 link 的 recv 队列（MobiHop hub.rs:386-393）。
   Go 侧 handlePunch 改为接收 remote 地址，Ack 直接回 remote。
2. **专用服务器中继（兜底）**：Config.RelayServers（node_id/addr/token），
   启动注册（RelayMessage.Register，token_hash=BLAKE3(token)）、收 AuthAccept 后心跳；
   与盲中继 WSS 独立，属于「直连/WSS 都不可达」的最后兜底。
3. `via` 映射：MobiHop 只有 direct/relay；CFPilot 的 wss 作为链路类型保留，
   但打洞判据不再依赖 via（观察通道与链路无关）。

### 6.6 服务器中继（专用 UDP 中继）验证

在阿里云 ECS（47.104.173.139）上启动 `mobihop-relay --listen 0.0.0.0:51830 --token ...`
（Token 模式，node_id=`8ea88f9c44e6e219`），本机 A 配置 `RelayServers` 后：

- 本机日志：`专用服务器中继已启用（1 台）` ⇒ 配置解析与注册循环启动正常；
- 系统 firewalld 已放行 51820/51830 udp，中继进程与端口正常（`ss -lunp` 可见）；
- 改用已放行的 **51820** 后，**裸 UDP 包仍到不了**（ECS 中继 `rx_packets=0`）⇒
  云厂商**安全组**未放行该端口 UDP（系统防火墙之外的一层）。本机无阿里云 CLI/AccessKey，
  无法自行改安全组 ⇒ 未能完成端到端注册验收。

结论：服务器中继的**代码路径已就绪**（配置/Register 帧/心跳/观察通道均有单测），
端到端只差云服务器安全组放行对应 UDP 端口。用户如需使用，须在阿里云控制台
放行 UDP 51820（或所选端口）的入站规则。

## 7. 已知限制（不是 bug）

- 握手窗口内的第一个 IP 包会被丢弃（未实现拨号期排队），表现为新建会话时首包丢失。
- 暂不支持子网网关 / 广播转发；虚拟网段广播包被静默忽略。
- WSS 降级路径（EnableDegrade）不在本手册覆盖范围，需要另配盲中继后单独验证。
- **NAT 穿透正在补齐**：P2 已实现 STUN 探测（复用 UdpHub 同一 socket、
  XOR-MAPPED-ADDRESS、映射一致性判定 NAT3/NAT4，保守不做 CHANGE-REQUEST 细分）；
  Punch 编排（P3）已补最小子集：经中继会话建立后自动发 PunchRequest/Reply、
  双方按 100ms 向候选喷洒 PunchProbe、收到 PunchAck 才升级直连；
  失败保持中继。**尚未在真实 NAT 环境验收**（缺两台去覆盖网的机器）。
  当前可用形态：对端地址本身可达时直连；跨 NAT 走中继（WSS）；打洞是尽力而为的升级。
  （同一局域网、公网 IP+端口映射、或覆盖网）时才能直连。通过 easytier 跑通不等于有 P2P
  能力 —— 那是覆盖网提供了可达地址。要验证真实 P2P，必须去掉覆盖网，
  在两台真实机器上测试（同 LAN 或公网端口映射）。











