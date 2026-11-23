//go:build mesh

package mesh

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/flynn/noise"
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

func setupPunchSession(lc *meshLifecycle, peer NodeID) {
	lc.fsm = NewHandshakeFSM(lc.cfg.NodeID, [32]byte{}, [32]byte{}, noise.DHKey{})
	lc.fsm.installSessionLocked(peer, nil)
}

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

func TestNAT4AdvertisesOneObservedIPv4Candidate(t *testing.T) {
	assessment := classifyMappings([]StunMapping{
		{IP: "203.0.113.5", Port: 5000, Address: "203.0.113.5:5000"},
		{IP: "203.0.113.5", Port: 5001, Address: "203.0.113.5:5001"},
	}, 4)
	lc := &meshLifecycle{nat: assessment}
	got := 0
	for _, candidate := range lc.localCandidates() {
		if candidate.Kind == CandidateServerReflexive && candidate.Addr.V4 != nil {
			got++
			if addr := candidateUDP(candidate).String(); addr != "203.0.113.5:5000" {
				t.Fatalf("IPv4 反射候选=%q", addr)
			}
		}
	}
	if got != 1 || assessment.Reflexive != "" {
		t.Fatalf("NAT4 候选数=%d，稳定映射=%q", got, assessment.Reflexive)
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
		cfg:    Config{NodeID: NodeID{1}, Listen: "0.0.0.0:51820"},
		links:  make(map[NodeID]PeerLink),
		runCtx: context.Background(),
	}
	peer := NodeID{2}
	setupPunchSession(lc, peer)
	link := &fakeRelayLink{relayed: true}
	lc.links[peer] = link
	req := &PunchMessage{PunchReq: &PunchRequest{From: peer, Nonce: 7, Candidates: []Candidate{
		{Addr: NewV4Addr([4]byte{10, 0, 0, 1}, 51820), Kind: CandidateHost},
	}}}
	sender := &meshLifecycle{cfg: Config{NodeID: peer}}
	raw, err := sender.encodePunchFrame(lc.cfg.NodeID, req)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	lc.handlePunch(peer, parsed, nil)
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

func TestInvitedPeerReportsProbeAndCancels(t *testing.T) {
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	peer := NodeID{2}
	lc := &meshLifecycle{
		cfg:    Config{NodeID: NodeID{1}, Listen: "127.0.0.1:0"},
		hub:    hub,
		links:  map[NodeID]PeerLink{peer: &fakeRelayLink{relayed: true}},
		runCtx: ctx,
	}
	setupPunchSession(lc, peer)
	request := &PunchMessage{PunchReq: &PunchRequest{From: peer, Nonce: 7, Candidates: []Candidate{
		{Addr: NewV4Addr([4]byte{127, 0, 0, 1}, uint16(listener.LocalAddr().(*net.UDPAddr).Port)), Kind: CandidateHost},
	}}}
	payload, err := EncodePunchMessage(request)
	if err != nil {
		t.Fatal(err)
	}
	lc.handlePunch(peer, &Frame{Src: peer, Dst: lc.cfg.NodeID, Type: MsgHolePunch, Payload: payload}, nil)
	if state, kind := lc.punchState(peer); state != "probing" || kind != "host" {
		t.Fatalf("收到请求后应显示正在探测，实际 %q / %q", state, kind)
	}
	_ = listener.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, MaxFrame)
	n, addr, err := listener.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	if addr.Port != hub.LocalAddr().Port {
		t.Fatalf("应从组网 socket 发探针，实际端口 %d", addr.Port)
	}
	frame, err := Decode(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodePunchMessage(frame.Payload)
	if err != nil || got.PunchProbe == nil || got.PunchProbe.Nonce != 7 {
		t.Fatalf("未收到当轮探针: %+v, %v", got, err)
	}
	cancel()
	done := make(chan struct{})
	go func() {
		lc.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("取消后探测没有立即结束")
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
		cfg:    Config{NodeID: NodeID{1}, Listen: "0.0.0.0:51820"},
		hub:    hub,
		links:  make(map[NodeID]PeerLink),
		runCtx: context.Background(),
	}
	peer := NodeID{2}
	setupPunchSession(lc, peer)
	lc.punch = map[NodeID]*punchRun{peer: {requestNonce: 9, requestUntil: time.Now().Add(2 * time.Second)}}
	link := &fakeRelayLink{relayed: true}
	lc.links[peer] = link

	probe := &PunchMessage{PunchProbe: &PunchProbe{From: peer, Nonce: 9}}
	sender := &meshLifecycle{cfg: Config{NodeID: peer}}
	raw, err := sender.encodePunchFrame(lc.cfg.NodeID, probe)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	lc.handlePunch(peer, parsed, listener.LocalAddr().(*net.UDPAddr))

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

type retryPunchLink struct {
	baseLink
	sends chan struct{}
}

func (link *retryPunchLink) Send(context.Context, []byte) error {
	select {
	case link.sends <- struct{}{}:
	default:
	}
	return errors.New("测试：中继暂时不可用")
}

func (link *retryPunchLink) SendProbe(ctx context.Context, frame []byte) error {
	return link.Send(ctx, frame)
}

func (*retryPunchLink) Recv(ctx context.Context) ([]byte, error) { return nil, ctx.Err() }
func (*retryPunchLink) IsRelayed() bool                          { return true }
func (*retryPunchLink) Close() error                             { return nil }

func TestPunchRetryUsesReplacementRelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	peer := NodeID{2}
	initial := &retryPunchLink{sends: make(chan struct{}, 1)}
	replacement := &retryPunchLink{sends: make(chan struct{}, 1)}
	lc := &meshLifecycle{
		cfg:    Config{NodeID: NodeID{1}, PublicAddr: "203.0.113.5:51820"},
		links:  map[NodeID]PeerLink{peer: initial},
		runCtx: ctx,
	}
	lc.startPunch(peer, initial)
	select {
	case <-initial.sends:
	case <-time.After(time.Second):
		t.Fatal("未向初始中继发送探测信令")
	}
	lc.mu.Lock()
	lc.links[peer] = replacement
	lc.mu.Unlock()
	select {
	case <-replacement.sends:
	case <-time.After(punchRetryBase + 2*time.Second):
		t.Fatal("中继发送失败后应使用当前链路重试")
	}
	cancel()
	lc.wg.Wait()
}
