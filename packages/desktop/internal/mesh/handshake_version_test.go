package mesh

import (
	"testing"
	"time"

	"github.com/flynn/noise"
)

// ADR-0016 握手降级兜底：发 Init 后 5s 仍从未收到该对端任何帧 →
// 用**同一份** Init 载荷以 v1 重发，并把该对端置 v1。
//
// 没有这条兜底，v1 对端会永远解不开 v2 Init（它的头部版本校验直接丢帧）。
func TestHandshakeDowngradeRetry(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rng := deterministicReader(7)
	staticA, _ := cs.GenerateKeypair(&rng)
	staticB, _ := cs.GenerateKeypair(&rng)

	idA, idB := nodeID(1), nodeID(2) // A 小 → 发起方
	now := time.Unix(0, 0)
	var sent [][]byte
	fsmA := NewHandshakeFSM(idA, network, psk, staticA)
	fsmA.SetClock(func() time.Time { return now })
	fsmA.SetSendFn(func(dst NodeID, frame []byte) error {
		sent = append(sent, append([]byte(nil), frame...))
		return nil
	})

	fsmB := NewHandshakeFSM(idB, network, psk, staticB)

	if err := fsmA.StartOutbound(idB, staticB.Public); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Fatalf("首次应只发一帧，实际 %d", len(sent))
	}
	f, err := Decode(sent[0])
	if err != nil {
		t.Fatal(err)
	}
	if f.Version != WireVersionV2 {
		t.Errorf("未知对端首发应为 v2，实际 %#x", f.Version)
	}

	// 未到 5s：不应降级
	now = now.Add(3 * time.Second)
	if n := fsmA.RetryPending(now, 5*time.Second); n != 0 {
		t.Fatalf("3s 内不应重试降级，实际 %d", n)
	}

	// 到 5s：降级并重发同一份载荷
	now = now.Add(3 * time.Second)
	if n := fsmA.RetryPending(now, 5*time.Second); n != 1 {
		t.Fatalf("5s 后应降级重发 1 次，实际 %d", n)
	}
	if len(sent) != 2 {
		t.Fatalf("应共发 2 帧，实际 %d", len(sent))
	}
	retry, err := Decode(sent[1])
	if err != nil {
		t.Fatal(err)
	}
	if retry.Version != WireVersionV1 {
		t.Errorf("降级帧应为 v1，实际 %#x", retry.Version)
	}
	first, _ := Decode(sent[0])
	if string(first.Payload) != string(retry.Payload) {
		t.Error("降级必须重发**同一份** Init 载荷（重新生成 Noise msg1 会破坏握手状态）")
	}
	if got := fsmA.WireVersions().VersionFor(idB); got != WireVersionV1 {
		t.Errorf("降级后登记表应为 v1，实际 %#x", got)
	}

	// 之后仍需**周期性重发**（UDP 首个 Init 可能丢失；对端晚启动时必须能重连），
	// 但版本保持 v1，不重复降级。
	now = now.Add(5 * time.Second)
	if n := fsmA.RetryPending(now, 5*time.Second); n != 1 {
		t.Fatalf("5s 后应继续重发一次，实际 %d", n)
	}
	if len(sent) != 3 {
		t.Fatalf("应共发 3 帧，实际 %d", len(sent))
	}
	again, err := Decode(sent[2])
	if err != nil {
		t.Fatal(err)
	}
	if again.Version != WireVersionV1 {
		t.Errorf("已降级后应保持 v1，实际 %#x", again.Version)
	}
	if string(again.Payload) != string(retry.Payload) {
		t.Error("重发必须使用同一份 Init 载荷")
	}

	// 降级后若对端回帧被学到，登记表回到真实版本
	fsmA.WireVersions().Learn(idB, WireVersionV2)

	// 完整闭环：把 v1 Init 交给 B，B 回 msg2，A 完成握手并回 KeyMaterial，B 建会话。
	sent = nil
	fsmB.SetSendFn(func(dst NodeID, frame []byte) error {
		_, err := fsmA.OnFrame(frame)
		return err
	})
	fsmA.SetSendFn(func(dst NodeID, frame []byte) error {
		_, err := fsmB.OnFrame(frame)
		return err
	})
	if _, err := fsmB.OnFrame(sent2Bytes(t, first)); err != nil {
		t.Fatalf("B 处理 v1 Init 失败: %v", err)
	}
	if _, okA := fsmA.Session(idB); !okA {
		t.Fatalf("A 未建立会话（state=%s）", fsmA.State(idB))
	}
	if _, okB := fsmB.Session(idA); !okB {
		t.Fatalf("B 未建立会话（state=%s）", fsmB.State(idA))
	}
}

// 上面为构造「重发同一份 Init」的字节，需要把 payload 重新编码成帧
func sent2Bytes(t *testing.T, f *Frame) []byte {
	t.Helper()
	b, err := (&Frame{
		Version: WireVersionV1, Type: f.Type, Flags: f.Flags, TTL: f.TTL,
		Payload: f.Payload, Src: f.Src, Dst: f.Dst, Counter: f.Counter,
	}).Encode()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

