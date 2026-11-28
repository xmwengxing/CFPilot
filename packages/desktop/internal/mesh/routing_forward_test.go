//go:build mesh

package mesh

import (
	"context"
	"errors"
	"testing"
	"time"
)

// W2 接线：forwardTo 走转发表、主跳失败退备跳、邻居声明与版本化重建。

type failLink struct{ baseLink }

func (f *failLink) Send(ctx context.Context, frame []byte) error      { return errors.New("链路故障") }
func (f *failLink) SendProbe(ctx context.Context, frame []byte) error { return nil }
func (f *failLink) Recv(ctx context.Context) ([]byte, error)          { return nil, context.Canceled }
func (f *failLink) Close() error                                      { return nil }

// newRouteLC 造一个只带 gossip + 链路的最小生命周期（不启动 TUN / 网络）。
func newRouteLC(t *testing.T, self NodeID, links map[NodeID]PeerLink) *meshLifecycle {
	t.Helper()
	ident := &Identity{NodeID: self}
	g, err := NewGossip(ident, "10.97.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return &meshLifecycle{cfg: Config{NodeID: self}, links: links, gossip: g}
}

// addDesc 把描述符直接塞进 LSDB（单测不走签名/网络）。
func addDesc(g *Gossip, ds ...NodeDescriptor) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, d := range ds {
		if cur, ok := g.lsdb[d.NodeID]; ok {
			d.Neighbors = append(cur.Neighbors, d.Neighbors...)
		}
		g.lsdb[d.NodeID] = d
		g.seen[d.NodeID] = time.Now()
	}
	g.version++
}

// 目标不是直连邻居时，按转发表经中间节点转发（A→B→C）。
func TestForwardUsesRouteTableForIndirectDst(t *testing.T) {
	a, b, c := nid(1), nid(2), nid(3)
	bl := &fakeRelayLink{}
	lc := newRouteLC(t, a, map[NodeID]PeerLink{b: bl})
	addDesc(lc.gossip, link(a, b, 10, 0), link(b, c, 10, 0))

	f := &Frame{Type: MsgGossip, TTL: 8, Payload: []byte("x"), Src: a, Dst: c}
	if !lc.forwardTo(f, nil) {
		t.Fatal("有路由时应转发")
	}
	if len(bl.sent) != 1 {
		t.Fatalf("应经 B 转发一次，实际 %d", len(bl.sent))
	}
	out, err := Decode(bl.sent[0])
	if err != nil {
		t.Fatal(err)
	}
	if out.Dst != c || out.TTL != 7 || out.Flags&FlagRelayed == 0 {
		t.Errorf("转发帧语义错误: dst=%v ttl=%d flags=%d", out.Dst[:4], out.TTL, out.Flags)
	}
	_, _, _, _, forwarded, dropped := lc.Accounting()
	if forwarded != 1 || dropped != 0 {
		t.Errorf("转发分账 = (forwarded %d, dropped %d), 期望 (1, 0)", forwarded, dropped)
	}
}

// 主下一跳发送失败时退到转发表的备用下一跳。
func TestForwardFallsBackToBackupHop(t *testing.T) {
	a, b, d, e := nid(1), nid(2), nid(4), nid(5)
	bad, good := &failLink{}, &fakeRelayLink{}
	lc := newRouteLC(t, a, map[NodeID]PeerLink{b: bad, d: good})
	// A—B 更便宜（主），A—D 更贵（备）；B、D 都能到 E。
	addDesc(lc.gossip, link(a, b, 10, 0), link(a, d, 30, 0),
		link(b, e, 10, 0), link(d, e, 10, 0))
	if dec, ok := lc.routeTable().Decision(e); !ok || dec.Primary != b || dec.Backup != d {
		t.Fatalf("前置拓扑错误: %+v ok=%v", dec, ok)
	}

	f := &Frame{Type: MsgGossip, TTL: 8, Payload: []byte("y"), Src: a, Dst: e}
	if !lc.forwardTo(f, nil) {
		t.Fatal("主跳失败后仍应尝试备跳")
	}
	if len(good.sent) != 1 {
		t.Fatalf("应退到备跳 D 转发，实际 %d", len(good.sent))
	}
}

// 转发表按 LSDB 版本惰性重建：版本没变不重算，变了才重算一次。
func TestRouteTableRebuildsOnlyOnLSDBChange(t *testing.T) {
	a, b, c := nid(1), nid(2), nid(3)
	lc := newRouteLC(t, a, map[NodeID]PeerLink{b: &fakeRelayLink{}})
	addDesc(lc.gossip, link(a, b, 10, 0), link(b, c, 10, 0))

	first := lc.routeTable()
	rebuilds := lc.routeRebuildCount()
	if _, ok := first.Decision(c); !ok {
		t.Fatal("首次重建应看到 C")
	}
	if again := lc.routeTable(); again != first || lc.routeRebuildCount() != rebuilds {
		t.Error("LSDB 未变时不应重建转发表")
	}

	addDesc(lc.gossip, link(b, nid(7), 10, 0))
	third := lc.routeTable()
	if lc.routeRebuildCount() != rebuilds+1 {
		t.Errorf("LSDB 变化后应重建一次，实际 %d", lc.routeRebuildCount()-rebuilds)
	}
	if _, ok := third.Decision(nid(7)); !ok {
		t.Error("重建后应包含新目的")
	}
}

// 邻居声明只包含直连链路：中继腿不是拓扑边。
func TestNeighborEntriesExcludeRelayed(t *testing.T) {
	a, b, c := nid(1), nid(2), nid(3)
	lc := newRouteLC(t, a, map[NodeID]PeerLink{
		b: &fakeRelayLink{relayed: true},
		c: &fakeRelayLink{},
	})
	entries := lc.neighborEntries()
	if len(entries) != 1 || entries[0].NodeID != c {
		t.Fatalf("邻居声明 = %+v, 期望只有直连的 C", entries)
	}
	if entries[0].RTTMS != UnknownNeighborRTTMS {
		t.Errorf("无探针样本时 RTT 应声明占位值 %d，实际 %d", UnknownNeighborRTTMS, entries[0].RTTMS)
	}
	lc.refreshNeighbors()
	if got := lc.gossip.Neighbors(); len(got) != 1 {
		t.Errorf("本地描述符邻居数 = %d, 期望 1", len(got))
	}
}
