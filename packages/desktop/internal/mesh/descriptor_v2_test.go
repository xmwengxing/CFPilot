package mesh

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

// H1-4 sig_version=2 与 ADR-0016 的 Go 侧等价测试。
//
// 关键性质：v2 验签必须基于**线上原始载荷**（删 signature 后按原顺序重编码），
// 因此这里刻意构造「字段顺序不同 + 含 Go 结构体没有的未知字段」的原始 map。

func buildRawDescriptor(t *testing.T, id *Identity, extra map[string]any) []byte {
	t.Helper()
	keys := []string{
		"seq", // 故意把 seq 放在前面（与结构体顺序不同）
		"node_id",
		"identity_pubkey",
		"tunnel_pubkey",
		"virtual_ipv4",
		"neighbors",
		"sig_version",
	}
	for k := range extra {
		keys = append(keys, k)
	}

	nid := mustMarshal(t, id.NodeID)
	ipub := mustMarshal(t, toPubKey(id.IdentityPub))
	tpub := mustMarshal(t, toPubKey(id.TunnelPub))

	values := map[string][]byte{
		"seq":             mustMarshal(t, uint64(9)),
		"node_id":         nid,
		"identity_pubkey": ipub,
		"tunnel_pubkey":   tpub,
		"virtual_ipv4":    mustMarshal(t, "10.0.0.2"),
		"neighbors": mustMarshal(t, []NeighborEntry{
			{NodeID: id.NodeID, RTTMS: 42, LossRate: 0.25},
		}),
		"sig_version": mustMarshal(t, uint8(2)),
	}
	for k, v := range extra {
		values[k] = mustMarshal(t, v)
	}

	out := []byte{byte(0x80 | len(keys))} // fixmap
	for _, k := range keys {
		out = append(out, mustMarshal(t, k)...)
		out = append(out, values[k]...)
	}
	return out
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := msgpack.Marshal(v)
	if err != nil {
		t.Fatalf("msgpack 编码失败: %v", err)
	}
	return b
}

func TestDescriptorV2VerifiesRawWithUnknownFields(t *testing.T) {
	ident, err := IdentityFromSeeds([32]byte{1, 2, 3, 4}, [32]byte{5, 6, 7, 8})
	if err != nil {
		t.Fatal(err)
	}

	// 含 MobiHop 结构体里有、但 Go 精简结构体没有的字段
	raw := buildRawDescriptor(t, ident, map[string]any{
		"alias":   "mobi-node",
		"subnets": []string{"192.168.0.0/24"},
	})

	// 按 v2 规则算签名基线并签名
	stripped, err := StripSignedKeys(raw)
	if err != nil {
		t.Fatalf("StripSignedKeys: %v", err)
	}
	sig := signEd25519(ident.IdentitySeed, stripped)

	// 把 signature 追加到原始 map 末尾，并把 map 头计数 +1
	n := int(raw[0] & 0x0f)
	if n+1 > 15 {
		t.Fatal("测试用 map 过大")
	}
	next := append([]byte{byte(0x80 | (n + 1))}, raw[1:]...)
	next = append(next, mustMarshal(t, "signature")...)
	next = append(next, mustMarshal(t, sig)...)

	d, err := DecodeDescriptor(next)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if err := d.Verify(); err != nil {
		t.Fatalf("v2 验签应通过（未知字段与字段顺序都不能影响）：%v", err)
	}
}

func TestDescriptorV2RejectsTamperedUnknownField(t *testing.T) {
	ident, _ := IdentityFromSeeds([32]byte{9, 8, 7, 6}, [32]byte{5, 4, 3, 2})
	raw := buildRawDescriptor(t, ident, map[string]any{"alias": "mobi-node"})
	stripped, _ := StripSignedKeys(raw)
	sig := signEd25519(ident.IdentitySeed, stripped)

	n := int(raw[0] & 0x0f)
	next := append([]byte{byte(0x80 | (n + 1))}, raw[1:]...)
	next = append(next, mustMarshal(t, "signature")...)
	next = append(next, mustMarshal(t, sig)...)

	// 篡改未知字段的值（把 alias 的最后一个字节改掉），签名必须失效
	for i := len(next) - 1; i >= 0; i-- {
		if bytes.Equal(next[i:i+1], []byte("m")) { // "mobi-node" 的首字母
			next[i] = 'X'
			break
		}
	}
	d, err := DecodeDescriptor(next)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if err := d.Verify(); err == nil {
		t.Fatal("篡改未知字段后验签仍通过 —— v2 基线没覆盖原始字节")
	}
}

func TestStripSignedKeysPreservesOrder(t *testing.T) {
	ident, _ := IdentityFromSeeds([32]byte{1, 1, 1, 1}, [32]byte{2, 2, 2, 2})
	raw := buildRawDescriptor(t, ident, map[string]any{"alias": "a"})

	out, err := StripSignedKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	// 删除的是不存在的键：内容必须与原始 map 的键值对逐字节一致（只换头计数）
	if len(raw) < 2 || len(out) < 2 {
		t.Fatal("长度异常")
	}
	inPairs := int(raw[0] & 0x0f)
	outPairs := int(out[0] & 0x0f)
	if inPairs != outPairs {
		t.Errorf("未删除任何键时对数应不变: %d -> %d", inPairs, outPairs)
	}
	if !bytes.Equal(raw[1:], out[1:]) {
		t.Error("重编码必须保留原始键值对顺序与字节")
	}
}

func TestDescriptorV1StillVerifies(t *testing.T) {
	ident, _ := IdentityFromSeeds([32]byte{4, 4, 4, 4}, [32]byte{5, 5, 5, 5})
	desc := &NodeDescriptor{
		NodeID:      ident.NodeID,
		IdentityPub: toPubKey(ident.IdentityPub),
		TunnelPub:   toPubKey(ident.TunnelPub),
		VirtualIPv4: "10.0.0.9",
		Neighbors:   []NeighborEntry{},
		Seq:         3,
		// SigVersion 省略 = v1 基线
	}
	v1Bytes, err := desc.signingBytesV1()
	if err != nil {
		t.Fatal(err)
	}
	desc.Signature = signEd25519(ident.IdentitySeed, v1Bytes)
	if err := desc.Verify(); err != nil {
		t.Fatalf("v1 描述符应仍可通过验签：%v", err)
	}
}

func TestGossipDecodeKeepsRawForV2(t *testing.T) {
	ident, _ := IdentityFromSeeds([32]byte{7, 7, 7, 7}, [32]byte{8, 8, 8, 8})
	desc := &NodeDescriptor{
		NodeID:      ident.NodeID,
		IdentityPub: toPubKey(ident.IdentityPub),
		TunnelPub:   toPubKey(ident.TunnelPub),
		VirtualIPv4: "10.0.0.7",
		Neighbors:   []NeighborEntry{},
		Seq:         1,
	}
	if err := desc.Sign(ident.IdentitySeed); err != nil {
		t.Fatal(err)
	}
	msg := GossipMessage{Descriptors: []NodeDescriptor{*desc}}
	payload, err := msg.Encode()
	if err != nil {
		t.Fatal(err)
	}

	got, err := DecodeGossip(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Descriptors) != 1 {
		t.Fatalf("描述符数量 = %d", len(got.Descriptors))
	}
	if err := got.Descriptors[0].Verify(); err != nil {
		t.Fatalf("经 Gossip 往返后 v2 验签失败（raw 未保留？）：%v", err)
	}
}

func toPubKey(b []byte) PubKey {
	var p PubKey
	copy(p[:], b)
	return p
}

func signEd25519(seed [32]byte, msg []byte) []byte {
	priv := ed25519.NewKeyFromSeed(seed[:])
	return ed25519.Sign(priv, msg)
}


