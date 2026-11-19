//go:build mesh

package mesh

import (
	"context"
	"net"
	"testing"
	"time"
)

// P3 打洞：最小可验证集（消息封装、候选转换、升级直连）。
// 完整的两端 NAT 打洞需要真机矩阵（见 E2E_TEST.md §7）。

type fakeRelayLink struct {
	baseLink
	sent    [][]byte
	relayed bool
}

func (f *fakeRelayLink) Send(ctx context.Context, frame []byte) error {
	f.sent = append(f.sent, append([]byte(nil), frame...))
	return nil
}
func (f *fakeRelayLink) SendProbe(ctx context.Context, frame []byte) error { return f.Send(ctx, frame) }
func (f *fakeRelayLink) Recv(ctx context.Context) ([]byte, error)         { return nil, context.Canceled }
func (f *fakeRelayLink) IsRelayed() bool                                  { return f.relayed }
func (f *fakeRelayLink) Close() error                                     { return nil }

func TestPunchFrameRoundTrip(t *testing.T) {
	lc := &meshLifecycle{
		cfg: Config{NodeID: NodeID{1, 2, 3, 4, 5, 6, 7, 8}, Listen: "0.0.0.0:51820"},
	}
	peer := NodeID{9, 9, 9, 9, 9, 9, 9, 9}
	msg := &PunchMessage{PunchReq: &PunchRequest{
		From:       lc.cfg.NodeID,
		Candidates: []Candidate{{Addr: NewV4Addr([4]byte{10, 0, 0, 1}, 51820), Kind: CandidateHost, Priority: 1}},
		Nonce:      42,
	}}
	frame, err := lc.encodePunchFrame(peer, msg)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Decode(frame)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Type != MsgHolePunch {
		t.Fatalf("type = %#x", parsed.Type)
	}
	if parsed.Version != WireVersionDefault {
		t.Errorf("版本应为默认 v2，实际 %#x", parsed.Version)
	}
	got, err := DecodePunchMessage(parsed.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if got.PunchReq == nil || got.PunchReq.Nonce != 42 {
		t.Fatalf("PunchReq 解析失败: %+v", got)
	}
	if len(got.PunchReq.Candidates) != 1 {
		t.Fatalf("候选数 = %d", len(got.PunchReq.Candidates))
	}
}

func TestCandidateUDP(t *testing.T) {
	c := Candidate{Addr: NewV4Addr([4]byte{192, 168, 1, 10}, 51820), Kind: CandidateHost}
	addr := candidateUDP(c)
	if addr == nil || addr.IP.String() != "192.168.1.10" || addr.Port != 51820 {
		t.Fatalf("转换失败: %+v", addr)
	}
}

func TestUpgradeToDirectOnlyFromRelay(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	lc := &meshLifecycle{
		cfg:   Config{NodeID: NodeID{1}, Listen: "0.0.0.0:51820"},
		hub:   hub,
		links: make(map[NodeID]PeerLink),
	}
	peer := NodeID{2}
	relay := &fakeRelayLink{relayed: true}
	lc.links[peer] = relay
	addr, _ := net.ResolveUDPAddr("udp", "127.0.0.1:51999")
	lc.upgradeToDirect(peer, addr)
	if lc.links[peer].IsRelayed() {
		t.Fatal("应从中继升级为直连 hubLink")
	}
	// 已是直连时不做无谓切换（保持原对象）
	direct := lc.links[peer]
	lc.upgradeToDirect(peer, addr)
	if lc.links[peer] != direct {
		t.Error("直连状态下不应重复替换链路")
	}
}

func TestListenPort(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int
	}{
		{"0.0.0.0:51820", 51820},
		{"127.0.0.1:1234", 1234},
		{"", 51820},
		{"bad", 51820},
	} {
		if got := listenPort(c.in); got != c.want {
			t.Errorf("listenPort(%q)=%d want %d", c.in, got, c.want)
		}
	}
}

// 防御性：打洞窗口常量必须是正数（避免改成 0 导致空转）
func TestPunchWindowConstants(t *testing.T) {
	if punchProbeWindow <= 0 || punchProbeInterval <= 0 {
		t.Fatal("打洞窗口/间隔必须为正")
	}
	if punchProbeWindow > 10*time.Second {
		t.Error("打洞窗口过长会拖慢降级回退")
	}
}
