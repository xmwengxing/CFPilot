package mesh

import (
	"bytes"
	"testing"

	"github.com/flynn/noise"
)

// TestHandshakeFSMFullFlow 验证两个 FSM 经内存链路完成三帧握手并建立会话。
// 这是「UDP 握手」的核心逻辑验证（传输层由 sendFn 注入，此处用内存 channel 模拟）。
func TestHandshakeFSMFullFlow(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngA, rngB := deterministicReader(1), deterministicReader(2)
	staticA, _ := cs.GenerateKeypair(&rngA)
	staticB, _ := cs.GenerateKeypair(&rngB)

	idA, idB := nodeID(1), nodeID(2) // A 小 → 发起方
	var fsmA, fsmB *HandshakeFSM

	// A 的 sendFn → 投递给 B 的 OnFrame
	fsmA = NewHandshakeFSM(idA, network, psk, staticA)
	fsmA.SetSendFn(func(dst NodeID, frame []byte) error {
		if dst != idB {
			t.Errorf("A 发往错误对端 %x", dst[:4])
		}
		_, err := fsmB.OnFrame(frame)
		return err
	})
	// B 的 sendFn → 投递给 A 的 OnFrame
	fsmB = NewHandshakeFSM(idB, network, psk, staticB)
	fsmB.SetSendFn(func(dst NodeID, frame []byte) error {
		if dst != idA {
			t.Errorf("B 发往错误对端 %x", dst[:4])
		}
		_, err := fsmA.OnFrame(frame)
		return err
	})

	// A 发起（B 的静态公钥预知）
	if err := fsmA.StartOutbound(idB, staticB.Public); err != nil {
		t.Fatal(err)
	}

	// 验证双方都建立会话
	sessA, okA := fsmA.Session(idB)
	sessB, okB := fsmB.Session(idA)
	if !okA || !okB {
		t.Fatalf("会话未建立: A=%v B=%v (stateA=%s stateB=%s)", okA, okB, fsmA.State(idB), fsmB.State(idA))
	}
	if sessA.EpochID() != sessB.EpochID() {
		t.Errorf("epoch 不符: %x vs %x", sessA.EpochID(), sessB.EpochID())
	}

	// 会话加解密往返（A → B）
	packet := v4Packet([4]byte{10, 0, 0, 1}, [4]byte{10, 0, 0, 2})
	frameBytes, err := Encapsulate(packet, idA, idB, sessA)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decapsulate(frameBytes, idB, sessB)
	if err != nil {
		t.Fatalf("B 解封失败: %v", err)
	}
	if !bytes.Equal(got, packet) {
		t.Errorf("数据不符")
	}
}

// TestHandshakeFSMSymmetryRule 验证破对称：小 NodeId 保留发起方。
func TestHandshakeFSMSymmetryRule(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngA, rngB := deterministicReader(1), deterministicReader(2)
	staticA, _ := cs.GenerateKeypair(&rngA)
	staticB, _ := cs.GenerateKeypair(&rngB)
	idA, idB := nodeID(1), nodeID(2)

	fsmA := NewHandshakeFSM(idA, network, psk, staticA)
	fsmB := NewHandshakeFSM(idB, network, psk, staticB)
	if !fsmA.IsInitiator(idB) {
		t.Error("小 NodeId A 应是发起方")
	}
	if fsmB.IsInitiator(idA) {
		t.Error("大 NodeId B 不应是发起方")
	}
	// B 不应主动发起
	if err := fsmB.StartOutbound(idA, staticA.Public); err != nil {
		t.Fatal(err)
	}
	if fsmB.State(idA) != HSIdle {
		t.Error("非发起方 StartOutbound 应保持 idle")
	}
}

// TestHandshakeFSMInitialSelectionUses小ID 验证双方同时 StartOutbound 时小 ID 胜出。
func TestHandshakeFSMSimultaneousStart(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngA, rngB := deterministicReader(1), deterministicReader(2)
	staticA, _ := cs.GenerateKeypair(&rngA)
	staticB, _ := cs.GenerateKeypair(&rngB)
	idA, idB := nodeID(1), nodeID(2)

	var fsmA, fsmB *HandshakeFSM
	fsmA = NewHandshakeFSM(idA, network, psk, staticA)
	fsmA.SetSendFn(func(dst NodeID, frame []byte) error { _, err := fsmB.OnFrame(frame); return err })
	fsmB = NewHandshakeFSM(idB, network, psk, staticB)
	fsmB.SetSendFn(func(dst NodeID, frame []byte) error { _, err := fsmA.OnFrame(frame); return err })

	// 双方同时发起：B（大）应忽略，A（小）发起
	_ = fsmB.StartOutbound(idA, staticA.Public) // B 非发起方 → 无动作
	_ = fsmA.StartOutbound(idB, staticB.Public) // A 发起方 → 发 msg1

	if _, ok := fsmA.Session(idB); !ok {
		t.Error("A 应建立会话")
	}
	if _, ok := fsmB.Session(idA); !ok {
		t.Error("B 应建立会话")
	}
}
