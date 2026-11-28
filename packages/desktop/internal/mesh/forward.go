//go:build mesh

package mesh

import (
	"context"
	"log"
)

// forwardTo 尝试把单播帧转发给 dst；返回 true 表示「已处理（转发或按规则丢弃）」，
// 返回 false 表示本机不认识这个目标（交回调用方）。
//
// W2：下一跳不再要求 dst 是直连邻居 —— 先看直连（LSDB 还没收敛时也要能转发），
// 再看转发表的主/备下一跳；主跳发送失败自动退到备跳（H3-1 的水平分割备路）。
// 帧的 src/dst/载荷一律不改（改了 AEAD 就失败），只动 TTL 与 RELAYED 位。
func (m *meshLifecycle) forwardTo(parsed *Frame, from PeerLink) bool {
	hops := m.forwardHops(parsed.Dst, from)
	if len(hops) == 0 {
		m.drops.noRoute.Add(1)
		return false
	}
	if parsed.TTL == 0 {
		m.txDropped.Add(1)
		m.forwardDropped.Add(1)
		m.drops.ttl.Add(1)
		return true
	}
	f := *parsed
	f.TTL--
	f.Flags |= FlagRelayed
	raw, err := f.Encode()
	if err != nil {
		m.txDropped.Add(1)
		m.forwardDropped.Add(1)
		m.drops.encode.Add(1)
		return true
	}
	for _, hop := range hops {
		link := m.linkForPeer(hop)
		// 不要原路回发给来源链路（避免 ping-pong）；主跳恰好是来源时让备跳顶上。
		if link == nil || link == from {
			continue
		}
		if err := link.Send(context.Background(), raw); err == nil {
			m.txFrames.Add(1)
			m.countTX(link)
			m.txForwarded.Add(1)
			return true
		}
	}
	m.forwardDropped.Add(1)
	m.drops.sendFail.Add(1)
	return true
}

// forwardHops 给出按优先级排列的下一跳：直连目的地优先，其次转发表。
func (m *meshLifecycle) forwardHops(dst NodeID, from PeerLink) []NodeID {
	if link := m.linkForPeer(dst); link != nil && link != from {
		return []NodeID{dst}
	}
	tbl := m.routeTable()
	if tbl == nil {
		return nil
	}
	out := make([]NodeID, 0, 2)
	for _, hop := range tbl.NextHops(dst, NodeID{}) {
		if link := m.linkForPeer(hop); link == nil || link == from {
			continue
		}
		out = append(out, hop)
	}
	return out
}

// broadcastNodeID 返回全 0xff 的广播 NodeID。
func broadcastNodeID() NodeID {
	var b NodeID
	for i := range b {
		b[i] = 0xff
	}
	return b
}

// forwardBroadcast 把广播帧扇出到除来源外的所有链路；本地仍继续处理该帧。
//
// ⚠️ 接收循环**不调用**它：Gossip 用「全量 LSDB 反熵」（每个节点只跟直连对端交换），
// 泛洪会让每 5s 一轮的 Gossip 变成 O(n²) 消息并需要额外的去重状态。
// 保留给「必须全网扩散」的控制信令（目前没有），改动前先确认不会形成风暴。
func (m *meshLifecycle) forwardBroadcast(parsed *Frame, from PeerLink) {
	if parsed.TTL == 0 {
		m.forwardDropped.Add(1)
		m.drops.ttl.Add(1)
		return
	}
	f := *parsed
	f.TTL--
	f.Flags |= FlagRelayed
	raw, err := f.Encode()
	if err != nil {
		m.forwardDropped.Add(1)
		m.drops.encode.Add(1)
		return
	}
	m.mu.Lock()
	links := make([]PeerLink, 0, len(m.links))
	for _, l := range m.links {
		if l != nil && l != from {
			links = append(links, l)
		}
	}
	m.mu.Unlock()
	for _, l := range links {
		if err := l.Send(context.Background(), raw); err == nil {
			m.countTX(l)
			m.txForwarded.Add(1)
		} else if m.cfg.Verbose {
			log.Printf("[mesh] 广播转发失败: %v", err)
		}
	}
}
