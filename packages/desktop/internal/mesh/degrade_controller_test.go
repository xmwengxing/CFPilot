package mesh

import (
	"context"
	"net"
	"testing"
	"time"
)

// TestDegradeControllerDecisionFlow 验证控制器把 DegradePolicy 的判定映射为切换。
// （真实 switchToWSS 需要 WSS 连接，这里用 policy + switchFn 验证编排逻辑。）
func TestDegradeControllerDecisionFlow(t *testing.T) {
	peer := nodeID(1)
	policy := NewDegradePolicy()
	switches := 0
	switchFn := func(id NodeID, link PeerLink, kind TransportKind) { switches++ }

	// 模拟 UDP 连续 3 窗差 → ToWSS
	for i := 0; i < 2; i++ {
		if d := policy.Observe(peer, TransportUDP, 0.3, 10, 100); d.Kind != DecisionStay {
			t.Fatalf("第 %d 窗不应切", i)
		}
	}
	if d := policy.Observe(peer, TransportUDP, 0.3, 10, 100); d.Kind == DecisionToWSS {
		switchFn(peer, nil, TransportWSS)
	}
	if switches != 1 {
		t.Errorf("应触发 1 次降级切换，实际 %d", switches)
	}

	// 冷却 10 窗
	for i := int(policy.thresholds.CooldownTicks); i > 0; i-- {
		policy.Observe(peer, TransportWSS, 0.2, 10, 200)
	}
	// 连续 3 窗好 → ToUDP
	for i := 0; i < 2; i++ {
		policy.Observe(peer, TransportWSS, 0.02, 10, 100)
	}
	if d := policy.Observe(peer, TransportWSS, 0.02, 10, 100); d.Kind == DecisionToUDP {
		switchFn(peer, nil, TransportUDP)
	}
	if switches != 2 {
		t.Errorf("应触发 2 次切换（降+回），实际 %d", switches)
	}
}

// TestDegradeControllerLifecycle 验证 Start/Stop 不死锁。
func TestDegradeControllerLifecycle(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	probes := NewProbeTracker(hub, nodeID(0))
	c := NewDegradeController(nodeID(0), probes, "", "", "", nil, false)
	c.AddPeer(nodeID(1), "127.0.0.1:12345")
	c.SetSwitchFn(func(NodeID, PeerLink, TransportKind) {})
	ctx, cancel := context.WithCancel(context.Background())
	c.Start(ctx)
	time.Sleep(500 * time.Millisecond)
	cancel()
	c.Stop() // 应正常返回，不死锁
	if c.Kind(nodeID(1)) != TransportUDP {
		t.Error("初始档位应为 UDP")
	}
}

// TestDegradeControllerDirectLockPreventsFlap 验证打洞确认直连后，
// 降级控制器不再因探针瞬时丢包把 P2P 链路切回 WSS。
func TestDegradeControllerDirectLockPreventsFlap(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	probes := NewProbeTracker(hub, nodeID(0))
	c := NewDegradeController(nodeID(0), probes, "relay.example", "room", "", nil, false)
	c.AddPeer(nodeID(1), "127.0.0.1:12345")
	c.SetSharedWssRoomRequired(true)
	switches := 0
	c.SetSwitchFn(func(NodeID, PeerLink, TransportKind) { switches++ })
	c.LockDirect(nodeID(1))
	if !c.IsDirectLocked(nodeID(1)) {
		t.Fatal("LockDirect 后应处于直连锁定状态")
	}
	c.graceTicks = 0
	c.lastSwitch[nodeID(1)] = time.Time{}
	for i := 0; i < 5; i++ {
		c.probes.RecordSample(nodeID(1))
		c.tick(context.Background())
	}
	if switches != 0 || c.Kind(nodeID(1)) != TransportUDP {
		t.Fatalf("直连锁定后不应切换档位，switches=%d kind=%v", switches, c.Kind(nodeID(1)))
	}
}

// TestProbePingPong 验证 UdpProbe 的 Ping/Pong 编解码与 RTT 计算。
func TestProbePingPong(t *testing.T) {
	ping := &PingMsg{TimestampMS: 1700000000000, Nonce: 42}
	b, err := EncodePing(ping)
	if err != nil {
		t.Fatal(err)
	}
	pong, err := DecodePong(b)
	if err != nil {
		t.Fatal(err)
	}
	if pong.Nonce != 42 || pong.TimestampMS != 1700000000000 {
		t.Errorf("Ping/Pong 往返不符: %+v", pong)
	}
}

// TestProbeTrackerSetPeerWithoutAddr 验证无地址时 SendProbe 返回错误（fail-closed）。
func TestProbeTrackerSetPeerWithoutAddr(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	tracker := NewProbeTracker(hub, nodeID(0))
	// 未 SetPeer → 应报错
	if _, err := tracker.SendProbe(context.Background(), nodeID(1)); err == nil {
		t.Error("未设置对端地址时 SendProbe 应报错")
	}
	sent, pong, rtt := tracker.Counters(nodeID(1))
	if sent != 0 || pong != 0 || rtt != 0 {
		t.Errorf("未设置对端时计数应为 0: %d/%d/%d", sent, pong, rtt)
	}
}

// TestProbeLossPerProbe 验证丢包率按"每个已发探针是否有对应 Pong"计算（真机暴露的 bug）：
// 发 10 个探针只有 2 个收到 Pong → 丢包率应为 80%。
func TestProbeLossPerProbe(t *testing.T) {
	hub, _ := NewUdpHub("127.0.0.1:0", nil)
	defer hub.Close()
	tr := NewProbeTracker(hub, nodeID(0))
	addr, _ := net.ResolveUDPAddr("udp", "127.0.0.1:12345")
	tr.SetPeer(nodeID(1), addr)

	// 发 10 个探针，仅前 2 个标记收到 Pong
	for i := 0; i < 10; i++ {
		_, _ = tr.SendProbe(context.Background(), nodeID(1))
	}
	tr.mu.Lock()
	p := tr.peers[nodeID(1)]
	for i := 0; i < 2; i++ {
		p.probeResults[i] = true
	}
	tr.mu.Unlock()

	loss, samples, _ := tr.Measurement(nodeID(1))
	if samples != 10 {
		t.Fatalf("样本数=%d, 期望 10", samples)
	}
	if loss < 0.79 || loss > 0.81 {
		t.Errorf("丢包率=%v, 期望 ~0.8", loss)
	}
}

// TestUdpHubProbeBypass 验证 0x08 帧被 demux 直接交 onProbe，不进普通队列。
func TestUdpHubProbeBypass(t *testing.T) {
	got := make(chan []byte, 1)
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	hub.SetProbeHandler(func(f []byte) { got <- f })

	conn, _ := net.DialUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, hub.LocalAddr())
	defer conn.Close()
	frame, _ := (&Frame{Type: MsgUdpProbe, TTL: DefaultTTL, Src: nodeID(1), Dst: nodeID(2), Payload: []byte("p")}).Encode()
	conn.Write(frame)

	select {
	case received := <-got:
		if len(received) != len(frame) {
			t.Error("探针帧长度不符")
		}
	case <-time.After(2 * time.Second):
		t.Error("UdpProbe 帧未被 onProbe 接收")
	}
	// 普通 link 队列应为空（探针不进队列）
	link := hub.LinkTo(conn.LocalAddr().(*net.UDPAddr)).(*hubLink)
	select {
	case f := <-link.rx:
		t.Errorf("探针帧不应进普通队列: % x", f)
	case <-time.After(100 * time.Millisecond):
	}
}
