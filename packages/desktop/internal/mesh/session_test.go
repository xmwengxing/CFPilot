package mesh

import (
	"bytes"
	"testing"

	"github.com/flynn/noise"
)

func TestReplayWindow(t *testing.T) {
	w := NewReplayWindow()
	// 新 counter 接受并推进
	for i := uint64(0); i < 10; i++ {
		if !w.CheckAndUpdate(i) {
			t.Errorf("counter %d 应接受", i)
		}
	}
	if w.Highest() != 9 {
		t.Errorf("highest = %d", w.Highest())
	}
	// 重复拒绝
	if w.CheckAndUpdate(5) {
		t.Error("重复 counter=5 应拒绝")
	}
	// 窗口内新 counter 接受
	if !w.CheckAndUpdate(100) {
		t.Error("counter=100 应接受")
	}
	// 窗口外旧包拒绝（100 - 2048 溢出，用 100-3000 不可能，改测 highest 很大时）
	w2 := NewReplayWindow()
	w2.CheckAndUpdate(5000)
	if w2.CheckAndUpdate(100) {
		t.Error("窗口外旧 counter=100 应拒绝")
	}
	// reset
	w2.Reset()
	if w2.Highest() != 0 {
		t.Error("reset 后 highest 应为 0")
	}
	if !w2.CheckAndUpdate(0) {
		t.Error("reset 后 counter=0 应接受")
	}
}

func testNoisePair(t *testing.T) (*noise.CipherState, *noise.CipherState) {
	t.Helper()
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngI, rngR := deterministicReader(1), deterministicReader(2)
	staticI, _ := cs.GenerateKeypair(&rngI)
	staticR, _ := cs.GenerateKeypair(&rngR)
	init, err := NewInitiatorHandshake(psk, network[:], staticI, staticR)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := NewResponderHandshake(psk, network[:], staticR)
	if err != nil {
		t.Fatal(err)
	}
	m1, _ := init.WriteMessage(nil)
	if _, err := resp.ReadMessage(m1); err != nil {
		t.Fatal(err)
	}
	m2, _ := resp.WriteMessage(nil)
	if _, err := init.Complete(m2); err != nil {
		t.Fatal(err)
	}
	return init.SendState(), resp.RecvState()
}

func TestKeyMaterialRoundTrip(t *testing.T) {
	initSend, respRecv := testNoisePair(t)
	wire, initSess, err := InitiatorKeyMaterial(initSend)
	if err != nil {
		t.Fatal(err)
	}
	respSess, err := ResponderFromKeyMaterial(respRecv, wire)
	if err != nil {
		t.Fatal(err)
	}
	// 双方 epoch 应一致（响应方直接读线上值）
	if initSess.EpochID() != respSess.EpochID() {
		t.Errorf("epoch 不符: %x vs %x", initSess.EpochID(), respSess.EpochID())
	}
	// epoch 应等于 data_key 的 BLAKE3 派生（发起方视角）——通过加解密验证一致性

	// 双向加解密
	f := sampleFrame()
	f.Type = MsgData
	f.Flags = FlagEncrypted
	aad := f.AADBytes()
	payload := []byte("e2e hello")

	counter, ct, err := initSess.Encrypt(aad, payload)
	if err != nil {
		t.Fatal(err)
	}
	if counter != 0 {
		t.Errorf("首个 counter 应为 0，实际 %d", counter)
	}
	pt, err := respSess.Decrypt(counter, aad, ct)
	if err != nil {
		t.Fatalf("响应方解密失败: %v", err)
	}
	if !bytes.Equal(pt, payload) {
		t.Errorf("解密不符: %q", pt)
	}

	// 反向
	counter2, ct2, err := respSess.Encrypt(aad, payload)
	if err != nil {
		t.Fatal(err)
	}
	pt2, err := initSess.Decrypt(counter2, aad, ct2)
	if err != nil {
		t.Fatalf("发起方解密失败: %v", err)
	}
	if !bytes.Equal(pt2, payload) {
		t.Errorf("反向解密不符: %q", pt2)
	}
}

func TestSessionReplayReject(t *testing.T) {
	initSend, respRecv := testNoisePair(t)
	wire, initSess, _ := InitiatorKeyMaterial(initSend)
	respSess, _ := ResponderFromKeyMaterial(respRecv, wire)
	aad := make([]byte, HeaderLen)

	counter, ct, _ := initSess.Encrypt(aad, []byte("data"))
	if _, err := respSess.Decrypt(counter, aad, ct); err != nil {
		t.Fatal(err)
	}
	// 重放同一 counter 应拒绝
	if _, err := respSess.Decrypt(counter, aad, ct); err == nil {
		t.Error("重放 counter 应拒绝")
	}
}

func TestSessionTamperReject(t *testing.T) {
	initSend, respRecv := testNoisePair(t)
	wire, initSess, _ := InitiatorKeyMaterial(initSend)
	respSess, _ := ResponderFromKeyMaterial(respRecv, wire)
	aad := make([]byte, HeaderLen)
	counter, ct, _ := initSess.Encrypt(aad, []byte("data"))

	// 篡改 AAD
	badAAD := append([]byte(nil), aad...)
	badAAD[20] ^= 1
	if _, err := respSess.Decrypt(counter, badAAD, ct); err == nil {
		t.Error("篡改 AAD 应拒绝")
	}
	// 篡改密文
	badCT := append([]byte(nil), ct...)
	badCT[0] ^= 1
	if _, err := respSess.Decrypt(counter, aad, badCT); err == nil {
		t.Error("篡改密文应拒绝")
	}
}

func TestSessionNeedsRekey(t *testing.T) {
	initSend, _ := testNoisePair(t)
	_, sess, err := InitiatorKeyMaterial(initSend)
	if err != nil {
		t.Fatal(err)
	}
	if sess.NeedsRekey() {
		t.Error("新会话不应立即 rekey")
	}
	// 手动推进 send_counter 到阈值
	sess.sendCounter = RekeyCounterThreshold
	if !sess.NeedsRekey() {
		t.Error("counter 达 2^32 应 rekey")
	}
}
