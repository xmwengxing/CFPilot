package mesh

import (
	"bytes"
	"sync"
	"testing"

	"github.com/flynn/noise"
	"github.com/zeebo/blake3"
)

// hsTestPair 建一对 FSM：A 小（发起方），B 大（响应方），返回两侧。
func hsTestPair(t *testing.T) (fsmA, fsmB *HandshakeFSM, idA, idB NodeID, staticB noise.DHKey) {
	t.Helper()
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngA, rngB := deterministicReader(1), deterministicReader(2)
	staticA, _ := cs.GenerateKeypair(&rngA)
	staticB, _ = cs.GenerateKeypair(&rngB)
	idA, idB = nodeID(1), nodeID(2)
	fsmA = NewHandshakeFSM(idA, network, psk, staticA)
	fsmB = NewHandshakeFSM(idB, network, psk, staticB)
	return
}

// TestEncodeHandshakeMsgLayout 锁死 MessagePack 字节布局（rmp-serde 形态）。
// 布局错了不会报错，只会让对端的 decode_msg::<HandshakeMsg> 失败 ——
// 症状是「握手帧到了但永远握不上」，只能靠逐字节断言防住。
func TestEncodeHandshakeMsgLayout(t *testing.T) {
	got := encodeHandshakeMsg(hsMessage{Kind: hsKindInit, Body: []byte{1, 2, 3}})
	want := []byte{
		0x81,                     // fixmap(1)
		0xa4, 'I', 'n', 'i', 't', // fixstr(4) "Init"
		0x81,                          // fixmap(1)
		0xa5, 'n', 'o', 'i', 's', 'e', // fixstr(5) "noise"
		0x93, 1, 2, 3, // fixarray(3) + positive fixint
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("Init 编码不符:\n got=%x\nwant=%x", got, want)
	}

	// 96 字节的 Noise 消息必须用 array16 头（**不是** bin8）：
	// serde 对 Vec<u8> 走 seq，rmp-serde 因此写数组而不是二进制串。
	long := make([]byte, 96)
	enc := encodeHandshakeMsg(hsMessage{Kind: hsKindReply, Body: long})
	// 前缀长度 = fixmap(1) + fixstr(1+len("Reply")) + fixmap(1) + fixstr(1+len("noise"))
	if enc[14] != 0xdc || enc[15] != 0x00 || enc[16] != 0x60 {
		t.Fatalf("长载荷的数组头不对: % x", enc[13:17])
	}

	// Reply2：key_confirm 是定长 32 字节数组（array16, len=32）。
	var confirm [32]byte
	confirm[0] = 0xff
	enc = encodeHandshakeMsg(hsMessage{Kind: hsKindReply2, Confirm: confirm})
	if enc[21] != 0xdc || enc[22] != 0x00 || enc[23] != 0x20 {
		t.Fatalf("key_confirm 数组头不对: % x", enc[20:24])
	}
	if enc[24] != 0xcc || enc[25] != 0xff {
		t.Fatalf("大于 0x7f 的字节必须是 uint8 编码: % x", enc[24:26])
	}
}

func TestDecodeHandshakeMsgRoundTrip(t *testing.T) {
	body := bytes.Repeat([]byte{0x00, 0x7f, 0x80, 0xff}, 40)
	cases := []hsMessage{
		{Kind: hsKindInit, Body: body},
		{Kind: hsKindReply, Body: body[:64]},
		{Kind: hsKindKeyMaterial, Body: body[:36]},
		{Kind: hsKindReply2, Confirm: KeyConfirmation([32]byte{7})},
	}
	for _, in := range cases {
		out, ok := decodeHandshakeMsg(encodeHandshakeMsg(in))
		if !ok {
			t.Fatalf("%s 解码失败", in.Kind)
		}
		if out.Kind != in.Kind {
			t.Fatalf("变体不符: %q != %q", out.Kind, in.Kind)
		}
		if in.Kind == hsKindReply2 {
			if out.Confirm != in.Confirm {
				t.Fatalf("key_confirm 不符")
			}
			continue
		}
		if !bytes.Equal(out.Body, in.Body) {
			t.Fatalf("%s 载荷不符", in.Kind)
		}
	}
}

// TestDecodeHandshakeMsgTolerance 覆盖两种必须接受的形态与四种必须拒绝的垃圾。
func TestDecodeHandshakeMsgTolerance(t *testing.T) {
	// msgpack 原生 bin8（对将来的 serde_bytes 留余地）。
	bin := []byte{0x81, 0xa4, 'I', 'n', 'i', 't', 0x81, 0xa5, 'n', 'o', 'i', 's', 'e', 0xc4, 0x03, 1, 2, 3}
	if m, ok := decodeHandshakeMsg(bin); !ok || !bytes.Equal(m.Body, []byte{1, 2, 3}) {
		t.Fatalf("bin8 形态应被接受: ok=%v m=%+v", ok, m)
	}

	bad := map[string][]byte{
		"空载荷":              nil,
		"裸 Noise":          bytes.Repeat([]byte{0x35}, 96),
		"未知变体":             append([]byte{0x81, 0xa9}, append([]byte("Handshake"), 0x81, 0xa5, 'n', 'o', 'i', 's', 'e', 0x91, 1)...),
		"尾部多余字节":           append(encodeHandshakeMsg(hsMessage{Kind: hsKindInit, Body: []byte{1}}), 0x00),
		"字段名不符":            {0x81, 0xa4, 'I', 'n', 'i', 't', 0x81, 0xa4, 'w', 'i', 'r', 'e', 0x91, 1},
		"key_confirm 非 32": {0x81, 0xa6, 'R', 'e', 'p', 'l', 'y', '2', 0x81, 0xab, 'k', 'e', 'y', '_', 'c', 'o', 'n', 'f', 'i', 'r', 'm', 0x92, 1, 2},
	}
	for name, payload := range bad {
		if _, ok := decodeHandshakeMsg(payload); ok {
			t.Errorf("%s 不应被当成握手消息", name)
		}
	}
}

// TestHandshakeFSMReply2ConfirmsKey 验证三帧握手后紧跟一条密钥确认，
// 且响应方对同一 data_key 得到的标签一致（H2-2）。
func TestHandshakeFSMReply2ConfirmsKey(t *testing.T) {
	fsmA, fsmB, idA, idB, staticB := hsTestPair(t)

	var mu sync.Mutex
	var reply2 int
	fsmA.SetSendFn(func(dst NodeID, frame []byte) error {
		if parsed, err := Decode(frame); err == nil {
			if msg, ok := decodeHandshakeMsg(parsed.Payload); ok && msg.Kind == hsKindReply2 {
				mu.Lock()
				reply2++
				mu.Unlock()
			}
		}
		_, err := fsmB.OnFrame(frame)
		return err
	})
	fsmB.SetSendFn(func(dst NodeID, frame []byte) error {
		_, err := fsmA.OnFrame(frame)
		return err
	})

	if err := fsmA.StartOutbound(idB, staticB.Public); err != nil {
		t.Fatal(err)
	}
	if _, ok := fsmB.Session(idA); !ok {
		t.Fatal("B 应建立会话")
	}
	mu.Lock()
	got := reply2
	mu.Unlock()
	if got != 1 {
		t.Fatalf("发起方应发 1 条 Reply2，实际 %d", got)
	}
	ok, bad := fsmB.KeyConfirmCounters()
	if ok != 1 || bad != 0 {
		t.Fatalf("密钥确认计数应为 (1,0)，实际 (%d,%d)", ok, bad)
	}
	if fsmB.framingFor(idA) != hsFramingMsgpack {
		t.Fatal("对端用 msgpack 握手后应锁定 msgpack")
	}
}

// TestHandshakeFSMReply2MismatchCounted 验证标签被篡改时只计数、不拆会话。
func TestHandshakeFSMReply2MismatchCounted(t *testing.T) {
	fsmA, fsmB, idA, idB, staticB := hsTestPair(t)

	fsmA.SetSendFn(func(dst NodeID, frame []byte) error {
		parsed, err := Decode(frame)
		if err != nil {
			return err
		}
		if msg, ok := decodeHandshakeMsg(parsed.Payload); ok && msg.Kind == hsKindReply2 {
			msg.Confirm[0] ^= 0xff // 模拟两端派生不一致
			parsed.Payload = encodeHandshakeMsg(msg)
			if frame, err = parsed.Encode(); err != nil {
				return err
			}
		}
		_, err = fsmB.OnFrame(frame)
		return err
	})
	fsmB.SetSendFn(func(dst NodeID, frame []byte) error {
		_, err := fsmA.OnFrame(frame)
		return err
	})

	if err := fsmA.StartOutbound(idB, staticB.Public); err != nil {
		t.Fatal(err)
	}
	if _, ok := fsmB.Session(idA); !ok {
		t.Fatal("标签不匹配不能拆掉已建立的会话")
	}
	ok, bad := fsmB.KeyConfirmCounters()
	if ok != 0 || bad != 1 {
		t.Fatalf("密钥确认计数应为 (0,1)，实际 (%d,%d)", ok, bad)
	}
}

// TestHandshakeFSMLegacyRawPeer 验证旧版（裸 Noise）对端仍能握手成功，
// 且回帧同样是裸 Noise —— 回 msgpack 会被它当成 Noise 字节读，握手直接坏掉。
func TestHandshakeFSMLegacyRawPeer(t *testing.T) {
	network := DeriveNetworkID("test-net")
	psk := DerivePSK("test-net", "secret")
	cs := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	rngA, rngB := deterministicReader(1), deterministicReader(2)
	staticA, _ := cs.GenerateKeypair(&rngA)
	staticB, _ := cs.GenerateKeypair(&rngB)
	idA, idB := nodeID(1), nodeID(2)

	init, err := NewInitiatorHandshake(psk, network[:], staticA, staticB)
	if err != nil {
		t.Fatal(err)
	}
	msg1, err := init.WriteMessage(nil)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := EncodeHandshakeFrame(idA, idB, msg1, WireVersionDefault)
	if err != nil {
		t.Fatal(err)
	}

	fsmB := NewHandshakeFSM(idB, network, psk, staticB)
	var reply []byte
	fsmB.SetSendFn(func(dst NodeID, f []byte) error {
		reply = f
		return nil
	})
	if _, err := fsmB.OnFrame(frame); err != nil {
		t.Fatal(err)
	}
	if fsmB.framingFor(idA) != hsFramingRaw {
		t.Fatal("收到裸 Noise 握手后应锁定 raw")
	}
	parsed, err := Decode(reply)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := decodeHandshakeMsg(parsed.Payload); ok {
		t.Fatal("旧版对端不该收到 msgpack 封装")
	}
	// 回帧必须能被旧版发起方继续读：完成握手并产出 KeyMaterial 会话。
	if _, err := init.ReadMessage(parsed.Payload); err != nil {
		t.Fatalf("旧版发起方读 msg2 失败: %v", err)
	}
	if _, sess, err := InitiatorKeyMaterial(init.SendState()); err != nil || sess == nil {
		t.Fatalf("旧版发起方无法继续: %v", err)
	}
}

func TestKeyConfirmationMatchesMobiHopFormula(t *testing.T) {
	var key [32]byte
	key[0] = 9
	h := blake3.New()
	_, _ = h.Write(key[:])
	_, _ = h.Write([]byte("mobihop/key-confirm/v2"))
	want := h.Sum(nil)
	got := KeyConfirmation(key)
	if !bytes.Equal(got[:], want) {
		t.Fatalf("标签公式不符: %x != %x", got[:], want)
	}
	if KeyConfirmation([32]byte{8}) == got {
		t.Fatal("不同密钥必须得到不同标签")
	}
}
