//go:build mesh

package mesh

import (
	"context"
	"fmt"
	"log"
)

// 转发表的本机侧：邻居声明采集 + 按 LSDB 版本惰性重建（W2）。
//
// 为什么要「版本号 + 惰性重建」：Gossip 每 5s 一次、每次可能带多个描述符，
// 每收到一个就重算 Dijkstra 会白烧 CPU（节点数小，但重建频率高）；
// 惰性重建把成本摊到真正要用转发表的时候，且保证用的是同一份 LSDB 快照。

// neighborEntries 采集本机**直连**对端的实测质量，生成邻居声明。
//
// 中继腿（WSS 房间 / 盲中继）不写进 LSDB：它不是拓扑边，把它当边会让对端
// 把「经中继可达」算成一条便宜直连路径（与 K24 §6.1 同一类错误）。
func (m *meshLifecycle) neighborEntries() []NeighborEntry {
	m.mu.Lock()
	ids := make([]NodeID, 0, len(m.links))
	for id, link := range m.links {
		if link == nil || link.IsRelayed() {
			continue
		}
		ids = append(ids, id)
	}
	m.mu.Unlock()

	out := make([]NeighborEntry, 0, len(ids))
	for _, id := range ids {
		e := NeighborEntry{NodeID: id, RTTMS: UnknownNeighborRTTMS}
		if m.probes != nil {
			// 样本不足时 Measurement 返回 0 丢包（router.rs:49 的 LOSS_MIN_SAMPLES），
			// 不要在这里再引入「样本少就判丢包」的第二套判据。
			loss, _, rtt := m.probes.Measurement(id)
			if rtt > 0 {
				e.RTTMS = rtt
			}
			e.LossRate = QuantizeLoss(loss)
		}
		out = append(out, e)
	}
	return out
}

// refreshNeighbors 把最新邻居质量写进本地描述符（内容不变则不动 seq、不重签）。
func (m *meshLifecycle) refreshNeighbors() {
	if m.gossip == nil {
		return
	}
	changed, err := m.gossip.SetNeighbors(m.neighborEntries())
	if err != nil {
		if m.cfg.Verbose {
			log.Printf("[mesh] 邻居声明更新失败: %v", err)
		}
		return
	}
	if changed && m.cfg.Verbose {
		log.Printf("[mesh] 邻居声明已更新（%d 条）", len(m.gossip.Neighbors()))
	}
}

// routeTable 返回当前转发表；LSDB 版本变化时按需重建。
func (m *meshLifecycle) routeTable() *RouteTable {
	if m.gossip == nil {
		return nil
	}
	m.routeMu.Lock()
	defer m.routeMu.Unlock()
	v := m.gossip.Version()
	if m.routes != nil && m.routesVersion == v {
		return m.routes
	}
	m.routes = computeRouteTable(m.cfg.NodeID, m.gossip.Descriptors(), v)
	m.routesVersion = v
	m.routeRebuilds.Add(1)
	if m.cfg.Verbose {
		log.Printf("[mesh] 转发表已重建：%d 个目的（LSDB v%d）", len(m.routes.Routes), v)
	}
	return m.routes
}

// sendToPeer 把帧发给 dst：有直连链路就直接发，否则按转发表交给下一跳（多跳）。
//
// 握手的 Init/Resp 与业务数据都走这里 —— 否则 A 与 C 不直连时，A 永远发不出
// 给 C 的握手帧，多跳也就只能转控制帧、数据面依旧不通。
func (m *meshLifecycle) sendToPeer(ctx context.Context, dst NodeID, frameBytes []byte) (PeerLink, error) {
	if link := m.linkForPeer(dst); link != nil {
		return link, link.Send(ctx, frameBytes)
	}
	for _, hop := range m.forwardHops(dst, nil) {
		link := m.linkForPeer(hop)
		if link == nil {
			continue
		}
		if err := link.Send(ctx, frameBytes); err == nil {
			return link, nil
		}
	}
	return nil, fmt.Errorf("mesh: 到 %x 无可达下一跳", dst[:4])
}

// routeRebuildCount 返回转发表重建次数（诊断 / 单测）。
func (m *meshLifecycle) routeRebuildCount() uint64 { return m.routeRebuilds.Load() }
