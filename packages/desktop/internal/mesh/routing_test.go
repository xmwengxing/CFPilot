package mesh

import "testing"

// W2 路由：LSDB → Dijkstra → 主/备下一跳。

func nid(b byte) NodeID {
	var n NodeID
	n[0] = b
	return n
}

// link 生成一条「from 声明 to」的邻居边（rtt/loss 可调）。
func link(from, to NodeID, rtt uint32, loss float64) NodeDescriptor {
	return NodeDescriptor{
		NodeID:    from,
		Neighbors: []NeighborEntry{{NodeID: to, RTTMS: rtt, LossRate: loss}},
	}
}

// mergeDescs 按 NodeID 合并描述符，邻居列表**追加**而不是覆盖：
// 同一节点往往有多条边（link(b,a) + link(b,c)），覆盖式合并会悄悄丢边。
func mergeDescs(ds ...NodeDescriptor) map[NodeID]NodeDescriptor {
	out := make(map[NodeID]NodeDescriptor, len(ds))
	for _, d := range ds {
		cur, ok := out[d.NodeID]
		if !ok {
			cur = NodeDescriptor{NodeID: d.NodeID}
		}
		cur.Neighbors = append(cur.Neighbors, d.Neighbors...)
		out[d.NodeID] = cur
	}
	return out
}

// A—B—C：A 到 C 必须经 B（直连不存在），跳数 2。
func TestRouteTwoHopChain(t *testing.T) {
	a, b, c := nid(1), nid(2), nid(3)
	descs := mergeDescs(
		link(a, b, 10, 0), link(b, a, 10, 0), link(b, c, 10, 0), link(c, b, 10, 0),
	)
	tbl := computeRouteTable(a, descs, 1)

	dec, ok := tbl.Decision(c)
	if !ok {
		t.Fatal("A 应能算出到 C 的路由")
	}
	if dec.Primary != b {
		t.Errorf("A→C 主下一跳 = %v, 期望 B", dec.Primary[:4])
	}
	if dec.Hops != 2 {
		t.Errorf("跳数 = %d, 期望 2", dec.Hops)
	}
	if dec.HasBackup {
		t.Error("链式拓扑不应有备用下一跳")
	}
	if _, ok := tbl.Decision(b); !ok {
		t.Error("直连邻居也应有决策")
	}
}

// 菱形拓扑：A—B—D 比 A—C—D 便宜，备用必须走 C（水平分割）。
func TestRouteDiamondPicksCheaperAndBackup(t *testing.T) {
	a, b, c, d := nid(1), nid(2), nid(3), nid(4)
	descs := mergeDescs(
		link(a, b, 10, 0), link(a, c, 30, 0),
		link(b, a, 10, 0), link(b, d, 10, 0),
		link(c, a, 30, 0), link(c, d, 10, 0),
		link(d, b, 10, 0), link(d, c, 10, 0),
	)
	tbl := computeRouteTable(a, descs, 1)
	dec, ok := tbl.Decision(d)
	if !ok {
		t.Fatal("A 应能算出到 D 的路由")
	}
	if dec.Primary != b {
		t.Errorf("主下一跳 = %v, 期望 B（更便宜）", dec.Primary[:4])
	}
	// 10+15 + 10+15 = 50
	if dec.Cost != 50 {
		t.Errorf("主路径代价 = %v, 期望 50", dec.Cost)
	}
	if !dec.HasBackup || dec.Backup != c {
		t.Errorf("备用下一跳 = %v (has=%v), 期望 C", dec.Backup[:4], dec.HasBackup)
	}
	if dec.BackupCost <= dec.Cost {
		t.Errorf("备用代价 %v 应大于主路径 %v", dec.BackupCost, dec.Cost)
	}
}

// 丢包边必须被绕开：同 RTT 下 loss 0.5 的边让主路径改走另一侧。
func TestRouteAvoidsLossyLink(t *testing.T) {
	a, b, c, d := nid(1), nid(2), nid(3), nid(4)
	descs := mergeDescs(
		link(a, b, 10, 0.5), link(a, c, 10, 0),
		link(b, d, 10, 0), link(c, d, 10, 0),
		link(d, b, 10, 0), link(d, c, 10, 0),
	)
	tbl := computeRouteTable(a, descs, 1)
	dec, _ := tbl.Decision(d)
	if dec.Primary != c {
		t.Errorf("主下一跳 = %v, 期望 C（绕开 50%% 丢包的 B 侧）", dec.Primary[:4])
	}
}

// 不可达节点不进表；本机不进表。
func TestRouteUnreachableAndSelf(t *testing.T) {
	a, b, x := nid(1), nid(2), nid(9)
	descs := mergeDescs(link(a, b, 10, 0), link(b, a, 10, 0), link(x, b, 10, 0))
	tbl := computeRouteTable(a, descs, 1)
	if _, ok := tbl.Decision(x); ok {
		t.Error("X 与 A 之间没有路径，不应进表")
	}
	if _, ok := tbl.Decision(a); ok {
		t.Error("本机不应作为路由目的")
	}
	if len(tbl.Routes) != 1 {
		t.Errorf("可达目的应只有 B，实际 %d", len(tbl.Routes))
	}
}

// 边权公式：稳定边 = rtt + 15/跳；抖动与丢包各自加价。
func TestEdgeCostQuality(t *testing.T) {
	rttMin, noJitter := uint32(20), uint32(0)
	stable := NeighborEntry{NodeID: nid(2), RTTMS: 20, RTTMinMS: &rttMin, JitterMS: &noJitter}
	if got := edgeCostMS(stable); got != 35 {
		t.Errorf("稳定边权 = %v, 期望 20+15", got)
	}
	jitter := uint32(20)
	jittery := NeighborEntry{NodeID: nid(2), RTTMS: 20, RTTMinMS: &rttMin, JitterMS: &jitter}
	if edgeCostMS(jittery) <= edgeCostMS(stable) {
		t.Errorf("抖动边应更贵: jittery=%v stable=%v", edgeCostMS(jittery), edgeCostMS(stable))
	}
	lossy := NeighborEntry{NodeID: nid(2), RTTMS: 10, LossRate: 0.2}
	if got, want := edgeCostMS(lossy), 10.0+0.2*LossWeight+RelayPenaltyMS; got != want {
		t.Errorf("丢包边权 = %v, 期望 %v", got, want)
	}
	// 未测到 RTT 时用占位值，不能算成 0ms 的免费边
	zero := NeighborEntry{NodeID: nid(3)}
	if edgeCostMS(zero) < float64(UnknownNeighborRTTMS) {
		t.Errorf("未测 RTT 的边权 = %v, 不应低于占位值 %d", edgeCostMS(zero), UnknownNeighborRTTMS)
	}
}

// NextHops：主 → 备，且不把帧原路打回来源。
func TestNextHopsSkipsFrom(t *testing.T) {
	tbl := &RouteTable{Routes: map[NodeID]RouteDecision{
		nid(9): {Primary: nid(2), Backup: nid(3), HasBackup: true},
	}}
	if got := tbl.NextHops(nid(9), NodeID{}); len(got) != 2 {
		t.Fatalf("应返回主备两跳，实际 %v", got)
	}
	if got := tbl.NextHops(nid(9), nid(2)); len(got) != 1 || got[0] != nid(3) {
		t.Errorf("来源=主下一跳时应只剩备跳，实际 %v", got)
	}
	if got := tbl.NextHops(nid(8), NodeID{}); got != nil {
		t.Errorf("未知目的应返回 nil，实际 %v", got)
	}
}
