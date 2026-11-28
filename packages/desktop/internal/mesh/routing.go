package mesh

import "sort"

// 转发表（W2）：LSDB → Dijkstra → 到每个可达节点的「主/备下一跳」。
//
// 对齐 MobiHop route.rs：
//   - 边权 = 邻居声明的质量样本（与 PathCandidate.Score 同一公式，见 constants.go）；
//   - 每个目的地给出 primary + backup 两组下一跳（RouteDecision）；
//   - backup 用**水平分割**求：禁掉主路径的中间节点后再跑一次 Dijkstra（H3-1），
//     这样主路径中断时不会沿同一条断掉的中段继续走。
//
// 与 MobiHop 的差异（Go 子集的边界）：
//   - 边是**有向**的：u 声明 v ⇒ u 能把帧发给 v。反向声明由 v 自己的描述符提供，
//     这样「B 认识 C、但 C 不认识 B」不会凭空造出一条 C→B 的假边；
//   - 没有 path override：PathManager 的激活路径只用于展示，不喂给本表（H0-2b 的纪律）。
const (
	// UnknownNeighborRTTMS 是邻居尚未测到 RTT 时声明的占位值。
	// 不声明 0：0ms 会把「从没测过」的边算成全图最便宜，选路整体偏航。
	UnknownNeighborRTTMS = 100
)

// RouteDecision 是到某个目的节点的下一跳决策（route.rs 的 RouteDecision 子集）。
type RouteDecision struct {
	Primary    NodeID  // 主下一跳（本机直连对端）
	Backup     NodeID  // 备用下一跳；HasBackup=false 时为零值
	Cost       float64 // 主路径总代价（毫秒当量）
	Hops       int     // 主路径跳数（直连 = 1）
	BackupCost float64 // 备用路径总代价
	HasBackup  bool
}

// RouteTable 是本机视角的全量转发表快照。
type RouteTable struct {
	Self    NodeID
	Version uint64
	Routes  map[NodeID]RouteDecision
}

// Decision 返回目的节点的决策。
func (t *RouteTable) Decision(dst NodeID) (RouteDecision, bool) {
	if t == nil {
		return RouteDecision{}, false
	}
	d, ok := t.Routes[dst]
	return d, ok
}

// NextHops 返回按优先级排列的下一跳列表（主 → 备），过滤 from 与重复项。
// from 是帧的来源链路：不把帧原路打回去。
func (t *RouteTable) NextHops(dst, from NodeID) []NodeID {
	d, ok := t.Decision(dst)
	if !ok {
		return nil
	}
	out := make([]NodeID, 0, 2)
	for _, hop := range []NodeID{d.Primary, d.Backup} {
		if hop == (NodeID{}) {
			continue
		}
		if hop == from && d.HasBackup {
			continue // 让备用有机会被选中
		}
		dup := false
		for _, h := range out {
			if h == hop {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, hop)
		}
	}
	return out
}

// edgeCostMS 把一条邻居声明折算成边权（毫秒当量，与 PathCandidate.Score 同式）。
// 缺质量样本时退化为 rtt + loss*500 + 15/跳。
func edgeCostMS(e NeighborEntry) float64 {
	rtt := float64(e.RTTMS)
	if rtt <= 0 {
		rtt = UnknownNeighborRTTMS
	}
	rttMin := rtt
	if e.RTTMinMS != nil {
		rttMin = float64(*e.RTTMinMS)
		if rttMin > rtt {
			rttMin = rtt // 样本回退时夹紧，否则方差为负、丢包边反而变便宜
		}
	}
	variance := rtt - rttMin
	if variance < 0 {
		variance = 0
	}
	jitter := 0.0
	if e.JitterMS != nil {
		jitter = float64(*e.JitterMS)
	}
	return WRttMin*rttMin + WRttVar*variance + WJitter*jitter +
		e.LossRate*LossWeight + RelayPenaltyMS
}

// buildGraph 把 LSDB 展开成有向邻接表。
func buildGraph(descs map[NodeID]NodeDescriptor) map[NodeID]map[NodeID]float64 {
	adj := make(map[NodeID]map[NodeID]float64, len(descs))
	for id, d := range descs {
		edges := make(map[NodeID]float64, len(d.Neighbors))
		for _, e := range d.Neighbors {
			if e.NodeID == id {
				continue
			}
			edges[e.NodeID] = edgeCostMS(e)
		}
		adj[id] = edges
	}
	return adj
}

type dijkstraResult struct {
	dist  map[NodeID]float64
	prev  map[NodeID]NodeID
	first map[NodeID]NodeID // 本机出发的第一跳
}

// runDijkstra 从 self 出发求最短路；banned 中的节点不能作为中转。
func runDijkstra(self NodeID, adj map[NodeID]map[NodeID]float64, banned map[NodeID]struct{}) dijkstraResult {
	dist := map[NodeID]float64{self: 0}
	prev := make(map[NodeID]NodeID)
	first := make(map[NodeID]NodeID)
	done := make(map[NodeID]struct{})

	for {
		// O(V^2)：节点数是个位数到几十，没必要上堆。
		u := NodeID{}
		best := -1.0
		found := false
		for id, d := range dist {
			if _, ok := done[id]; ok {
				continue
			}
			if !found || d < best {
				u, best, found = id, d, true
			}
		}
		if !found {
			break
		}
		done[u] = struct{}{}
		for v, w := range adj[u] {
			if _, ban := banned[v]; ban {
				continue
			}
			nd := dist[u] + w
			if old, ok := dist[v]; ok && nd >= old {
				continue
			}
			dist[v] = nd
			prev[v] = u
			if u == self {
				first[v] = v
			} else {
				first[v] = first[u]
			}
		}
	}
	return dijkstraResult{dist: dist, prev: prev, first: first}
}

// pathTo 还原 self → dst 的路径（不含 self），不可达返回 nil。
func pathTo(self, dst NodeID, r dijkstraResult) []NodeID {
	if _, ok := r.dist[dst]; !ok || dst == self {
		return nil
	}
	var rev []NodeID
	cur := dst
	for cur != self {
		rev = append(rev, cur)
		p, ok := r.prev[cur]
		if !ok {
			return nil
		}
		cur = p
	}
	out := make([]NodeID, 0, len(rev))
	for i := len(rev) - 1; i >= 0; i-- {
		out = append(out, rev[i])
	}
	return out
}

// computeRouteTable 用 LSDB 快照算出全量转发表。
func computeRouteTable(self NodeID, descs map[NodeID]NodeDescriptor, version uint64) *RouteTable {
	t := &RouteTable{Self: self, Version: version, Routes: make(map[NodeID]RouteDecision)}
	adj := buildGraph(descs)
	base := runDijkstra(self, adj, nil)

	dsts := make([]NodeID, 0, len(base.dist))
	for id := range base.dist {
		if id != self {
			dsts = append(dsts, id)
		}
	}
	sort.Slice(dsts, func(i, j int) bool { return lessNodeID(dsts[i], dsts[j]) })

	for _, dst := range dsts {
		path := pathTo(self, dst, base)
		if len(path) == 0 {
			continue
		}
		dec := RouteDecision{
			Primary: path[0],
			Cost:    base.dist[dst],
			Hops:    len(path),
		}
		// 水平分割（H3-1）：禁掉主路径上除目的外的**全部**节点（含首跳），
		// 再求一条首跳不同的备路 —— 这样主路径断在第一跳或中段都能改道。
		// 直连目的地（跳数=1）没有可禁的节点，也就没有路由层备跳。
		if len(path) > 1 {
			banned := make(map[NodeID]struct{}, len(path)-1)
			for _, id := range path[:len(path)-1] {
				banned[id] = struct{}{}
			}
			alt := runDijkstra(self, adj, banned)
			if d, ok := alt.dist[dst]; ok {
				if hop := alt.first[dst]; hop != dec.Primary {
					dec.Backup = hop
					dec.BackupCost = d
					dec.HasBackup = true
				}
			}
		}
		t.Routes[dst] = dec
	}
	return t
}
