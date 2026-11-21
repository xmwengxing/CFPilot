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
func (f *fakeRelayLink) Recv(ctx context.Context) ([]byte, error)          { return nil, context.Canceled }
func (f *fakeRelayLink) IsRelayed() bool                                   { return f.relayed }
func (f *fakeRelayLink) Close() error                                      { return nil }

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
	if state, _ := lc.punchState(peer); state != "direct" {
		t.Fatalf("升级直连后 punchState=%q, want direct", state)
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

type addrLink struct {
	baseLink
	addr *net.UDPAddr
	sent [][]byte
}

func (l *addrLink) Send(ctx context.Context, frame []byte) error {
	l.sent = append(l.sent, append([]byte(nil), frame...))
	return nil
}
func (l *addrLink) SendProbe(ctx context.Context, frame []byte) error { return l.Send(ctx, frame) }
func (l *addrLink) Recv(ctx context.Context) ([]byte, error)          { return nil, context.Canceled }
func (l *addrLink) PeerAddr() *net.UDPAddr                            { return l.addr }
func (l *addrLink) Close() error                                      { return nil }

// 收到 PunchRequest：必须回 PunchReply（携带本机候选、回显 nonce）。
func TestHandlePunchRequestReplies(t *testing.T) {
	lc := &meshLifecycle{
		cfg:   Config{NodeID: NodeID{1}, Listen: "0.0.0.0:51820"},
		links: make(map[NodeID]PeerLink),
	}
	peer := NodeID{2}
	link := &addrLink{}
	lc.links[peer] = link
	req := &PunchMessage{PunchReq: &PunchRequest{From: peer, Nonce: 7, Candidates: []Candidate{
		{Addr: NewV4Addr([4]byte{10, 0, 0, 1}, 51820), Kind: CandidateHost},
	}}}
	raw, err := lc.encodePunchFrame(peer, req)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	lc.handlePunch(peer, parsed, link.addr)
	if len(link.sent) == 0 {
		t.Fatal("应回 PunchReply")
	}
	replyFrame, err := Decode(link.sent[0])
	if err != nil {
		t.Fatal(err)
	}
	reply, err := DecodePunchMessage(replyFrame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if reply.PunchReply == nil || reply.PunchReply.Nonce != 7 {
		t.Fatalf("reply 不匹配: %+v", reply)
	}
	if len(reply.PunchReply.Candidates) == 0 {
		// 本机至少应有 host 候选（无网卡的环境允许为空，但这里跳过而不是失败）
		t.Log("本机没有可用 IPv4 网卡，候选为空")
	}
}

// 收到 PunchProbe：必须回 PunchAck 到**探测来源地址**（而不是中继链路）。
func TestHandlePunchProbeAcksToSourceAddr(t *testing.T) {
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
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
	link := &addrLink{addr: listener.LocalAddr().(*net.UDPAddr)}
	lc.links[peer] = link

	probe := &PunchMessage{PunchProbe: &PunchProbe{From: peer, Nonce: 9}}
	raw, err := lc.encodePunchFrame(peer, probe)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	lc.handlePunch(peer, parsed, link.addr)

	// 等待 Ack 到达监听端
	_ = listener.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, MaxFrame)
	n, _, err := listener.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("未收到 PunchAck: %v", err)
	}
	f, err := Decode(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	ack, err := DecodePunchMessage(f.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if ack.PunchAck == nil || ack.PunchAck.Nonce != 9 {
		t.Fatalf("Ack 不匹配: %+v", ack)
	}
	// 同时应升级为直连
	if lc.links[peer].IsRelayed() {
		t.Fatal("收到探测后应升级为直连 hubLink")
	}
}

