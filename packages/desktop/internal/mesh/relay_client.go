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
const relayRegisterInterval = 5 * time.Second

// tokenHash 计算中继准入令牌摘要：BLAKE3(token_string)。
// 对齐 MobiHop `blake3::hash(t.as_bytes())`。
func relayTokenHash(token string) []byte {
	h := blake3.Sum256([]byte(token))
	return h[:]
}

type relayEndpoint struct {
	nodeID   NodeID
	addr     *net.UDPAddr
	accepted *RelayAuthAccept
	changed  chan struct{}
}

// relayClient 管理所有已配置中继的注册与心跳。 向单台中继发送一次 Register 帧。
func relayRegister(ctx context.Context, hub *UdpHub, selfID NodeID, srv RelayServerConfig, roomTag [8]byte) error {
	addr, err := resolveMeshUDPAddr(ctx, 0, srv.Addr)
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
func relayHeartbeat(ctx context.Context, hub *UdpHub, selfID, relayID NodeID, addr *net.UDPAddr, seq uint64) error {
	msg := &RelayMessage{Heartbeat: &RelayHeartbeat{
		NodeID: selfID, Seq: seq, SentAtMS: uint64(time.Now().UnixMilli()),
	}}
	payload, err := EncodeRelayMessage(msg)
	if err != nil {
		return err
	}
	frame, err := (&Frame{
		Version: WireVersionDefault, Type: MsgRelayMgmt, TTL: DefaultTTL,
		Payload: payload, Src: selfID, Dst: relayID,
	}).Encode()
	if err != nil {
		return err
	}
	return hub.SendProbeTo(ctx, addr, frame)
}

// handleRelayMgmt 处理 0x06 中继管理帧（由 UdpHub 观察通道调用）。
func (m *meshLifecycle) handleRelayMgmt(parsed *Frame, remote *net.UDPAddr) {
	ctx := m.runCtx
	remote = canonicalAddr(remote)
	if ctx == nil || ctx.Err() != nil || remote == nil || parsed.Dst != m.cfg.NodeID {
		return
	}
	m.relayMu.Lock()
	endpoint := m.relayEndpoints[remote.String()]
	if endpoint == nil || parsed.Src != endpoint.nodeID {
		m.relayMu.Unlock()
		return
	}
	msg, err := DecodeRelayMessage(parsed.Payload)
	if err != nil {
		m.relayMu.Unlock()
		return
	}
	var accept *RelayAuthAccept
	switch {
	case msg.AuthAccept != nil && msg.AuthAccept.NodeID == m.cfg.NodeID:
		accept = msg.AuthAccept
		if endpoint.accepted != nil && endpoint.accepted.SessionID == accept.SessionID {
			m.relayMu.Unlock()
			return
		}
		endpoint.accepted = accept
	case msg.AuthReject != nil && msg.AuthReject.NodeID == m.cfg.NodeID:
		if endpoint.accepted == nil {
			m.relayMu.Unlock()
			return
		}
		endpoint.accepted = nil
	default:
		m.relayMu.Unlock()
		return
	}
	select {
	case endpoint.changed <- struct{}{}:
	default:
	}
	m.relayMu.Unlock()
	if accept == nil {
		if m.cfg.Verbose {
			log.Printf("[mesh] 中继拒绝会话，恢复注册 %s", remote)
		}
		return
	}
	if m.cfg.Verbose {
		log.Printf("[mesh] 中继注册成功 node=%x session=%d hb=%dms from=%s",
			endpoint.nodeID[:4], accept.SessionID, accept.HeartbeatIntervalMS, remote)
	}
	m.activateUDPRelay(ctx, remote)
}

func (m *meshLifecycle) resumeUDPRelay(ctx context.Context) {
	var ready *net.UDPAddr
	m.relayMu.Lock()
	for _, endpoint := range m.relayEndpoints {
		if endpoint.accepted != nil {
			ready = endpoint.addr
			break
		}
	}
	m.relayMu.Unlock()
	if ready != nil {
		m.activateUDPRelay(ctx, ready)
	}
}

func (m *meshLifecycle) activateUDPRelay(ctx context.Context, remote *net.UDPAddr) {
	m.mu.Lock()
	if ctx.Err() != nil {
		m.mu.Unlock()
		return
	}
	var needHandshake, relayed []NodeID
	for peer := range m.peerStatic {
		current := m.links[peer]
		hasSession := m.fsm.HasSession(peer)
		if current != nil && !current.IsRelayed() && hasSession {
			continue
		}
		// WSS 可用时继续走双方的同一个房间，避免仅受邀端切换到 UDP 中继。
		switch current := current.(type) {
		case *WssRoomPeer:
			if current.room.connected() {
				continue
			}
		case *WssLink:
			continue
		}
		m.links[peer] = m.hub.RelayLinkTo(remote, peer)
		if m.degrade != nil {
			m.degrade.SetActiveKind(peer, TransportUDP)
		}
		if hasSession {
			relayed = append(relayed, peer)
		} else {
			needHandshake = append(needHandshake, peer)
		}
	}
	m.mu.Unlock()
	m.syncRecvLoops(ctx)
	for _, id := range needHandshake {
		if publicKey := m.peerStaticKey(id); len(publicKey) == 32 {
			// 用 StartOutbound（尊重「小 NodeId 才发起」）：两端都用 Force 会
			// 各自变成发起方，收到的 msg1 被当成 msg2 解，永远握不上手。
			if err := m.fsm.StartOutbound(id, publicKey); err != nil {
				log.Printf("[mesh] 中继腿发起握手失败 peer=%x: %v", id[:4], err)
			}
		}
	}
	for _, peer := range relayed {
		m.startPunch(peer, m.linkForPeer(peer))
	}
}

func (m *meshLifecycle) spawnRelayClients(ctx context.Context, roomTag [8]byte) {
	for _, server := range m.cfg.RelayServers {
		relayID, err := ParseNodeIDHex(server.NodeID)
		if err != nil || server.Addr == "" || (!server.Blind && server.Token == "") {
			if m.cfg.Verbose {
				log.Printf("[mesh] 中继条目不完整（盲中继需节点 ID 和地址；令牌中继还需令牌），跳过：%s", server.Addr)
			}
			continue
		}
		m.wg.Go(func() { m.runRelayClient(ctx, server, relayID, roomTag) })
	}
}

func (m *meshLifecycle) runRelayClient(ctx context.Context, server RelayServerConfig, relayID NodeID, roomTag [8]byte) {
	for ctx.Err() == nil {
		resolveCtx, cancel := context.WithTimeout(ctx, relayRegisterInterval)
		addr, err := resolveMeshUDPAddr(resolveCtx, 0, server.Addr)
		cancel()
		if err == nil {
			addr = canonicalAddr(addr)
			server.Addr = addr.String()
			endpoint := &relayEndpoint{nodeID: relayID, addr: addr, changed: make(chan struct{}, 1)}
			m.relayMu.Lock()
			if m.relayEndpoints[server.Addr] != nil {
				m.relayMu.Unlock()
				return
			}
			m.relayEndpoints[server.Addr] = endpoint
			m.relayMu.Unlock()
			m.hub.AddRelayAddr(addr)
			m.runRelaySession(ctx, server, endpoint, addr, roomTag)
			return
		}
		if m.cfg.Verbose && ctx.Err() == nil {
			log.Printf("[mesh] 中继地址解析失败 %s: %v", server.Addr, err)
		}
		timer := time.NewTimer(relayRegisterInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// runRelaySession 让每个中继的注册和心跳共用一个任务，被拒后切回注册。
func (m *meshLifecycle) runRelaySession(ctx context.Context, server RelayServerConfig, endpoint *relayEndpoint, addr *net.UDPAddr, roomTag [8]byte) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	var session *RelayAuthAccept
	var seq uint64
	interval := relayRegisterInterval
	for ctx.Err() == nil {
		stateChanged := false
		select {
		case <-ctx.Done():
			return
		case <-endpoint.changed:
			stateChanged = true
		case <-timer.C:
		}
		m.relayMu.Lock()
		accepted := endpoint.accepted
		m.relayMu.Unlock()
		if accepted != session {
			session, seq = accepted, 0
			interval = relayRegisterInterval
			if session != nil {
				if requested := time.Duration(session.HeartbeatIntervalMS) * time.Millisecond; requested > 0 && requested <= time.Minute {
					interval = requested
				}
				timer.Reset(interval)
				continue
			}
		} else if stateChanged {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		var err error
		if session == nil {
			err = relayRegister(ctx, m.hub, m.cfg.NodeID, server, roomTag)
		} else {
			seq++
			err = relayHeartbeat(ctx, m.hub, m.cfg.NodeID, endpoint.nodeID, addr, seq)
		}
		if err != nil && m.cfg.Verbose && ctx.Err() == nil {
			log.Printf("[mesh] 中继控制帧发送失败 %s: %v", server.Addr, err)
		}
		timer.Reset(interval)
	}
}
