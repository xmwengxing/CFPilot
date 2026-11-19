//go:build mesh

package mesh

import (
	"context"
	"log"
)

// 节点转发（P4 前置）：把「目标不是本机」的帧按 32B 头的 dst 转发给已知链路。
//
// 对齐 MobiHop Router 的中继语义：
//   - TTL 每跳递减，降到 0 丢弃；置 RELAYED 位（不参与 E2E AAD，加密帧不受影响）；
//   - version / key_meta 原样保留（中继改它们会让接收侧 AEAD 失败）；
//   - 广播帧（dst=全 FF）向除来源外的所有链路扇出，同时**本地也继续处理**；
//   - 单播帧目标未知 → 返回 false，让调用方按原逻辑处理（通常是忽略）。
//
// 用途：打洞信令可以在没有直连时经一个双方都可达的节点中转（不需要盲中继）。
// 注意：这是**最小转发**，不做路由表/多跳寻路（MobiHop 的 Dijkstra 仍待对齐）。

// broadcastNodeID 是广播 NodeID（全 0xFF）。
func broadcastNodeID() NodeID {
	var id NodeID
	for i := range id {
		id[i] = 0xff
	}
	return id
}

// forwardTo 尝试把单播帧转发给 dst；返回 true 表示「已处理（转发或按规则丢弃）」，
// 调用方不应再把该帧当成本机流量。
func (m *meshLifecycle) forwardTo(parsed *Frame, from PeerLink) bool {
	m.mu.Lock()
	dstLink, ok := m.links[parsed.Dst]
	m.mu.Unlock()
	if !ok {
		return false // 不认识目标：交回调用方（等同忽略）
	}
	if parsed.TTL == 0 {
		m.txDropped.Add(1)
		return true
	}
	f := *parsed
	f.TTL = parsed.TTL - 1
	f.Flags = parsed.Flags | FlagRelayed
	raw, err := f.Encode()
	if err != nil {
		m.txDropped.Add(1)
		return true
	}
	// 不要原路回发给来源链路（避免 ping-pong）
	if dstLink != from {
		if err := dstLink.Send(context.Background(), raw); err == nil {
			m.txFrames.Add(1)
		}
	}
	return true
}

// forwardBroadcast 把广播帧扇出到除来源外的所有链路；本地仍继续处理该帧。
func (m *meshLifecycle) forwardBroadcast(parsed *Frame, from PeerLink) {
	if parsed.TTL == 0 {
		return
	}
	f := *parsed
	f.TTL = parsed.TTL - 1
	f.Flags = parsed.Flags | FlagRelayed
	raw, err := f.Encode()
	if err != nil {
		return
	}
	m.mu.Lock()
	links := make([]PeerLink, 0, len(m.links))
	for _, l := range m.links {
		if l != from {
			links = append(links, l)
		}
	}
	m.mu.Unlock()
	for _, l := range links {
		if err := l.Send(context.Background(), raw); err != nil && m.cfg.Verbose {
			log.Printf("[mesh] 广播转发失败: %v", err)
		}
	}
}
