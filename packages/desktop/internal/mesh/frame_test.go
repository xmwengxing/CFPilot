package mesh

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

func sampleFrame() *Frame {
	f := &Frame{
		Type:    MsgData,
		Flags:   FlagEncrypted | FlagAckReq,
		TTL:     16,
		Payload: []byte{0xde, 0xad, 0xbe, 0xef},
		Counter: 0x0102030405060708,
	}
	copy(f.Src[:], []byte{1, 2, 3, 4, 5, 6, 7, 8})
	copy(f.Dst[:], []byte{9, 10, 11, 12, 13, 14, 15, 16})
	return f
}

func TestFrameRoundTrip(t *testing.T) {
	f := sampleFrame()
	buf, err := f.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if len(buf) != HeaderLen+len(f.Payload) {
		t.Fatalf("长度 = %d, 期望 %d", len(buf), HeaderLen+len(f.Payload))
	}
	// 逐字段核对线上字节（ADR-0016：出站默认 v2）
	if buf[0] != 0x4D || buf[1] != WireVersionV2 || buf[2] != byte(MsgData) {
		t.Errorf("头字节错误: % x", buf[:3])
	}
	if buf[3] != (FlagEncrypted|FlagAckReq) || buf[4] != 16 || buf[5] != 0 {
		t.Errorf("flags/ttl/reserved 错误: % x", buf[3:6])
	}
	if got := binary.BigEndian.Uint16(buf[6:8]); got != 4 {
		t.Errorf("payload_len = %d, 期望 4", got)
	}
	if !bytes.Equal(buf[8:16], f.Src[:]) || !bytes.Equal(buf[16:24], f.Dst[:]) {
		t.Error("src/dst 字节不符")
	}
	if got := binary.BigEndian.Uint64(buf[24:32]); got != f.Counter {
		t.Errorf("counter = %x, 期望 %x", got, f.Counter)
	}
	if !bytes.Equal(buf[32:], f.Payload) {
		t.Errorf("载荷不符: % x", buf[32:])
	}

	got, err := Decode(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != f.Type || got.Flags != f.Flags || got.TTL != f.TTL || got.Counter != f.Counter {
		t.Errorf("解码字段不符: %+v", got)
	}
	if !bytes.Equal(got.Payload, f.Payload) || got.Src != f.Src || got.Dst != f.Dst {
		t.Error("解码载荷/地址不符")
	}
}

func TestDecodeErrors(t *testing.T) {
	valid, _ := sampleFrame().Encode()
	tests := []struct {
		name string
		buf  []byte
		want error
	}{
		{"truncated header", valid[:10], ErrTruncated},
		{"bad magic", withByte(valid, 0, 0x00), ErrInvalidMagic},
		// 0x02 现在是合法版本；未知版本仍必须拒
		{"bad version", withByte(valid, 1, 0x03), ErrInvalidVersion},
		{"bad type", withByte(valid, 2, 0x09), ErrInvalidType},
		{"reserved flags", withByte(valid, 3, 0x08), ErrInvalidFlags},
		{"ttl over range", withByte(valid, 4, 65), ErrTtlOutOfRange},
		// v1 的 buf[5] 必须为 0；v2 任意 key_meta 都合法
		{"reserved field", withByte(withByte(valid, 1, WireVersionV1), 5, 0x01), ErrReservedField},
		{"oversized", withU16(valid, 6, 1401), ErrOversized},
		{"truncated payload", valid[:HeaderLen+2], ErrTruncated},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Decode(tc.buf)
			if !errors.Is(err, tc.want) {
				t.Errorf("Decode err = %v, 期望包含 %v", err, tc.want)
			}
		})
	}
}

func TestAADNormalization(t *testing.T) {
	// AAD：ttl 置 0、清 RELAYED；其余字段原样
	f := sampleFrame()
	f.Flags = FlagEncrypted | FlagRelayed | FlagAckReq
	f.TTL = 16
	aad := f.AADBytes()
	if len(aad) != HeaderLen {
		t.Fatalf("AAD 长度 = %d", len(aad))
	}
	if aad[4] != 0 {
		t.Errorf("AAD ttl 应为 0，实际 %d", aad[4])
	}
	if aad[3] != (FlagEncrypted | FlagAckReq) {
		t.Errorf("AAD flags 应清除 RELAYED：%#x", aad[3])
	}
	// 其余字段与帧一致
	if aad[0] != MagicByte || aad[1] != f.WireVersion() || aad[2] != byte(f.Type) {
		t.Error("AAD magic/version/type 应与帧一致")
	}
	if !bytes.Equal(aad[8:16], f.Src[:]) || !bytes.Equal(aad[16:24], f.Dst[:]) {
		t.Error("AAD src/dst 应与帧一致")
	}
	if got := binary.BigEndian.Uint64(aad[24:32]); got != f.Counter {
		t.Errorf("AAD counter 不符")
	}

	// 中继跳变化（TTL-1 + 置 RELAYED）不得改变 AAD
	plain := sampleFrame()
	plain.Flags = FlagEncrypted | FlagAckReq // 无 RELAYED
	plain.TTL = 16
	relayed := *plain
	relayed.TTL = plain.TTL - 1
	relayed.Flags = plain.Flags | FlagRelayed // 逐跳置 RELAYED
	if !bytes.Equal(plain.AADBytes(), relayed.AADBytes()) {
		t.Error("TTL/RELAYED 变化不应影响 AAD")
	}
}

// TestAllMsgTypes 验证类型全集与 e2e 路由判定（契约 §1.2）
func TestAllMsgTypes(t *testing.T) {
	e2e := map[MsgType]bool{
		MsgHandshake: true, MsgGossip: false, MsgPing: false, MsgData: true,
		MsgHolePunch: true, MsgRelayMgmt: true, MsgAgentRpc: true, MsgUdpProbe: false,
	}
	for typ, want := range e2e {
		if got := typ.IsE2ERouted(); got != want {
			t.Errorf("type %#x IsE2ERouted = %v, 期望 %v", typ, got, want)
		}
		f := &Frame{Type: typ, TTL: DefaultTTL}
		buf, err := f.Encode()
		if err != nil {
			t.Errorf("type %#x 编码失败: %v", typ, err)
			continue
		}
		if _, err := Decode(buf); err != nil {
			t.Errorf("type %#x 解码失败: %v", typ, err)
		}
	}
}

// helper: 复制并改一个字节
func withByte(b []byte, i int, v byte) []byte {
	out := append([]byte(nil), b...)
	out[i] = v
	return out
}

func withU16(b []byte, i int, v uint16) []byte {
	out := append([]byte(nil), b...)
	binary.BigEndian.PutUint16(out[i:i+2], v)
	return out
}
