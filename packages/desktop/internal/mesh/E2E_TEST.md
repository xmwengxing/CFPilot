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



