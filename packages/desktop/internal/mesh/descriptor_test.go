package mesh

import (
	"testing"
)

func TestDescriptorSignVerify(t *testing.T) {
	ident, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var pub [32]byte
	copy(pub[:], ident.IdentityPub)
	d := NodeDescriptor{
		NodeID:      ident.NodeID,
		IdentityPub: pub,
		TunnelPub:   [32]byte{1, 2, 3},
		VirtualIPv4: "10.97.0.1",
		Seq:         1,
	}
	if err := d.Sign(ident.IdentitySeed); err != nil {
		t.Fatal(err)
	}
	if err := d.Verify(); err != nil {
		t.Errorf("签名验证应通过: %v", err)
	}

	// 篡改字段 → 验签失败
	tampered := d
	tampered.VirtualIPv4 = "10.97.0.99"
	if err := tampered.Verify(); err == nil {
		t.Error("篡改虚拟 IP 后验签应失败")
	}
}

func TestDescriptorEncodeDecode(t *testing.T) {
	ident, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var pub [32]byte
	copy(pub[:], ident.IdentityPub)
	d := NodeDescriptor{
		NodeID: ident.NodeID, IdentityPub: pub,
		TunnelPub: [32]byte{9}, VirtualIPv4: "10.98.0.2", Seq: 3,
	}
	_ = d.Sign(ident.IdentitySeed)
	raw, err := d.Encode()
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeDescriptor(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeID != d.NodeID || got.VirtualIPv4 != d.VirtualIPv4 {
		t.Errorf("编解码往返不符: %+v", got)
	}
	if err := got.Verify(); err != nil {
		t.Errorf("解码后验签失败: %v", err)
	}
}

func TestGossipMessage(t *testing.T) {
	g := GossipMessage{Descriptors: []NodeDescriptor{{NodeID: nodeID(1), Seq: 1}}}
	raw, err := g.Encode()
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeGossip(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Descriptors) != 1 || got.Descriptors[0].Seq != 1 {
		t.Errorf("Gossip 往返不符: %+v", got)
	}
}
