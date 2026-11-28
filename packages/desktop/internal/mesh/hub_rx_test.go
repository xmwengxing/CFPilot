package mesh

import (
	"net"
	"testing"
)

// newRxTestHub 构造一个不绑 socket 的 hub：分账只依赖 demux 的表与队列。
func newRxTestHub() *UdpHub {
	return &UdpHub{
		peers:  make(map[string]*hubLink),
		byNode: make(map[NodeID]*hubLink),
		relays: make(map[string]bool),
	}
}

func udpAddr(port int) *net.UDPAddr {
	return &net.UDPAddr{IP: net.IPv4(203, 0, 113, 7), Port: port}
}

func mustFrame(t *testing.T, typ MsgType, src, dst NodeID) []byte {
	t.Helper()
	raw, err := (&Frame{Version: WireVersionV2, Type: typ, Src: src, Dst: dst, Payload: []byte{1, 2, 3}}).Encode()
	if err != nil {
		t.Fatalf("编码帧失败: %v", err)
	}
	return raw
}

// TestHubRxClassifiesEveryDatagram 覆盖七类入口，并断言「一次数据报只进一个桶」。
func TestHubRxClassifiesEveryDatagram(t *testing.T) {
	h := newRxTestHub()
	peerA, peerB, peerC := nid(0xA1), nid(0xB1), nid(0xC1)
	direct := udpAddr(40001)
	relay := udpAddr(40002)
	fresh := udpAddr(40003)
	h.AddRelayAddr(relay)

	var probed, controlled int
	h.onProbe = func([]byte) { probed++ }
	h.onControl = func(*net.UDPAddr, []byte) { controlled++ }
	var rawSeen int
	h.onRaw = func([]byte) { rawSeen++ }

	// 1) 非本协议报文：首字节不是 magic（STUN 响应）
	h.observeDatagram(direct, []byte{0x01, 0x01, 0x00, 0x00})
	// 2) 太短：连 3 字节都不到，同样算 raw
	h.observeDatagram(direct, []byte{MagicByte})
	// 3) magic 对但解不出 32B 头
	h.observeDatagram(direct, []byte{MagicByte, WireVersionV2, byte(MsgData)})
	// 4) 入站探针
	h.observeDatagram(direct, mustFrame(t, MsgUdpProbe, peerA, peerB))
	// 5) 打洞控制帧（只观察，不投递）
	h.observeDatagram(direct, mustFrame(t, MsgHolePunch, peerA, peerB))
	// 6) 中继管理帧（观察后仍投递）
	h.observeDatagram(direct, mustFrame(t, MsgRelayMgmt, peerA, peerB))
	// 7) 中继地址送来的帧
	h.observeDatagram(relay, mustFrame(t, MsgData, peerC, peerB))
	// 8) 新地址首帧 → discovered（用干净地址：RelayMgmt 已经建过 direct 的链路）
	h.observeDatagram(fresh, mustFrame(t, MsgData, peerA, peerB))
	// 9) 同一地址的第二帧 → direct
	h.observeDatagram(fresh, mustFrame(t, MsgData, peerA, peerB))

	st := h.RXStats()
	if st.Total != 9 {
		t.Fatalf("rx_total 应为 9，实际 %d", st.Total)
	}
	if st.Raw != 2 || st.Malformed != 1 || st.Probe != 1 || st.Control != 2 ||
		st.Relay != 1 || st.Discovered != 1 || st.Direct != 1 {
		t.Fatalf("分类不符: %+v", st)
	}
	if got := st.Unexplained(); got != 0 {
		t.Fatalf("分账残差必须为 0，实际 %d（total=%d sum=%d）", got, st.Total, st.Classified())
	}
	if probed != 1 || controlled != 2 || rawSeen != 2 {
		t.Fatalf("回调次数不符: probe=%d control=%d raw=%d", probed, controlled, rawSeen)
	}
	// direct 地址只收到过 RelayMgmt 一帧（控制帧观察后仍投递）。
	if len(h.peers[direct.String()].rx) != 1 {
		t.Fatalf("direct 地址队列应有 1 帧（RelayMgmt），实际 %d", len(h.peers[direct.String()].rx))
	}
	// fresh 地址：新地址首帧 + 第二帧都在队列里。
	if len(h.peers[fresh.String()].rx) != 2 {
		t.Fatalf("fresh 地址队列应有 2 帧，实际 %d", len(h.peers[fresh.String()].rx))
	}
	if len(h.byNode[peerC].rx) != 1 {
		t.Fatalf("中继腿应收到 1 帧，实际 %d", len(h.byNode[peerC].rx))
	}
}

// TestHubRxQueueDropIsSubsetOfClass 断言队列满只增加 QueueDrop，不破坏分账闭合。
func TestHubRxQueueDropIsSubsetOfClass(t *testing.T) {
	h := newRxTestHub()
	peerA, peerB := nid(0xA1), nid(0xB1)
	addr := udpAddr(40011)
	// 先把队列占满：手工建一条容量 0 的链路（select default 必然命中）。
	h.peers[addr.String()] = &hubLink{hub: h, addr: addr, rx: make(chan []byte)}
	h.observeDatagram(addr, mustFrame(t, MsgData, peerA, peerB))

	st := h.RXStats()
	if st.Total != 1 || st.Direct != 1 || st.QueueDrop != 1 {
		t.Fatalf("预期 total=1 direct=1 queueDrop=1，实际 %+v", st)
	}
	if st.Unexplained() != 0 {
		t.Fatalf("队列丢弃不能打破分账闭合: %+v", st)
	}
}

// TestHubRxUnexplainedDetectsLeak 证明残差能把「漏记账」暴露出来。
func TestHubRxUnexplainedDetectsLeak(t *testing.T) {
	st := HubRxStats{Total: 5, Direct: 4}
	if got := st.Unexplained(); got != 1 {
		t.Fatalf("残差应为 1，实际 %d", got)
	}
	st = HubRxStats{Total: 3, Direct: 4}
	if got := st.Unexplained(); got != -1 {
		t.Fatalf("重复记账应给出负残差，实际 %d", got)
	}
}

// TestHubRxClassNames 覆盖 String()，保证日志里的桶名稳定。
func TestHubRxClassNames(t *testing.T) {
	cases := map[rxClass]string{
		rxClassDirect: "direct", rxClassRelay: "relay", rxClassDiscovered: "discovered",
		rxClassProbe: "probe", rxClassControl: "control", rxClassRaw: "raw",
		rxClassMalformed: "malformed", rxClass(0): "unknown",
	}
	for c, want := range cases {
		if got := c.String(); got != want {
			t.Fatalf("分类名不符: %d → %q，期望 %q", c, got, want)
		}
	}
}
