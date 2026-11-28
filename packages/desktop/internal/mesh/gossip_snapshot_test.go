//go:build mesh

package mesh

import "testing"

// 反熵（W2）：Gossip 载荷除本机描述符外还带已知描述符；
// 超出字节预算时按「本地优先」截断，本机描述符永远在。
func TestGossipSnapshotCarriesKnownPeers(t *testing.T) {
	identA, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	identB, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gA, err := NewGossip(identA, "10.97.0.1")
	if err != nil {
		t.Fatal(err)
	}
	gB, err := NewGossip(identB, "10.97.0.2")
	if err != nil {
		t.Fatal(err)
	}
	msgB, err := gB.SnapshotBytes(0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gA.OnGossip(msgB); err != nil {
		t.Fatal(err)
	}

	raw, err := gA.SnapshotBytes(0)
	if err != nil {
		t.Fatal(err)
	}
	dec, err := DecodeGossip(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(dec.Descriptors) != 2 {
		t.Fatalf("快照应含本机 + 已知各一条，实际 %d", len(dec.Descriptors))
	}
	if dec.Descriptors[0].NodeID != identA.NodeID {
		t.Error("本机描述符应排在首位")
	}

	// 预算刚好只够本机：不允许整条消息超预算，也不允许把自己的描述符挤掉。
	localOnly, err := (&GossipMessage{Descriptors: []NodeDescriptor{gA.localDesc}}).Encode()
	if err != nil {
		t.Fatal(err)
	}
	tight, err := gA.SnapshotBytes(len(localOnly))
	if err != nil {
		t.Fatal(err)
	}
	if len(tight) > len(localOnly) {
		t.Errorf("紧凑快照 %d 字节超预算 %d", len(tight), len(localOnly))
	}
	decTight, err := DecodeGossip(tight)
	if err != nil {
		t.Fatal(err)
	}
	if len(decTight.Descriptors) != 1 || decTight.Descriptors[0].NodeID != identA.NodeID {
		t.Errorf("预算紧张时应只发本机描述符，实际 %d 条", len(decTight.Descriptors))
	}
}

// 邻居声明写入描述符并自增 seq；同一份声明重复写入不重签。
func TestGossipSetNeighbors(t *testing.T) {
	ident, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g, err := NewGossip(ident, "10.97.0.1")
	if err != nil {
		t.Fatal(err)
	}
	n := []NeighborEntry{{NodeID: nid(9), RTTMS: 20, LossRate: 0.123}}
	changed, err := g.SetNeighbors(n)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("首次声明应生效")
	}
	got := g.Neighbors()
	if len(got) != 1 || got[0].LossRate != 0.12 {
		t.Fatalf("邻居声明 = %+v, 期望丢包量化到 0.12", got)
	}
	if d := g.Descriptors()[ident.NodeID]; len(d.Neighbors) != 1 {
		t.Error("邻居声明必须体现在本地描述符里（对端要据此算边权）")
	}

	v := g.Version()
	again, err := g.SetNeighbors(n)
	if err != nil {
		t.Fatal(err)
	}
	if again || g.Version() != v {
		t.Errorf("重复声明不应重签/改版本: changed=%v version=%d/%d", again, g.Version(), v)
	}
}
