//go:build mesh

package mesh

// 收发分账（对齐 MobiHop K24 §6.1「中继投递的帧不算直连收」口径）。
//
// ## 为什么按「链路」而不是按「帧头 src」分类
//
// MobiHop 在 K24 里定位到一个会让面板给出错误结论的缺陷：中继腿是普通邻居，
// 中继转交的帧（以及中继自己的管理帧）在分解时命中了「直连入口」标记，
// 于是 `direct_rx` 在**物理上不可能直连**的装置上照样按 29%~72% 增长。
// 结论是 `direct_rx` 曾长期不能作为「这条流走了直连」的证据，判档改用
// 「出口侧分账 + 中继房间统计 + 防火墙规则」三条独立证据。
//
// Go 侧的对策相同 —— 分类只看**这条帧从哪条链路进来 / 往哪条链路出去**：
// `PeerLink.IsRelayed()` 为真即记「中继」，否则记「直连」。帧头 src 只代表
// 发送者，不代表投递路径（中继转发时 src 仍是原始发送方）。
//
// 分账只覆盖本机业务帧；替别人转发的帧单独记 `txForwarded`（见 forward.go），
// 避免「转发流量」把「自己的出口是不是直连」搅浑。

// isRelayedLink 报告一条链路是否经中继（WSS 房间、盲中继腿）。
// nil 视为直连：调用方本来就没有链路，不该被算成中继。
func isRelayedLink(l PeerLink) bool {
	return l != nil && l.IsRelayed()
}

// countRX 记一次「从该链路收到并解码成功」的帧。
func (m *meshLifecycle) countRX(link PeerLink) {
	if isRelayedLink(link) {
		m.rxRelayed.Add(1)
		return
	}
	m.rxDirect.Add(1)
}

// countTX 记一次「经该链路成功发出」的帧。
func (m *meshLifecycle) countTX(link PeerLink) {
	if isRelayedLink(link) {
		m.txRelayed.Add(1)
		return
	}
	m.txDirect.Add(1)
}

// Accounting 返回分账快照（直连 / 中继、转发）。
// Status 与诊断日志共用同一份口径，避免两处各算一套。
func (m *meshLifecycle) Accounting() (txDirect, txRelayed, rxDirect, rxRelayed, txForwarded, forwardDropped uint64) {
	return m.txDirect.Load(), m.txRelayed.Load(), m.rxDirect.Load(), m.rxRelayed.Load(),
		m.txForwarded.Load(), m.forwardDropped.Load()
}
