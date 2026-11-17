package mesh

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/flynn/noise"
	"github.com/zeebo/blake3"
)

func TestDeriveNetworkIDDeterministic(t *testing.T) {
	a := DeriveNetworkID("mobi-net")
	b := DeriveNetworkID("mobi-net")
	if a != b {
		t.Error("相同网络名应得到相同 network_id")
	}
	c := DeriveNetworkID("other-net")
	if a == c {
		t.Error("不同网络名应得到不同 network_id")
	}
}

func TestDerivePSKStructure(t *testing.T) {
	// PSK 派生确定性 + 依赖于两个输入
	a := DerivePSK("mobi-net", "secret1")
	b := DerivePSK("mobi-net", "secret1")
	if a != b {
		t.Error("相同输入应得到相同 PSK")
	}
	if a == DerivePSK("mobi-net", "secret2") {
		t.Error("不同 secret 应得到不同 PSK")
	}
	if a == DerivePSK("other-net", "secret1") {
		t.Error("不同网络名应得到不同 PSK")
	}
}

func TestDeriveEpochIDFromDataKey(t *testing.T) {
	// epoch_id = BLAKE3(data_key)[0..4] 大端（契约 §3.3）
	var dataKey [32]byte
	for i := range dataKey {
		dataKey[i] = byte(i)
	}
	epoch := DeriveEpochID(dataKey)
	// 与直接 BLAKE3 比对
	hash := blake3sum(dataKey[:])
	expect := binary.BigEndian.Uint32(hash[:4])
	if epoch != expect {
		t.Errorf("DeriveEpochID = %x, 期望 %x", epoch, expect)
	}
	// 不同 data_key 应得到不同 epoch（统计意义上）
	var other [32]byte
	other[0] = 1
	if DeriveEpochID(other) == epoch && other != dataKey {
		// 极小概率碰撞，但这里两个 key 只差一字节，不应相等
		t.Error("不同 data_key 不应得到相同 epoch")
	}
}

func TestDeriveDirectionalKeys(t *testing.T) {
	var dataKey [32]byte
	copy(dataKey[:], []byte("0123456789abcdef0123456789abcdef"))
	i2r := DeriveDirectionalKey(dataKey, DirKeyI2R)
	r2i := DeriveDirectionalKey(dataKey, DirKeyR2I)
	if i2r == r2i {
		t.Error("两个方向密钥应不同")
	}
	if i2r != DeriveDirectionalKey(dataKey, DirKeyI2R) {
		t.Error("方向密钥派生应确定性")
	}
}

func TestDeriveRoomTag(t *testing.T) {
	psk := DerivePSK("mobi-net", "secret")
	tag := DeriveRoomTag(psk)
	if tag == [8]byte{} {
		t.Error("room_tag 不应全零")
	}
	if tag != DeriveRoomTag(psk) {
		t.Error("room_tag 派生应确定性")
	}
}

func TestBuildNonceLayout(t *testing.T) {
	// nonce = epoch(4B BE) || counter(8B BE)（契约 §3，aead.rs:26-30）
	nonce := BuildNonce(0x01020304, 0x05060708090a0b0c)
	want := []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	if !bytes.Equal(nonce[:], want) {
		t.Errorf("nonce = % x, 期望 % x", nonce, want)
	}
}

func TestAEADRoundTripAndAADBinding(t *testing.T) {
	var dataKey [32]byte
	copy(dataKey[:], []byte("test-data-key-32-bytes!!!!!"))
	key := DeriveDirectionalKey(dataKey, DirKeyI2R)
	aead, err := NewAEAD(key)
	if err != nil {
		t.Fatal(err)
	}
	if aead.NonceSize() != NonceLen || aead.Overhead() != TagLen {
		t.Errorf("AEAD nonce/tag 长度 = %d/%d, 期望 %d/%d",
			aead.NonceSize(), aead.Overhead(), NonceLen, TagLen)
	}

	f := sampleFrame()
	f.Flags = FlagEncrypted
	nonce := BuildNonce(0x11223344, f.Counter)
	aad := f.AADBytes()
	plaintext := []byte("hello mesh")

	ct := Seal(aead, nonce, aad, plaintext)
	if len(ct) != len(plaintext)+TagLen {
		t.Fatalf("密文长度 = %d, 期望 %d", len(ct), len(plaintext)+TagLen)
	}
	pt, err := Open(aead, nonce, aad, ct)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pt, plaintext) {
		t.Errorf("解密结果不符: %q", pt)
	}

	// AAD 篡改（改 dst）必须认证失败
	badAAD := append([]byte(nil), aad...)
	badAAD[20] ^= 0xff
	if _, err := Open(aead, nonce, badAAD, ct); err == nil {
		t.Error("篡改 AAD 应导致认证失败")
	}
	// 密文篡改必须失败
	badCT := append([]byte(nil), ct...)
	badCT[0] ^= 0xff
	if _, err := Open(aead, nonce, aad, badCT); err == nil {
		t.Error("篡改密文应导致认证失败")
	}
	// nonce（counter）不符必须失败
	badNonce := BuildNonce(0x11223344, f.Counter+1)
	if _, err := Open(aead, badNonce, aad, ct); err == nil {
		t.Error("错误 counter 应导致认证失败")
	}
}

// TestAEADRelayInvariance 验证中继跳不会破坏 E2E 解密：
// 源帧 AAD 与经过中继（TTL-1 + RELAYED）后的 AAD 相同。
func TestAEADRelayInvariance(t *testing.T) {
	f := sampleFrame()
	f.Flags = FlagEncrypted
	var dataKey [32]byte
	copy(dataKey[:], []byte("relay-invariance-key-32-bytes"))
	aead, _ := NewAEAD(DeriveDirectionalKey(dataKey, DirKeyI2R))
	nonce := BuildNonce(7, f.Counter)
	ct := Seal(aead, nonce, f.AADBytes(), f.Payload)

	relayed := *f
	relayed.TTL = f.TTL - 1
	relayed.Flags |= FlagRelayed
	pt, err := Open(aead, nonce, relayed.AADBytes(), ct)
	if err != nil {
		t.Fatalf("中继后 AAD 解密失败: %v", err)
	}
	if !bytes.Equal(pt, f.Payload) {
		t.Error("中继后解密载荷不符")
	}
}

func TestNoiseConfigAlignment(t *testing.T) {
	// 验证 Noise 配置参数与契约 §2 对齐（不验证握手互通——需 MobiHop golden 向量）
	psk := DerivePSK("mobi-net", "secret")
	networkID := DeriveNetworkID("mobi-net")
	prologue := networkID[:]
	cfg := NoiseConfig(psk, prologue, noise.DHKey{}, true)
	if cfg.PresharedKeyPlacement != PskIndex {
		t.Errorf("PSK placement = %d, 期望 %d", cfg.PresharedKeyPlacement, PskIndex)
	}
	if !bytes.Equal(cfg.PresharedKey, psk[:]) {
		t.Error("PSK 未正确设置")
	}
	if !bytes.Equal(cfg.Prologue, prologue) {
		t.Error("prologue 未正确设置")
	}
	if !cfg.Initiator {
		t.Error("initiator 标志未设置")
	}
}

// 测试辅助：直接算 BLAKE3（避免重复导入路径）
func blake3sum(data []byte) [32]byte {
	h := blake3.New()
	_, _ = h.Write(data)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
