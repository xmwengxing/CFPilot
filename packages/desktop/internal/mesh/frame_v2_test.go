package mesh

import (
	"bytes"
	"errors"
	"testing"
)

// ADR-0016 线速 v2 的 Go 侧等价测试。
//
// 对照 MobiHop：crates/mobihop-proto/tests/header.rs、header.rs:297（decode）
// 与 edge/cf-worker-relay/test/proto.test.mjs。

func v2Frame() *Frame {
	f := &Frame{
		Type:    MsgData,
		Flags:   FlagEncrypted,
		TTL:     DefaultTTL,
		Payload: []byte{1, 2, 3},
		Counter: 42,
	}
	copy(f.Src[:], []byte{1, 2, 3, 4, 5, 6, 7, 8})
	copy(f.Dst[:], []byte{8, 7, 6, 5, 4, 3, 2, 1})
	return f
}

func TestFrameDefaultVersionIsV2(t *testing.T) {
	f := sampleFrame() // Version 未设置 = 0
	buf, err := f.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if buf[1] != WireVersionV2 {
		t.Fatalf("出站默认应为 v2(0x02)，实际 %#x", buf[1])
	}
}

func TestFrameV1DowngradeForcesKeyMetaZero(t *testing.T) {
	f := v2Frame()
	f.Version = WireVersionV1
	f.KeyMeta = 0x35 // 即使设了，v1 也必须清零
	buf, err := f.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if buf[1] != WireVersionV1 {
		t.Fatalf("version = %#x, 期望 0x01", buf[1])
	}
	if buf[5] != 0 {
		t.Fatalf("v1 的 buf[5] 必须为 0（否则旧节点按 ReservedField 丢弃），实际 %#x", buf[5])
	}
	got, err := Decode(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyMeta != 0 || got.KeySlot() != 0 {
		t.Errorf("v1 解码后 key_meta 应为 0，实际 %#x slot=%d", got.KeyMeta, got.KeySlot())
	}
}

func TestFrameV2KeyMetaRoundTrip(t *testing.T) {
	f := v2Frame()
	f.Version = WireVersionV2
	f.KeyMeta = 0x35 // key_slot=3, qos_class=5
	buf, err := f.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if buf[1] != WireVersionV2 || buf[5] != 0x35 {
		t.Fatalf("version/key_meta = %#x/%#x，期望 0x02/0x35", buf[1], buf[5])
	}
	got, err := Decode(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.KeySlot() != 3 {
		t.Errorf("key_slot = %d, 期望 3", got.KeySlot())
	}
	if got.QoSClass() != 5 {
		t.Errorf("qos_class = %d, 期望 5", got.QoSClass())
	}
}

func TestAADIncludesVersionAndKeyMeta(t *testing.T) {
	base := v2Frame()
	base.Version = WireVersionV2
	base.KeyMeta = 0x10

	other := *base
	other.KeyMeta = 0x20
	if bytes.Equal(base.AADBytes(), other.AADBytes()) {
		t.Error("key_meta 变化必须改变 AAD（ADR-0016：纳入认证）")
	}

	legacy := *base
	legacy.Version = WireVersionV1
	legacy.KeyMeta = 0x10 // v1 会被清零
	if bytes.Equal(base.AADBytes(), legacy.AADBytes()) {
		t.Error("version 变化必须改变 AAD（否则中继改版本可绕过认证）")
	}

	// AAD 的 buf[5] 必须反映实际写出的 key_meta
	if got := base.AADBytes()[5]; got != 0x10 {
		t.Errorf("v2 AAD buf[5] = %#x, 期望 0x10", got)
	}
	if got := legacy.AADBytes()[5]; got != 0 {
		t.Errorf("v1 AAD buf[5] = %#x, 期望 0", got)
	}
}

func TestEncodeRejectsUnknownVersion(t *testing.T) {
	f := v2Frame()
	f.Version = 0x03
	if _, err := f.Encode(); !errors.Is(err, ErrInvalidVersion) {
		t.Errorf("未知版本应返回 ErrInvalidVersion，实际 %v", err)
	}
}

func TestDecodeAcceptsBothVersions(t *testing.T) {
	for _, v := range []byte{WireVersionV1, WireVersionV2} {
		f := v2Frame()
		f.Version = v
		buf, err := f.Encode()
		if err != nil {
			t.Fatalf("v%#x 编码失败: %v", v, err)
		}
		got, err := Decode(buf)
		if err != nil {
			t.Fatalf("v%#x 解码失败: %v", v, err)
		}
		if got.Version != v {
			t.Errorf("解码 version = %#x, 期望 %#x", got.Version, v)
		}
	}
}
