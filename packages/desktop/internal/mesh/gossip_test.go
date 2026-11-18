package mesh

import "testing"

// TestGossipDiscoverVirtualIP 验证"一次链接、双向自动发现"的核心：
// A 广播描述符 → B 验签并入 LSDB → B 能查到 A 的虚拟 IP（无需 A 预配 B）。
func TestGossipDiscoverVirtualIP(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	identA, err := LoadOrCreateIdentity(dirA)
	if err != nil {
		t.Fatal(err)
	}
	identB, err := LoadOrCreateIdentity(dirB)
	if err != nil {
		t.Fatal(err)
	}

	gA, err := NewGossip(identA, "10.97.0.1")
	if err != nil {
		t.Fatal(err)
	}
	gB, err := NewGossip(identB, "10.98.0.2")
	if err != nil {
		t.Fatal(err)
	}

	// A 广播 → B 接收
	msg, err := gA.GossipMessageBytes()
	if err != nil {
		t.Fatal(err)
	}
	added, err := gB.OnGossip(msg)
	if err != nil {
		t.Fatal(err)
	}
	if len(added) != 1 {
		t.Fatalf("B 应发现 A 的描述符，实际 %d", len(added))
	}
	ip, ok := gB.LookupVirtualIP(identA.NodeID)
	if !ok || ip != "10.97.0.1" {
		t.Errorf("B 应查到 A 的虚拟 IP 10.97.0.1，实际 %q (ok=%v)", ip, ok)
	}

	// B 广播 → A 接收（双向）
	msgB, _ := gB.GossipMessageBytes()
	if _, err := gA.OnGossip(msgB); err != nil {
		t.Fatal(err)
	}
	if ip, ok := gA.LookupVirtualIP(identB.NodeID); !ok || ip != "10.98.0.2" {
		t.Errorf("A 应查到 B 的虚拟 IP，实际 %q", ip)
	}
}

// TestGossipRejectsTampered 验证篡改的描述符被拒绝（伪造防护）。
func TestGossipRejectsTampered(t *testing.T) {
	ident, _ := LoadOrCreateIdentity(t.TempDir())
	g, _ := NewGossip(ident, "10.97.0.1")
	raw, _ := g.GossipMessageBytes()
	// 篡改载荷（改一个字节）→ 解码或验签失败，不应入 LSDB
	raw[len(raw)-1] ^= 0xff
	added, _ := g2OnGossipTampered(t, ident, raw)
	if len(added) != 0 {
		t.Errorf("篡改的描述符不应被接受，实际 %d", len(added))
	}
}

func g2OnGossipTampered(t *testing.T, ident *Identity, raw []byte) ([]NodeDescriptor, error) {
	g2, err := NewGossip(ident, "10.99.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return g2.OnGossip(raw)
}
