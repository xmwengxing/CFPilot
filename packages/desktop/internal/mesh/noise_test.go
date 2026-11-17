package mesh

import (
	"bytes"
	"testing"

	"github.com/flynn/noise"
)

// TestNoiseIKpsk2RoundTrip 验证 IK+psk@2 握手在本实现内自洽：
// 发起方 msg1 → 响应方 → msg2 → 发起方，双方取得可双向通信的 CipherState。
//
// 这**不证明**与 MobiHop snow 的跨语言互通（那需要 golden 向量，契约 §9 未做），
// 但证明参数配置（IK/psk@2/ChaChaPoly/BLAKE2s/prologue）正确可用。
func TestNoiseIKpsk2RoundTrip(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "shared-secret")

	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngI, rngR := deterministicReader(1), deterministicReader(2)
	staticI, err := cs.GenerateKeypair(&rngI)
	if err != nil {
		t.Fatal(err)
	}
	staticR, err := cs.GenerateKeypair(&rngR)
	if err != nil {
		t.Fatal(err)
	}

	init, err := NewInitiatorHandshake(psk, network[:], staticI, staticR)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := NewResponderHandshake(psk, network[:], staticR)
	if err != nil {
		t.Fatal(err)
	}

	// msg1: 发起方 → 响应方
	msg1, err := init.WriteMessage([]byte("init-payload"))
	if err != nil {
		t.Fatal(err)
	}
	if len(msg1) == 0 {
		t.Fatal("msg1 为空")
	}
	gotPayload, err := resp.ReadMessage(msg1)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotPayload, []byte("init-payload")) {
		t.Errorf("响应方读到的 payload = %q", gotPayload)
	}
	if send, _ := resp.CipherStates(); send != nil {
		t.Fatal("响应方读 msg1 后不应完成握手")
	}

	// msg2: 响应方 → 发起方
	msg2, err := resp.WriteMessage([]byte("resp-payload"))
	if err != nil {
		t.Fatal(err)
	}
	gotPayload2, err := init.Complete(msg2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotPayload2, []byte("resp-payload")) {
		t.Errorf("发起方读到的 payload = %q", gotPayload2)
	}
	initSend, initRecv := init.CipherStates()
	if initSend == nil || initRecv == nil {
		t.Fatal("发起方完成握手后应有双向 CipherState")
	}
	respSend, respRecv := resp.CipherStates()
	if respSend == nil || respRecv == nil {
		t.Fatal("响应方完成握手后应有双向 CipherState")
	}

	// 用握手后的 CipherState 做双向加密往返（自洽性验证）
	ct, err := initSend.Encrypt(nil, nil, []byte("hello from initiator"))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := respRecv.Decrypt(nil, nil, ct)
	if err != nil {
		t.Fatalf("响应方解密失败: %v", err)
	}
	if !bytes.Equal(pt, []byte("hello from initiator")) {
		t.Errorf("解密结果 = %q", pt)
	}
	// 反向
	ct2, err := respSend.Encrypt(nil, nil, []byte("hello from responder"))
	if err != nil {
		t.Fatal(err)
	}
	pt2, err := initRecv.Decrypt(nil, nil, ct2)
	if err != nil {
		t.Fatalf("发起方解密失败: %v", err)
	}
	if !bytes.Equal(pt2, []byte("hello from responder")) {
		t.Errorf("反向解密结果 = %q", pt2)
	}
}

// TestNoiseWrongPSKRejects 验证 PSK 不匹配时握手失败（认证语义）。
func TestNoiseWrongPSKRejects(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk1 := DerivePSK("test-net", "secret1")
	psk2 := DerivePSK("test-net", "secret2")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngI2, rngR2 := deterministicReader(1), deterministicReader(2)
	staticI, _ := cs.GenerateKeypair(&rngI2)
	staticR, _ := cs.GenerateKeypair(&rngR2)

	init, _ := NewInitiatorHandshake(psk1, network[:], staticI, staticR)
	resp, _ := NewResponderHandshake(psk2, network[:], staticR)
	// IK 的 psk@2 在 msg2 才使用（契约 §2.2：<- e, ee, se, psk），
	// 所以 msg1 能正常读；错误要在响应方写 msg2 / 发起方读 msg2 时暴露。
	msg1, _ := init.WriteMessage(nil)
	if _, err := resp.ReadMessage(msg1); err != nil {
		t.Fatalf("msg1 不应受 PSK 影响: %v", err)
	}
	msg2, err := resp.WriteMessage(nil)
	if err != nil {
		t.Fatalf("响应方写 msg2 失败: %v", err)
	}
	if _, err := init.Complete(msg2); err == nil {
		t.Error("PSK 不匹配时发起方读 msg2 应拒绝握手")
	}
}

// deterministicReader 提供确定性随机源（仅测试用）。
type deterministicReader byte

func (r *deterministicReader) Read(p []byte) (int, error) {
	for i := range p {
		*r = *r + 1
		p[i] = byte(*r)
	}
	return len(p), nil
}
