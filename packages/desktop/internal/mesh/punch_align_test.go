//go:build mesh

package mesh

import (
	"bytes"
	"context"
	"net"
	"testing"
	"time"
)

// 2026-11-19 对齐 MobiHop 的四项改进（双栈 / IPv6 候选 / public_addr / 硬对称扫描 /
// probe-back / 盲中继接入）的最小单测。真机验收见 E2E_TEST.md §8。

// 双栈 socket：v4 报文以 v4-mapped 到达，必须在收包边界还原成普通 IPv4。
func TestDualStackHubCanonicalizesV4(t *testing.T) {
	got := make(chan *net.UDPAddr, 1)
	hub, err := NewUdpHubWithDual("0.0.0.0:0", true, func(_ NodeID, addr *net.UDPAddr) { got <- addr })
	if err != nil {
		t.Skipf("本机不支持双栈绑定: %v", err)
	}
	defer hub.Close()
	if !hub.IsDualStack() {
		t.Skip("socket 不是 AF_INET6，跳过双栈断言")
	}
	local := hub.LocalAddr()
	if local.IP.To4() != nil {
		t.Fatalf("双栈监听应绑在 v6 未指定地址，实际 %s", local)
	}

	// 从 IPv4 socket 发一帧合法帧过去。
	sender, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	frame, err := (&Frame{Version: WireVersionDefault, Type: MsgPing, TTL: DefaultTTL,
		Src: NodeID{7}, Dst: NodeID{9}}).Encode()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sender.WriteToUDP(frame, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: local.Port}); err != nil {
		t.Fatal(err)
	}
	select {
	case addr := <-got:
		if addr == nil || addr.IP.To4() == nil {
			t.Fatalf("应还原为 IPv4，实际 %v", addr)
		}
		if addr.IP.To16() != nil && addr.String() != net.JoinHostPort("127.0.0.1", itoa(addr.Port)) {
			t.Fatalf("v4-mapped 未归一: %s", addr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("未收到来自 IPv4 的帧（双栈收包失败）")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// 硬对称扫描：2048 次推进必须是 [0,2048) 的置换（互质步长 ⇒ 不重复、不漏）。
func TestHardSymTargetsCoverWithoutRepeat(t *testing.T) {
	lc := &meshLifecycle{cfg: Config{NodeID: NodeID{1}, Listen: "0.0.0.0:51820"}}
	peer := NodeID{2}
	cands := []Candidate{{
		Addr: NewV4Addr([4]byte{203, 0, 113, 7}, 51820),
		Kind: CandidateServerReflexive,
	}}
	seen := make(map[int]bool, hardSymSpan)
	total := 0
	for round := 0; total < hardSymSpan; round++ {
		targets := lc.hardSymTargets(peer, cands, hardSymBatch)
		if len(targets) != hardSymBatch {
			t.Fatalf("第 %d 轮目标数 = %d", round, len(targets))
		}
		for _, a := range targets {
			if total >= hardSymSpan {
				break
			}
			total++
			if a.IP.String() != "203.0.113.7" {
				t.Fatalf("扫描目标 IP 应是对端公网地址，实际 %s", a.IP)
			}
			port := a.Port - hardSymPortBase
			if port < 0 || port >= hardSymSpan {
				t.Fatalf("端口越界: %d", a.Port)
			}
			if seen[port] {
				t.Fatalf("端口 %d 在 2048 个采样内重复", a.Port)
			}
			seen[port] = true
		}
	}
	if len(seen) != hardSymSpan {
		t.Fatalf("覆盖 %d/%d", len(seen), hardSymSpan)
	}
}

// probe-back 去重：同一 (peer, nonce) 只允许回发一次。
func TestProbeBackDedup(t *testing.T) {
	lc := &meshLifecycle{hardSymCursor: map[NodeID]uint32{}}
	peer := NodeID{3}
	if !lc.shouldProbeBack(peer, 11) {
		t.Fatal("首次应允许回发")
	}
	if lc.shouldProbeBack(peer, 11) {
		t.Fatal("同一 nonce 不得重复回发（会形成探测风暴）")
	}
	if !lc.shouldProbeBack(peer, 12) {
		t.Fatal("不同 nonce 应允许")
	}
}

// public_addr：固定端口、排在最前、v6 给 v6 加成，且私网/回环被拒。
func TestPublicAddrCandidateIsFirstAndFixed(t *testing.T) {
	lc := &meshLifecycle{cfg: Config{
		NodeID:     NodeID{1},
		Listen:     "0.0.0.0:51820",
		PublicAddr: "240e:37c:1c3c:8e01::1:51820",
	}}
	cands := lc.localCandidates()
	if len(cands) == 0 {
		t.Fatal("应有候选")
	}
	first := candidateUDP(cands[0])
	if first == nil || first.IP.To4() != nil || first.Port != 51820 {
		t.Fatalf("public_addr 应排在首位且端口固定，实际 %v", first)
	}
	if cands[0].Kind != CandidateServerReflexive {
		t.Errorf("public_addr 应为 ServerReflexive，实际 %s", cands[0].Kind)
	}
		// 裸 IPv6 带端口也必须能解析（用户最常见的写法）。
	if bare := lc.cfg.PublicAddr; bare != "240e:37c:1c3c:8e01::1:51820" {
		t.Fatalf("测试自身写错了: %s", bare)
	}
	if _, err := ParsePublicAddr("[240e:37c::1]:51820"); err != nil {
		t.Fatalf("带中括号的 IPv6 应可解析: %v", err)
	}
	for _, bad := range []string{"192.168.1.5:51820", "127.0.0.1:51820", "100.64.1.2:51820", "1.2.3.4:0"} {
		c := Config{NetworkName: "n", PSK: "p", VirtualIP: "10.0.0.1", PublicAddr: bad}
		if err := c.Validate(); err == nil {
			t.Errorf("PublicAddr=%s 应被拒绝", bad)
		}
	}
	ok := Config{NetworkName: "n", PSK: "p", VirtualIP: "10.0.0.1", PublicAddr: "240e:37c::1:51820"}
	if err := ok.Validate(); err != nil {
		t.Fatalf("公网 IPv6 public_addr 应通过: %v", err)
	}
}

// 盲中继：Register 必须带 room_tag、不带令牌摘要（ADR-0009）。
func TestBlindRelayRegisterCarriesRoomTag(t *testing.T) {
	ln, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	tag := DeriveRoomTag(DerivePSK("net-a", "secret"))
	srv := RelayServerConfig{NodeID: "aabbccddeeff0011", Addr: ln.LocalAddr().String(), Blind: true}
	if err := relayRegister(context.Background(), hub, NodeID{1, 2}, srv, tag); err != nil {
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
	msg, err := DecodeRelayMessage(f.Payload)
	if err != nil || msg.Register == nil {
		t.Fatalf("Register 解析失败: %v", err)
	}
	if msg.Register.RoomTag == nil {
		t.Fatal("盲中继注册必须携带 room_tag")
	}
	if !bytes.Equal([]byte(*msg.Register.RoomTag), tag[:]) {
		t.Fatalf("room_tag = %x, 期望 %x", []byte(*msg.Register.RoomTag), tag)
	}
	if len(msg.Register.TokenHash) != 0 {
		t.Fatal("盲中继不得提交令牌摘要")
	}
	// 校验：非 blind 又没 token 必须在 Validate 阶段就拒绝（否则线上空白摘要，用户看不出原因）。
	cfg := Config{NetworkName: "n", PSK: "p", VirtualIP: "10.0.0.1",
		RelayServers: []RelayServerConfig{{NodeID: "aabbccddeeff0011", Addr: "1.2.3.4:51820"}}}
	if err := cfg.Validate(); err == nil {
		t.Error("非 blind 且无 token 的中继条目应被拒绝")
	}
}
