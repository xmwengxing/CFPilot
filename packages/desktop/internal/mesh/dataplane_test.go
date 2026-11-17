package mesh

import (
	"bytes"
	"encoding/binary"
	"net"
	"testing"
)

func v4Packet(src, dst [4]byte) []byte {
	p := make([]byte, 40)
	p[0] = 0x45
	binary.BigEndian.PutUint16(p[2:4], 40)
	copy(p[12:16], src[:])
	copy(p[16:20], dst[:])
	return p
}

func TestParseIPAddresses(t *testing.T) {
	p := v4Packet([4]byte{10, 0, 0, 1}, [4]byte{10, 0, 0, 2})
	dst, err := ParseDstAddr(p)
	if err != nil || !dst.Equal(net.IPv4(10, 0, 0, 2)) {
		t.Errorf("IPv4 dst = %v, err=%v", dst, err)
	}
	src, err := ParseSrcAddr(p)
	if err != nil || !src.Equal(net.IPv4(10, 0, 0, 1)) {
		t.Errorf("IPv4 src = %v, err=%v", src, err)
	}

	// IPv6
	v6 := make([]byte, 60)
	v6[0] = 0x60
	copy(v6[8:24], net.ParseIP("2001:db8::1").To16())
	copy(v6[24:40], net.ParseIP("2001:db8::2").To16())
	dst6, err := ParseDstAddr(v6)
	if err != nil || !dst6.Equal(net.ParseIP("2001:db8::2")) {
		t.Errorf("IPv6 dst = %v, err=%v", dst6, err)
	}

	// 垃圾/截断
	for _, bad := range [][]byte{nil, {}, {0x00}, {0x45, 0, 0, 100}} {
		if _, err := ParseDstAddr(bad); err == nil {
			t.Errorf("垃圾包应拒绝: %v", bad)
		}
	}
}

func TestVirtualIPTable(t *testing.T) {
	selfID := nodeID(1)
	tbl := NewVirtualIPTable(selfID, net.IPv4(10, 0, 0, 1))
	target := nodeID(2)
	tbl.Add(net.IPv4(10, 0, 0, 2), target)

	id, bc, ok := tbl.Lookup(net.IPv4(10, 0, 0, 2))
	if !ok || bc || id != target {
		t.Errorf("查表 = %v/%v/%v", id, bc, ok)
	}
	_, bc, ok = tbl.Lookup(net.IPv4bcast)
	if !ok || !bc {
		t.Error("广播应识别")
	}
	_, _, ok = tbl.Lookup(net.IPv4(10, 0, 0, 99))
	if ok {
		t.Error("未知 IP 不应命中")
	}
	tbl.Remove(net.IPv4(10, 0, 0, 2))
	_, _, ok = tbl.Lookup(net.IPv4(10, 0, 0, 2))
	if ok {
		t.Error("删除后不应命中")
	}
}

func testSessionPair(t *testing.T) (*Session, *Session) {
	t.Helper()
	initSend, respRecv := testNoisePair(t)
	wire, initSess, err := InitiatorKeyMaterial(initSend)
	if err != nil {
		t.Fatal(err)
	}
	respSess, err := ResponderFromKeyMaterial(respRecv, wire)
	if err != nil {
		t.Fatal(err)
	}
	return initSess, respSess
}

func TestEncapsulateDecapsulateRoundTrip(t *testing.T) {
	initSess, respSess := testSessionPair(t)
	srcID, dstID := nodeID(1), nodeID(2)
	packet := v4Packet([4]byte{10, 0, 0, 1}, [4]byte{10, 0, 0, 2})

	frameBytes, err := Encapsulate(packet, srcID, dstID, initSess)
	if err != nil {
		t.Fatal(err)
	}
	// 帧应 ≤ 1432
	if len(frameBytes) > MaxFrame {
		t.Errorf("帧长 %d > %d", len(frameBytes), MaxFrame)
	}
	// 目标节点解封
	got, err := Decapsulate(frameBytes, dstID, respSess)
	if err != nil {
		t.Fatalf("解封失败: %v", err)
	}
	if !bytes.Equal(got, packet) {
		t.Errorf("IP 包往返不符: % x vs % x", got, packet)
	}

	// 非目标节点应拒绝
	if _, err := Decapsulate(frameBytes, nodeID(3), respSess); err == nil {
		t.Error("非目标节点应拒绝")
	}
	// 重放应拒绝
	if _, err := Decapsulate(frameBytes, dstID, respSess); err == nil {
		t.Error("重放帧应拒绝")
	}
}

func TestEncapsulateMultipleCounters(t *testing.T) {
	initSess, respSess := testSessionPair(t)
	srcID, dstID := nodeID(1), nodeID(2)
	for i := 0; i < 5; i++ {
		packet := v4Packet([4]byte{10, 0, 0, byte(i + 1)}, [4]byte{10, 0, 0, 2})
		frameBytes, err := Encapsulate(packet, srcID, dstID, initSess)
		if err != nil {
			t.Fatal(err)
		}
		got, err := Decapsulate(frameBytes, dstID, respSess)
		if err != nil {
			t.Fatalf("第 %d 帧解封失败: %v", i, err)
		}
		if !bytes.Equal(got, packet) {
			t.Errorf("第 %d 帧内容不符", i)
		}
	}
	if initSess.SendCounter() != 5 {
		t.Errorf("sendCounter = %d, 期望 5", initSess.SendCounter())
	}
	if respSess.ReplayHighest() != 4 {
		t.Errorf("replay highest = %d, 期望 4", respSess.ReplayHighest())
	}
}

func TestBroadcastFrame(t *testing.T) {
	f, err := BroadcastFrame([]byte("hello"), nodeID(1), DefaultTTL)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Dst != (NodeID{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}) {
		t.Error("广播目标应为全 FF")
	}
	if decoded.Type != MsgData || decoded.TTL != DefaultTTL {
		t.Error("广播帧字段不符")
	}
}
