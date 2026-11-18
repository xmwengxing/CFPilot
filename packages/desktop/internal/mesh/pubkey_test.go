package mesh

import "testing"

// TestPubKeyWireIsArray 验证 32 字节公钥 wire 为 array（对齐 Rust serde [u8;32]），
// 而非 []byte 的 bin 编码（历史坑：punch.go 的 NodeID 同理）。
func TestPubKeyWireIsArray(t *testing.T) {
	var pk PubKey
	pk[0] = 1
	raw, err := pk.MarshalMsgpack()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 1 {
		t.Fatal("空编码")
	}
	// msgpack array32 = 0xdc（32 元素 > 15，用 array32），后接 4 字节长度
	if raw[0] != 0xdc {
		t.Errorf("PubKey 应编码为 array32 (0xdc)，实际首字节 0x%02x", raw[0])
	}
	// 往返
	var got PubKey
	if err := got.UnmarshalMsgpack(raw); err != nil {
		t.Fatal(err)
	}
	if got != pk {
		t.Errorf("PubKey 往返不符")
	}
}
