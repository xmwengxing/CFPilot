//go:build mesh

package mesh

import "testing"

// 分账必须按链路类别（K24 §6.1）：中继投递的帧不能记进直连。
func TestAccountingByLinkClass(t *testing.T) {
	m := &meshLifecycle{}
	direct := &fakeRelayLink{} // IsRelayed() = false
	relayed := &WssRoomPeer{}  // IsRelayed() = true

	m.countRX(direct)
	m.countRX(relayed)
	m.countRX(relayed)
	m.countTX(direct)
	m.countTX(relayed)

	txD, txR, rxD, rxR, _, _ := m.Accounting()
	if txD != 1 || txR != 1 || rxD != 1 || rxR != 2 {
		t.Fatalf("分账错误: txDirect=%d txRelayed=%d rxDirect=%d rxRelayed=%d", txD, txR, rxD, rxR)
	}

	st := m.Status()
	if st.TXDirect != 1 || st.TXRelayed != 1 || st.RXDirect != 1 || st.RXRelayed != 2 {
		t.Fatalf("Status 未暴露分账: %+v", st)
	}
}

// 转发分账：TTL 耗尽记丢弃，转发成功记 txForwarded 且按目标链路分类。
func TestForwardAccounting(t *testing.T) {
	m := &meshLifecycle{}
	dst := nodeID(9)
	link := &fakeRelayLink{relayed: true}
	m.links = map[NodeID]PeerLink{dst: link}

	expired := &Frame{Dst: dst, TTL: 0, Payload: []byte("x")}
	if !m.forwardTo(expired, nil) {
		t.Fatal("TTL=0 的帧应视为已处理（丢弃）")
	}
	if _, _, _, _, fwd, drop := m.Accounting(); fwd != 0 || drop != 1 {
		t.Fatalf("TTL 耗尽分账错误: forwarded=%d dropped=%d", fwd, drop)
	}

	ok := &Frame{Dst: dst, TTL: 3, Payload: []byte("x")}
	if !m.forwardTo(ok, nil) {
		t.Fatal("已知目标的帧应被转发")
	}
	if _, txR, _, _, fwd, _ := m.Accounting(); fwd != 1 || txR != 1 {
		t.Fatalf("转发分账错误: forwarded=%d txRelayed=%d", fwd, txR)
	}
}
