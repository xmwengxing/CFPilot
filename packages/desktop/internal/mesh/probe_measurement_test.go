package mesh

import (
	"net"
	"testing"
)

// H0-2 口径：样本不足（< LOSS_MIN_SAMPLES=5）时丢包按 0.0 上报，不误报。
func TestProbeMeasurementRequiresMinSamples(t *testing.T) {
	tr := NewProbeTracker(nil, nodeID(1))
	peer := nodeID(2)
	tr.SetPeer(peer, &net.UDPAddr{IP: net.IPv4(1, 2, 3, 4), Port: 9999})

	p := tr.peers[peer]
	p.probeResults = []bool{false, false} // 2 个样本全丢
	loss, samples, _ := tr.Measurement(peer)
	if loss != 0 {
		t.Errorf("样本不足时丢包应报 0（避免 1~4 个样本判死），实际 %v", loss)
	}
	if samples != 2 {
		t.Errorf("samples = %d, 期望 2", samples)
	}

	p.probeResults = []bool{false, false, false, true, true, true} // 6 个样本丢 3
	loss, samples, _ = tr.Measurement(peer)
	if samples != 6 {
		t.Errorf("samples = %d, 期望 6", samples)
	}
	if loss < 0.49 || loss > 0.51 {
		t.Errorf("loss = %v, 期望 0.5", loss)
	}
}

// H0-2：Pong 必须原样回显 Ping 的单调时间戳；RTT 只在发送侧算。
func TestProbePongEchoesTimestamp(t *testing.T) {
	tr := NewProbeTracker(nil, nodeID(1))
	peer := nodeID(2)
	tr.SetPeer(peer, &net.UDPAddr{IP: net.IPv4(1, 2, 3, 4), Port: 9999})

	// 登记一个已发探针（nonce=7），并记录发送时刻
	ts := MonotonicMS()
	tr.peers[peer].probeNonces = []uint64{7}
	tr.peers[peer].probeResults = []bool{false}

	payload, err := EncodePing(&PingMsg{TimestampMS: ts, Nonce: 7})
	if err != nil {
		t.Fatal(err)
	}
	// 直接把 Pong 交给处理入口：它应把 probeResults 置 true 并按回显值算 RTT。
	pongFrame, err := (&Frame{
		Type: MsgUdpProbe, Flags: 0, TTL: DefaultTTL,
		Payload: payload, Src: peer, Dst: nodeID(1), Counter: 7,
	}).Encode()
	if err != nil {
		t.Fatal(err)
	}
	consumed, err := tr.OnProbeFrame(nil, pongFrame)
	if err != nil || !consumed {
		t.Fatalf("处理 Pong 失败: consumed=%v err=%v", consumed, err)
	}
	if !tr.peers[peer].probeResults[0] {
		t.Error("Pong 未把对应探针标记为已应答")
	}
	// RTT 必须是「单调当前 - 回显值」量级的数（若误用墙钟会得到约 1.7e12 的差值被丢弃）
	if rtt := tr.peers[peer].lastRTTMS; rtt > 1000 {
		t.Errorf("RTT = %dms，明显不是单调口径", rtt)
	}
}

// K24 §5：迟到 / 重复回包不得改 RTT，也不能点亮**别的 peer** 的探针。
func TestProbeStaleRepliesIgnored(t *testing.T) {
	tr := NewProbeTracker(nil, nodeID(1))
	a, b := nodeID(2), nodeID(3)
	tr.SetPeer(a, &net.UDPAddr{IP: net.IPv4(1, 2, 3, 4), Port: 1000})
	tr.SetPeer(b, &net.UDPAddr{IP: net.IPv4(1, 2, 3, 5), Port: 2000})
	tr.peers[a].probeNonces = []uint64{7}
	tr.peers[a].probeResults = []bool{false}

	pong := func(src NodeID, nonce uint64) []byte {
		payload, err := EncodePing(&PingMsg{TimestampMS: MonotonicMS(), Nonce: nonce})
		if err != nil {
			t.Fatal(err)
		}
		raw, err := (&Frame{Type: MsgUdpProbe, Flags: 0, TTL: DefaultTTL,
			Payload: payload, Src: src, Dst: nodeID(1), Counter: nonce}).Encode()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	// 1) 来自 b 的同 nonce 回包：不得点亮 a 的探针，计 stale。
	if _, err := tr.OnProbeFrame(nil, pong(b, 7)); err != nil {
		t.Fatal(err)
	}
	if tr.peers[a].probeResults[0] {
		t.Fatal("别的 peer 的回包点亮了 a 的探针")
	}
	if got := tr.StaleReplies(); got != 1 {
		t.Fatalf("stale = %d, 期望 1", got)
	}

	// 2) a 的真实回包：点亮并计 RTT。
	if _, err := tr.OnProbeFrame(nil, pong(a, 7)); err != nil {
		t.Fatal(err)
	}
	if !tr.peers[a].probeResults[0] {
		t.Fatal("a 的真实回包未点亮探针")
	}
	if tr.StaleReplies() != 1 {
		t.Fatalf("真实回包不应计 stale，当前 %d", tr.StaleReplies())
	}

	// 3) 重复回包：不重复计 pong，只计 stale。
	before := tr.peers[a].pongTotal
	if _, err := tr.OnProbeFrame(nil, pong(a, 7)); err != nil {
		t.Fatal(err)
	}
	if tr.peers[a].pongTotal != before {
		t.Fatalf("重复回包被重复计入 pongTotal: %d → %d", before, tr.peers[a].pongTotal)
	}
	if got := tr.StaleReplies(); got != 2 {
		t.Fatalf("重复回包后 stale = %d, 期望 2", got)
	}
}
