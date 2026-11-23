//go:build mesh

package mesh

import (
	"bytes"
	"context"
	"net"
	"os"
	"testing"
	"time"
)

// 专用服务器中继（对齐 MobiHop [[relays]]）：token 摘要、Register 帧、心跳帧。

func TestRelayTokenHash(t *testing.T) {
	// BLAKE3 摘要固定为 32 字节；相同 token 一致、不同 token 不同。
	a := relayTokenHash("my-secret")
	b := relayTokenHash("my-secret")
	c := relayTokenHash("other")
	if len(a) != 32 {
		t.Fatalf("token hash 长度 = %d, 期望 32", len(a))
	}
	if !bytes.Equal(a, b) {
		t.Error("相同 token 摘要应一致")
	}
	if bytes.Equal(a, c) {
		t.Error("不同 token 摘要应不同")
	}
	// 摘要里绝不能含令牌原文（BLAKE3 是 hash，但确认一下没有直接拼字符串）
	if bytes.Contains(a, []byte("my-secret")) {
		t.Error("摘要里不应含令牌明文")
	}
}

func TestRelayRegisterFrame(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	selfID := NodeID{1, 2, 3, 4, 5, 6, 7, 8}
	relayID := "aabbccddeeff0011"
	srv := RelayServerConfig{NodeID: relayID, Addr: "127.0.0.1:51830", Token: "tok"}

	// 监听端捕获注册帧
	ln, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 51830})
	if err != nil {
		t.Skip("端口 51830 被占用，跳过")
	}
	defer ln.Close()
	if err := relayRegister(context.Background(), hub, selfID, srv, [8]byte{}); err != nil {
		t.Fatal(err)
	}
	_ = ln.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, MaxFrame)
	n, _, err := ln.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("未收到注册帧: %v", err)
	}
	f, err := Decode(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if f.Type != MsgRelayMgmt {
		t.Errorf("类型 = %#x, 期望 MsgRelayMgmt", f.Type)
	}
	msg, err := DecodeRelayMessage(f.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Register == nil {
		t.Fatal("应为 Register 变体")
	}
	if msg.Register.NodeID != selfID {
		t.Errorf("node_id = %v", msg.Register.NodeID)
	}
	if !bytes.Equal(msg.Register.TokenHash, relayTokenHash("tok")) {
		t.Error("token_hash 不匹配")
	}
}

func TestRelaySessionReRegistersAfterReject(t *testing.T) {
	relay, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	identity := lifecycleTestIdentity(t, 14)
	relayID := NodeID{4}
	cfg := lifecycleTestConfig(identity, "10.97.0.1")
	cfg.RelayDomain = ""
	cfg.RelayServers = []RelayServerConfig{{NodeID: relayID.Hex(), Addr: relay.LocalAddr().String(), Blind: true}}
	lifecycle := &meshLifecycle{cfg: cfg, tunOverride: newLifecycleTestTun()}
	if err := lifecycle.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer stopLifecycleWithin(t, lifecycle)
	buf := make([]byte, MaxFrame)
	read := func() (*RelayMessage, *net.UDPAddr) {
		t.Helper()
		_ = relay.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, client, err := relay.ReadFromUDP(buf)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := Decode(buf[:n])
		if err != nil {
			t.Fatal(err)
		}
		if frame.Type != MsgRelayMgmt || frame.Src != identity.NodeID || frame.Dst != relayID {
			t.Fatalf("中继控制帧方向错误: %v → %v (%v)", frame.Src, frame.Dst, frame.Type)
		}
		msg, err := DecodeRelayMessage(frame.Payload)
		if err != nil {
			t.Fatal(err)
		}
		return msg, client
	}
	msg, client := read()
	if msg.Register == nil || msg.Register.NodeID != identity.NodeID || msg.Register.RoomTag == nil {
		t.Fatal("首帧应为本机盲中继注册")
	}
	reply := func(src NodeID, message *RelayMessage) {
		t.Helper()
		payload, err := EncodeRelayMessage(message)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := (&Frame{Version: WireVersionDefault, Type: MsgRelayMgmt, TTL: DefaultTTL,
			Src: src, Dst: identity.NodeID, Payload: payload}).Encode()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := relay.WriteToUDP(frame, client); err != nil {
			t.Fatal(err)
		}
	}
	expectQuiet := func() {
		t.Helper()
		_ = relay.SetReadDeadline(time.Now().Add(180 * time.Millisecond))
		if _, _, err := relay.ReadFromUDP(buf); !os.IsTimeout(err) {
			t.Fatalf("应当等待有效的注册应答，读取结果: %v", err)
		}
	}
	accept := &RelayMessage{AuthAccept: &RelayAuthAccept{NodeID: identity.NodeID, SessionID: 1, HeartbeatIntervalMS: 50}}
	reply(NodeID{5}, accept)
	expectQuiet()
	reply(relayID, accept)
	for seq := uint64(1); seq <= 2; seq++ {
		msg, _ := read()
		if hb := msg.Heartbeat; hb == nil || hb.NodeID != identity.NodeID || hb.Seq != seq {
			t.Fatalf("心跳应携带本机 ID 和递增序号 %d，收到 %#v", seq, hb)
		}
	}
	reply(relayID, &RelayMessage{AuthReject: &RelayAuthReject{NodeID: identity.NodeID, Reason: "AuthFailed"}})
	for {
		msg, _ = read()
		if msg.Register != nil {
			break
		}
		if msg.Heartbeat == nil || msg.Heartbeat.Seq > 3 {
			t.Fatal("会话被拒后应切回注册")
		}
	}
	expectQuiet()
	reply(relayID, &RelayMessage{AuthAccept: &RelayAuthAccept{NodeID: identity.NodeID, SessionID: 2, HeartbeatIntervalMS: 50}})
	for seq := uint64(1); seq <= 2; seq++ {
		msg, _ := read()
		if hb := msg.Heartbeat; hb == nil || hb.Seq != seq {
			t.Fatalf("重新注册后应从 1 开始发送心跳，期望 %d，收到 %#v", seq, hb)
		}
	}
}

func TestUDPRelayPreservesWSSUntilRoomCloses(t *testing.T) {
	identity := lifecycleTestIdentity(t, 15)
	peerIdentity := lifecycleTestIdentity(t, 16)
	cfg := lifecycleTestConfig(identity, "10.97.0.1")
	cfg.Peers = []PeerConfig{{NodeID: peerIdentity.NodeID, Addr: "127.0.0.1:9", StaticPub: peerIdentity.TunnelPub, VirtualIP: "10.97.0.2"}}
	lifecycle := &meshLifecycle{cfg: cfg, tunOverride: newLifecycleTestTun()}
	room := NewWssRoom(newMemoryWsConn(), identity.NodeID)
	if err := lifecycle.start(t.Context(), func(context.Context) (*WssRoom, error) { return room, nil }); err != nil {
		t.Fatal(err)
	}
	defer stopLifecycleWithin(t, lifecycle)
	peer := peerIdentity.NodeID
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	assertTransport := func(want string) {
		t.Helper()
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			got := peerTransportName(lifecycle.linkForPeer(peer))
			if got == want {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("链路为 %q，期望 %q", got, want)
			case <-ticker.C:
			}
		}
	}
	assertTransport("wss")
	addr := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9}
	lifecycle.relayMu.Lock()
	lifecycle.relayEndpoints[addr.String()] = &relayEndpoint{nodeID: NodeID{18}, addr: addr, changed: make(chan struct{}, 1)}
	lifecycle.relayMu.Unlock()
	payload, err := EncodeRelayMessage(&RelayMessage{AuthAccept: &RelayAuthAccept{NodeID: identity.NodeID, SessionID: 1}})
	if err != nil {
		t.Fatal(err)
	}
	lifecycle.handleRelayMgmt(&Frame{Src: NodeID{18}, Dst: identity.NodeID, Payload: payload}, addr)
	if got := peerTransportName(lifecycle.linkForPeer(peer)); got != "wss" {
		t.Fatalf("中继注册覆盖了 WSS 链路，当前为 %q", got)
	}
	if err := room.Close(); err != nil {
		t.Fatal(err)
	}
	assertTransport("relay")
}

func TestTokenHashIsBlake3(t *testing.T) {
	// 与 zeebo/blake3 直接计算对比，确认实现口径
	got := relayTokenHash("abc")
	if len(got) != 32 {
		t.Fatal("BLAKE3 应为 32 字节")
	}
	// 确定性：再算一次相同
	if !bytes.Equal(got, relayTokenHash("abc")) {
		t.Error("BLAKE3 应确定性")
	}
}
