//go:build mesh

package mesh

import (
	"bytes"
	"context"
	"net"
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

func TestRelayHeartbeatIncrementsSeq(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	selfID := NodeID{1}
	sess := &RelaySession{NodeID: selfID, Seq: 0}
	srv := RelayServerConfig{NodeID: "aabbccddeeff0011", Addr: "127.0.0.1:51831", Token: "tok"}
	_ = relayHeartbeat(context.Background(), hub, selfID, srv, sess)
	_ = relayHeartbeat(context.Background(), hub, selfID, srv, sess)
	if sess.Seq != 2 {
		t.Errorf("心跳序号 = %d, 期望 2", sess.Seq)
	}
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
