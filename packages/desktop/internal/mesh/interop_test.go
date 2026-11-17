package mesh

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/flynn/noise"
)

// noiseVector 是从 MobiHop（snow, main@1ccfdc1）导出的 IKpsk2 握手向量。
// 生成方式：MobiHop crates/mobihop-crypto/examples/export_vector.rs
type noiseVector struct {
	Pattern       string `json:"pattern"`
	InitPriv      string `json:"init_priv"`
	RespPriv      string `json:"resp_priv"`
	RespPub       string `json:"resp_pub"`
	PSK           string `json:"psk"`
	Prologue      string `json:"prologue"`
	Msg1          string `json:"msg1"`
	Msg2          string `json:"msg2"`
	HandshakeHash string `json:"handshake_hash"`
	InitPayload   string `json:"init_payload"`
	RespPayload   string `json:"resp_payload"`
}

func loadNoiseVector(t *testing.T) noiseVector {
	t.Helper()
	path := filepath.Join("testdata", "noise_ikpsk2_vector.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取握手向量失败: %v", err)
	}
	var v noiseVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("解析握手向量失败: %v", err)
	}
	return v
}

func mustHex(t *testing.T, s string, wantLen int) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex 解码失败: %v", err)
	}
	if wantLen > 0 && len(b) != wantLen {
		t.Fatalf("hex 长度 = %d, 期望 %d", len(b), wantLen)
	}
	return b
}

// vectorResponderState 用向量里的静态密钥/PSK/prologue 构造 Go 响应方状态。
func vectorResponderState(t *testing.T, v noiseVector, pskOverride []byte) *noise.HandshakeState {
	t.Helper()
	respPriv := mustHex(t, v.RespPriv, 32)
	respPub := mustHex(t, v.RespPub, 32)
	psk := pskOverride
	if psk == nil {
		psk = mustHex(t, v.PSK, 32)
	}
	prologue := mustHex(t, v.Prologue, 0)
	var pskArr [32]byte
	copy(pskArr[:], psk)
	cfg := NoiseConfig(pskArr, prologue, noise.DHKey{Private: respPriv, Public: respPub}, false)
	state, err := noise.NewHandshakeState(cfg)
	if err != nil {
		t.Fatalf("构造响应方失败: %v", err)
	}
	return state
}

// TestNoiseInteropReadRustMsg1 验证 Go（flynn/noise）能读取 Rust（snow）生成的 IKpsk2 msg1。
//
// msg1 承载 `-> e, es, s, ss`，涉及 ephemeral DH、加密静态公钥、prologue 绑定、psk@2。
// Go 能读出 payload ⇒ 两侧对 msg1 的 wire 格式理解一致。
// msg2 的互通需在真实双向握手中验证（留端到端测试）。
func TestNoiseInteropReadRustMsg1(t *testing.T) {
	v := loadNoiseVector(t)
	if v.Pattern != "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s" {
		t.Fatalf("向量模式不符: %s", v.Pattern)
	}
	msg1 := mustHex(t, v.Msg1, 0)
	state := vectorResponderState(t, v, nil)

	payload, cs1, cs2, err := state.ReadMessage(nil, msg1)
	if err != nil {
		t.Fatalf("Go 读取 Rust msg1 失败: %v — wire 格式不互通", err)
	}
	if string(payload) != v.InitPayload {
		t.Errorf("payload = %q, 期望 %q", payload, v.InitPayload)
	}
	if cs1 != nil || cs2 != nil {
		t.Error("响应方读 msg1 后不应完成握手")
	}

	// Go 响应方写 msg2（状态机可推进；msg2 互通由端到端确认）
	msg2, _, _, err := state.WriteMessage(nil, []byte(v.RespPayload))
	if err != nil {
		t.Fatalf("Go 写 msg2 失败: %v", err)
	}
	if len(msg2) == 0 {
		t.Error("Go 写出的 msg2 为空")
	}
	t.Logf("[interop] Go 读取 Rust IKpsk2 msg1 成功（%d 字节，payload=%q），写出 msg2（%d 字节）",
		len(msg1), payload, len(msg2))
}

// TestNoiseInteropMalformedMsg1 验证 Go 拒绝被篡改的 Rust msg1（AEAD 完整性）。
func TestNoiseInteropMalformedMsg1(t *testing.T) {
	v := loadNoiseVector(t)
	msg1 := mustHex(t, v.Msg1, 0)
	state := vectorResponderState(t, v, nil)
	tampered := append([]byte(nil), msg1...)
	tampered[len(tampered)-1] ^= 0x01
	if _, _, _, err := state.ReadMessage(nil, tampered); err == nil {
		t.Error("篡改的 Rust msg1 应被 Go 响应方拒绝")
	}
}

// TestNoiseInteropPSKSemantics 验证 psk@2 的生效时机与 Rust 一致：
// IK 的 msg1（-> e, es, s, ss）不携带 psk token，所以错误 PSK 不影响读 msg1；
// psk 在 msg2（<- e, ee, se, psk）才混入（契约 §2.2，snow example 注释亦同）。
//
// 这条测试同时防止有人误以为"错误 PSK 应在 msg1 就拒绝"而写错断言。
func TestNoiseInteropPSKSemantics(t *testing.T) {
	v := loadNoiseVector(t)
	msg1 := mustHex(t, v.Msg1, 0)
	state := vectorResponderState(t, v, bytes.Repeat([]byte{0xff}, 32))
	if _, _, _, err := state.ReadMessage(nil, msg1); err != nil {
		t.Errorf("msg1 不应受 psk@2 影响（psk 在 msg2 才生效）: %v", err)
	}
	// 响应方用错误 PSK 写 msg2，发起方（正确 PSK）应拒绝——这在自洽测试
	// TestNoiseWrongPSKRejects 已覆盖，此处不重复。
}
