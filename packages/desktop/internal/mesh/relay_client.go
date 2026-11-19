//go:build mesh

package mesh

import (
	"context"
	"log"
	"net"
	"time"

	"github.com/zeebo/blake3"
)

// 专用服务器中继客户端（对齐 MobiHop node.rs 的 relay_control_loop）。
//
// 语义：
//   - 启动时向每台中继的 UDP 地址发一次 Register（0x06 RelayMgmt）；
//   - token 只以 BLAKE3(token) 摘要上线，原文不落盘/不进日志；
//   - 收到 AuthAccept 后按 heartbeat_interval_ms 周期发 Heartbeat；
//   - 注册失败/超时只记日志，不影响直连，中继是兜底不是必需。
//
// 本客户端维持「中继注册状态」（RelaySession），供上层选路把中继作为兜底 neck。
// 它**不**替换 peer 的 PeerLink —— 那由 WSS 降级/打洞链路统一管理，避免两套机制打架。

// relayRegisterIntervalMS 是注册重试间隔（未收到 AuthAccept 时）。
const relayRegisterIntervalMS = 5000

// tokenHash 计算中继准入令牌摘要：BLAKE3(token_string)。
// 对齐 MobiHop `blake3::hash(t.as_bytes())`。
func relayTokenHash(token string) []byte {
	h := blake3.Sum256([]byte(token))
	return h[:]
}

// RelaySession 是与一台中继的注册会话状态。
type RelaySession struct {
	NodeID              NodeID
	Addr                string
	SessionID           uint64
	HeartbeatIntervalMS uint32
	Seq                 uint64
	registered          bool
}

// relayClient 管理所有已配置中继的注册与心跳。 向单台中继发送一次 Register 帧。
func relayRegister(ctx context.Context, hub *UdpHub, selfID NodeID, srv RelayServerConfig, roomTag [8]byte) error {
	addr, err := net.ResolveUDPAddr("udp", srv.Addr)
	if err != nil {
		return err
	}
	nid, err := ParseNodeIDHex(srv.NodeID)
	if err != nil {
		return err
	}
	// 两种准入（ADR-0009）：令牌中继提交 BLAKE3(token) 摘要且不带 room_tag；
	// 盲中继（`mobihop-relay --relay-only`）**不带令牌**，改带 PSK 派生的 room_tag。
	// 早前 CFPilot 只有令牌分支且要求 Token 非空，token 为空的盲中继条目会被
	// spawnRelayClients 直接跳过 —— ECS 上的盲中继永远注册不上（恒 rooms=0）。
	// token_hash 必须是**空 array**而不是 nil：Rust 侧是 `token_hash: Vec<u8>`（非 Option），
	// nil（0xc0）解码直接失败，中继静默丢帧，节点侧却只看到“已发起注册”。
	reg := &RelayRegister{NodeID: selfID, RequestedKbps: 0, TokenHash: MsgpackByteArray{}}
	if srv.Blind {
		// room_tag 必须按整数 array 编码（Rust 侧是 `Option<[u8;8]>`）。
		tag := MsgpackByteArray(append([]byte(nil), roomTag[:]...))
		reg.RoomTag = &tag
	} else {
		reg.TokenHash = MsgpackByteArray(relayTokenHash(srv.Token))
	}
	msg := &RelayMessage{Register: reg}
	payload, err := EncodeRelayMessage(msg)
	if err != nil {
		return err
	}
	frame, err := (&Frame{
		Version: WireVersionDefault, Type: MsgRelayMgmt, TTL: DefaultTTL,
		Payload: payload, Src: selfID, Dst: nid,
	}).Encode()
	if err != nil {
		return err
	}
	return hub.SendProbeTo(ctx, addr, frame)
}

// relayHeartbeat 发送一次心跳帧。
func relayHeartbeat(ctx context.Context, hub *UdpHub, selfID NodeID, srv RelayServerConfig, sess *RelaySession) error {
	addr, err := net.ResolveUDPAddr("udp", srv.Addr)
	if err != nil {
		return err
	}
	sess.Seq++
	msg := &RelayMessage{Heartbeat: &RelayHeartbeat{
		NodeID: selfID, Seq: sess.Seq, SentAtMS: uint64(time.Now().UnixMilli()),
	}}
	payload, err := EncodeRelayMessage(msg)
	if err != nil {
		return err
	}
	nid, _ := ParseNodeIDHex(srv.NodeID)
	frame, err := (&Frame{
		Version: WireVersionDefault, Type: MsgRelayMgmt, TTL: DefaultTTL,
		Payload: payload, Src: selfID, Dst: nid,
	}).Encode()
	if err != nil {
		return err
	}
	return hub.SendProbeTo(ctx, addr, frame)
}

// handleRelayMgmt 处理 0x06 中继管理帧（由 UdpHub 观察通道调用）。
// 主要处理 AuthAccept：记录会话 ID 与心跳间隔，之后按间隔发 Heartbeat。
func (m *meshLifecycle) handleRelayMgmt(parsed *Frame, remote *net.UDPAddr) {
	msg, err := DecodeRelayMessage(parsed.Payload)
	if err != nil {
		return
	}
	if msg.AuthAccept == nil {
		// AuthReject：中继重启 / 会话被回收后，本端还留着「已准入」标记，
		// 注册循环已停 ⇒ 只剩心跳被拒，永远回不到已准入状态（真机：中继重新部署后
		// 两端都显示 via=relay 却全是死腿）。这里清掉标记，让注册循环恢复重试。
		if msg.AuthReject != nil && remote != nil {
			m.relayHbMu.Lock()
			delete(m.relayAccepted, remote.String())
			delete(m.relayHbStarted, remote.String())
			m.relayHbMu.Unlock()
			if m.cfg.Verbose {
				log.Printf("[mesh] 中继拒绝会话（%v），恢复注册重试 %s", msg.AuthReject.Reason, remote)
			}
		}
		return // Register/Heartbeat 等由我们发出，收到即忽略
	}
	acc := msg.AuthAccept
	// 记下“该中继已准入”，让注册循环停下来（只留心跳）。
	m.relayHbMu.Lock()
	if m.relayAccepted == nil {
		m.relayAccepted = map[string]bool{}
	}
	m.relayAccepted[remote.String()] = true
	m.relayHbMu.Unlock()
	if m.cfg.Verbose {
		log.Printf("[mesh] 中继注册成功 node=%x session=%d hb=%dms from=%s",
			acc.NodeID[:4], acc.SessionID, acc.HeartbeatIntervalMS, remote)
	}
	// 找到对应的中继条目，按其 interval 起心跳循环（幂等：每台只需一个）。
	found := false
	for _, srv := range m.cfg.RelayServers {
		if srv.Addr == "" || remote == nil {
			continue
		}
		srvAddr, e := net.ResolveUDPAddr("udp", srv.Addr)
		if e != nil || srvAddr.Port != remote.Port || !srvAddr.IP.Equal(remote.IP) {
			continue
		}
		found = true
		break
	}
	if !found {
		return
	}

	// 认证通过 ⇒ 中继腿正式可用：给每个静态对端挂一条「经中继转发」的伪链路。
	// 只替换「没有链路」或「已经在中继上」的，绝不把跑通的直连打回中继。
	m.mu.Lock()
	var needHandshake []NodeID
	// ⚠️ 换了链路就必须重启该 peer 的接收循环：旧循环还挂在原来的 fake 地址链路上，
	// 中继腿里到的握手帧永远没人读（症状：双向都已注册、relay rx 有包，却恒“握手中”）。
	type restart struct {
		id   NodeID
		link PeerLink
	}
	var restarts []restart
	for _, p := range m.cfg.Peers {
		cur := m.links[p.NodeID]
		_, hasSession := m.fsm.Session(p.NodeID)
		// 已经在直连上跑着的会话不动（不能被中继「打回去」）；
		// 其余情况一律先挂中继腿——「先通后优」：有中继先保证能通，
		// 打洞成功后 punch 会把链路升为直连。
		if !hasSession || cur == nil || cur.IsRelayed() {
			link := m.hub.RelayLinkTo(remote, p.NodeID)
			m.links[p.NodeID] = link
			if loop := m.recvLoops[p.NodeID]; loop == nil || loop.link != link {
				restarts = append(restarts, restart{p.NodeID, link})
			}
			if !hasSession {
				needHandshake = append(needHandshake, p.NodeID)
			}
		}
	}
	m.mu.Unlock()
	for _, r := range restarts {
		m.stopRecvLoop(r.id)
		loopCtx := m.relayCtx
		if loopCtx == nil {
			loopCtx = context.Background()
		}
		m.startRecvLoop(loopCtx, r.id, r.link)
	}
	for _, id := range needHandshake {
		if p := m.peerConfig(id); p != nil {
			// 用 StartOutbound（尊重「小 NodeId 才发起」）：两端都用 Force 会
			// 各自变成发起方，收到的 msg1 被当成 msg2 解，永远握不上手。
			if err := m.fsm.StartOutbound(id, p.StaticPub); err != nil {
				log.Printf("[mesh] 中继腿发起握手失败 peer=%x: %v", id[:4], err)
			}
		}
	}
	m.relayHbMu.Lock()
	if m.relayHbStarted[remote.String()] {
		m.relayHbMu.Unlock()
		return
	}
	m.relayHbStarted[remote.String()] = true
	m.relayHbMu.Unlock()

	// 心跳用生命周期 ctx，Stop 时自动退出。
	// ⚠️ relayCtx 曾在 Start 里漏初始化：一旦收到 AuthAccept，心跳 goroutine
	// 就 `nil.Done()` 崩掉整个进程（真机：刚“中继注册成功”进程就消失）。
	hbCtx := m.relayCtx
	if hbCtx == nil {
		hbCtx = context.Background()
	}
	go func(srv RelayServerConfig, sess *RelaySession) {
		interval := time.Duration(acc.HeartbeatIntervalMS) * time.Millisecond
		if interval <= 0 || interval > 60*time.Second {
			interval = 5 * time.Second
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-ticker.C:
				_ = relayHeartbeat(hbCtx, m.hub, m.cfg.NodeID, srv, sess)
			}
		}
	}(srvForRemote(m.cfg.RelayServers, remote), &RelaySession{
		NodeID: acc.NodeID, SessionID: acc.SessionID, HeartbeatIntervalMS: acc.HeartbeatIntervalMS,
	})
}

// srvForRemote 按 remote 找中继配置。
func srvForRemote(servers []RelayServerConfig, remote *net.UDPAddr) RelayServerConfig {
	for _, srv := range servers {
		a, err := net.ResolveUDPAddr("udp", srv.Addr)
		if err == nil && remote != nil && a.Port == remote.Port && a.IP.Equal(remote.IP) {
			return srv
		}
	}
	return RelayServerConfig{}
}

func spawnRelayClients(ctx context.Context, hub *UdpHub, selfID NodeID, servers []RelayServerConfig, roomTag [8]byte, verbose bool, accepted func(addr string) bool) bool {
	if hub == nil || len(servers) == 0 {
		return false
	}
	enabled := false
	for _, srv := range servers {
		// 盲中继：只需要 node_id + addr（room_tag 由 PSK 现算）；
		// 令牌中继：还需要 token。
		if srv.Addr == "" || srv.NodeID == "" || (!srv.Blind && srv.Token == "") {
			if verbose {
				log.Printf("[mesh] 中继条目不完整（盲中继需 node_id/addr；令牌中继还需 token），跳过：%s", srv.Addr)
			}
			continue
		}
		enabled = true
		// 提前登记中继地址：转发来的帧源地址是中继，不是对端，
		// 必须按帧头 Src 分派（见 UdpHub.dispatch）。
		if ra, err := net.ResolveUDPAddr("udp", srv.Addr); err == nil {
			hub.AddRelayAddr(ra)
		}
		go func(srv RelayServerConfig) {
			interval := time.Duration(relayRegisterIntervalMS) * time.Millisecond
			for {
				if err := relayRegister(ctx, hub, selfID, srv, roomTag); err != nil {
					if verbose && ctx.Err() == nil {
						log.Printf("[mesh] 中继注册失败 %s: %v", srv.Addr, err)
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(interval):
				}
				// 已收到 AuthAccept ⇒ 之后只靠心跳保活，**不再重复注册**：
				// 每次 Register 都会在中继侧新建会话/链路，反复重建会把单播转发路径
				// 拆掉（症状：握手帧“准入转发”日志有、对端却收不到）。
				if accepted != nil && accepted(srv.Addr) {
					<-ctx.Done()
					return
				}
			}
		}(srv)
	}
	if enabled && verbose {
		log.Printf("[mesh] 专用服务器中继已启用（%d 台）", len(servers))
	}
	return enabled
}
