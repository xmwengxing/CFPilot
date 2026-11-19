//go:build mesh

package mesh

import (
	"bytes"
	"testing"
)

// 节点转发：打洞信令可经第三方节点中转，且不能破坏 E2E 头语义。
func TestForwardToKnownDst(t *testing.T) {
	lc := &meshLifecycle{
		cfg:   Config{NodeID: NodeID{1}},
		links: make(map[NodeID]PeerLink),
	}
	from := &fakeRelayLink{}
	to := &fakeRelayLink{}
	lc.links[NodeID{2}] = from
	lc.links[NodeID{3}] = to

	f := &Frame{Type: MsgGossip, TTL: 8, Payload: []byte("hello"), Src: NodeID{2}, Dst: NodeID{3}}
	if !lc.forwardTo(f, from) {
		t.Fatal("目标已知时应转发并返回 true")
	}
	if len(to.sent) != 1 {
		t.Fatalf("转发次数 = %d, 期望 1", len(to.sent))
	}
	if len(from.sent) != 0 {
		t.Error("不应回发给来源链路")
	}
	out, err := Decode(to.sent[0])
	if err != nil {
		t.Fatal(err)
	}
	if out.Dst != (NodeID{3}) || out.Src != (NodeID{2}) {
		t.Errorf("src/dst 不应被改写: %v -> %v", out.Src, out.Dst)
	}
	if out.TTL != 7 {
		t.Errorf("TTL = %d, 期望 7", out.TTL)
	}
	if out.Flags&FlagRelayed == 0 {
		t.Error("转发应置 RELAYED 位")
	}
	if !bytes.Equal(out.Payload, []byte("hello")) {
		t.Error("载荷不应被改写（加密帧改了就会 AEAD 失败）")
	}
}

func TestForwardUnknownDstNotConsumed(t *testing.T) {
	lc := &meshLifecycle{cfg: Config{NodeID: NodeID{1}}, links: make(map[NodeID]PeerLink)}
	f := &Frame{Type: MsgGossip, TTL: 8, Payload: []byte("x"), Src: NodeID{2}, Dst: NodeID{9}}
	if lc.forwardTo(f, nil) {
		t.Fatal("目标未知时不应吞掉帧（交回调用方）")
	}
}

func TestForwardTTLZeroDrops(t *testing.T) {
	lc := &meshLifecycle{cfg: Config{NodeID: NodeID{1}}, links: make(map[NodeID]PeerLink)}
	to := &fakeRelayLink{}
	lc.links[NodeID{3}] = to
	f := &Frame{Type: MsgGossip, TTL: 0, Payload: []byte("x"), Src: NodeID{2}, Dst: NodeID{3}}
	if !lc.forwardTo(f, nil) {
		t.Fatal("TTL=0 应被消费（丢弃）")
	}
	if len(to.sent) != 0 {
		t.Error("TTL=0 不应转发")
	}
}

func TestForwardBroadcastFansOut(t *testing.T) {
	lc := &meshLifecycle{cfg: Config{NodeID: NodeID{1}}, links: make(map[NodeID]PeerLink)}
	a, b := &fakeRelayLink{}, &fakeRelayLink{}
	lc.links[NodeID{2}] = a
	lc.links[NodeID{3}] = b
	f := &Frame{Type: MsgGossip, TTL: 5, Payload: []byte("g"), Src: NodeID{2}, Dst: broadcastNodeID()}
	lc.forwardBroadcast(f, a)
	if len(a.sent) != 0 {
		t.Error("广播不应回发来源")
	}
	if len(b.sent) != 1 {
		t.Fatalf("广播应扇出到其它链路，实际 %d", len(b.sent))
	}
	out, err := Decode(b.sent[0])
	if err != nil {
		t.Fatal(err)
	}
	if out.TTL != 4 {
		t.Errorf("广播 TTL = %d, 期望 4", out.TTL)
	}
}

func TestBroadcastNodeID(t *testing.T) {
	var want NodeID
	for i := range want {
		want[i] = 0xff
	}
	if got := broadcastNodeID(); got != want {
		t.Errorf("broadcastNodeID = %v", got)
	}
}
