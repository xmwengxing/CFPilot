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
func relayRegister(ctx context.Context, hub *UdpHub, selfID NodeID, srv RelayServerConfig) error {
	addr, err := net.ResolveUDPAddr("udp", srv.Addr)
	if err != nil {
		return err
	}
	nid, err := ParseNodeIDHex(srv.NodeID)
	if err != nil {
		return err
	}
	msg := &RelayMessage{Register: &RelayRegister{
		NodeID:        selfID,
		TokenHash:     relayTokenHash(srv.Token),
		RequestedKbps: 0,
	}}
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
		return // Register/Heartbeat 等由我们发出，收到即忽略
	}
	acc := msg.AuthAccept
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
	m.relayHbMu.Lock()
	if m.relayHbStarted[remote.String()] {
		m.relayHbMu.Unlock()
		return
	}
	m.relayHbStarted[remote.String()] = true
	m.relayHbMu.Unlock()

	// 心跳用生命周期 ctx，Stop 时自动退出。
	go func(srv RelayServerConfig, sess *RelaySession) {
		interval := time.Duration(acc.HeartbeatIntervalMS) * time.Millisecond
		if interval <= 0 || interval > 60*time.Second {
			interval = 5 * time.Second
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-m.relayCtx.Done():
				return
			case <-ticker.C:
				_ = relayHeartbeat(m.relayCtx, m.hub, m.cfg.NodeID, srv, sess)
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

// spawnRelayClients 后台启动所有中继的注册/心跳循环。返回是否至少启用了一台。
func spawnRelayClients(ctx context.Context, hub *UdpHub, selfID NodeID, servers []RelayServerConfig, verbose bool) bool {
	if hub == nil || len(servers) == 0 {
		return false
	}
	enabled := false
	for _, srv := range servers {
		if srv.Addr == "" || srv.NodeID == "" || srv.Token == "" {
			if verbose {
				log.Printf("[mesh] 中继条目不完整（需 node_id/addr/token），跳过：%s", srv.Addr)
			}
			continue
		}
		enabled = true
		go func(srv RelayServerConfig) {
			interval := time.Duration(relayRegisterIntervalMS) * time.Millisecond
			for {
				if err := relayRegister(ctx, hub, selfID, srv); err != nil {
					if verbose && ctx.Err() == nil {
						log.Printf("[mesh] 中继注册失败 %s: %v", srv.Addr, err)
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(interval):
				}
			}
		}(srv)
	}
	if enabled && verbose {
		log.Printf("[mesh] 专用服务器中继已启用（%d 台）", len(servers))
	}
	return enabled
}
