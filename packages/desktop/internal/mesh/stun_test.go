package mesh

import (
	"context"
	"encoding/binary"
	"net"
	"strings"
	"testing"
	"time"
)

// 假 STUN 服务器：回一条 XOR-MAPPED-ADDRESS，内容就是客户端实际源地址。
func startFakeStun(t *testing.T) (*net.UDPConn, string) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			n, client, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if n < stunHeaderLen || !looksLikeSTUN(buf[:n]) {
				continue
			}
			resp := makeResponse(buf[8:20], client)
			_, _ = conn.WriteToUDP(resp, client)
		}
	}()
	return conn, conn.LocalAddr().String()
}

func makeResponse(txid []byte, client *net.UDPAddr) []byte {
	attr := make([]byte, 12) // 头部 4 + 值 8（IPv4 值 7 字节，按 4 对齐补 1）
	binary.BigEndian.PutUint16(attr[0:2], stunAttrXorMapped)
	binary.BigEndian.PutUint16(attr[2:4], 8)
	// RFC 5389 §15.2：值 = 保留(1) | family(1) | port(2，已异或) | addr(4，已异或)
	attr[4] = 0x00
	attr[5] = stunFamilyIPv4
	port := client.Port ^ int(stunMagicCookie>>16)
	binary.BigEndian.PutUint16(attr[6:8], uint16(port))
	cookie := [4]byte{}
	binary.BigEndian.PutUint32(cookie[:], stunMagicCookie)
	ip := client.IP.To4()
	for i := 0; i < 4; i++ {
		attr[8+i] = ip[i] ^ cookie[i]
	}
	hdr := make([]byte, stunHeaderLen)
	binary.BigEndian.PutUint16(hdr[0:2], stunBindingResponse)
	binary.BigEndian.PutUint16(hdr[2:4], uint16(len(attr)))
	binary.BigEndian.PutUint32(hdr[4:8], stunMagicCookie)
	copy(hdr[8:20], txid)
	return append(hdr, attr...)
}

func TestDiscoverNatReportsReflexive(t *testing.T) {
	srv, addr := startFakeStun(t)
	defer srv.Close()

	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// 被测机与假服务器都在本机 ⇒ 映射一致，按保守判据应判 NAT3。
	a := DiscoverNat(ctx, hub, []string{addr}, 500*time.Millisecond)
	if a.Type != "NAT3" {
		t.Fatalf("Type = %q, 期望 NAT3（映射一致、保守锥形）", a.Type)
	}
	if a.Reflexive == "" {
		t.Fatal("应记录反射地址")
	}
	// 反射地址的端口应当就是 hub 自己的端口（假服务器看到的是真实源端口）
	if !strings.HasPrefix(a.Reflexive, "127.0.0.1:") {
		t.Errorf("Reflexive = %q", a.Reflexive)
	}
	if want := hub.LocalAddr().String(); a.Reflexive != want {
		t.Errorf("Reflexive = %q, 期望 %q", a.Reflexive, want)
	}
}

func TestDiscoverNatNoResponseUnknown(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// 指向一个不会应答的本地端口
	a := DiscoverNat(ctx, hub, []string{"127.0.0.1:9"}, 200*time.Millisecond)
	if a.Type != "Unknown" {
		t.Errorf("无应答应为 Unknown，实际 %q", a.Type)
	}
}

func TestDiscoverNatStopsAfterContextCancellation(t *testing.T) {
	sink, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan NatAssessment, 1)
	go func() { result <- DiscoverNat(ctx, hub, []string{sink.LocalAddr().String()}, time.Minute) }()
	_ = sink.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := sink.ReadFromUDP(make([]byte, stunHeaderLen)); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case assessment := <-result:
		if assessment.Type != "Unknown" {
			t.Fatalf("未收到响应，NAT 类型应为 Unknown，实际 %q", assessment.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("取消后仍在等待 STUN 响应")
	}
}

func TestClassifyMappings(t *testing.T) {
	// 映射一致 → NAT3（保守）
	m1 := []StunMapping{{IP: "203.0.113.5", Port: 5000, Address: "203.0.113.5:5000"},
		{IP: "203.0.113.5", Port: 5000, Address: "203.0.113.5:5000"}}
	if got := classifyMappings(m1, 4); got.Type != "NAT3" || got.Reflexive != "203.0.113.5:5000" {
		t.Errorf("一致映射应 NAT3 + 反射地址: %+v", got)
	}
	// 同 IP 不同端口 → NAT4
	m2 := []StunMapping{{IP: "203.0.113.5", Port: 5000, Address: "203.0.113.5:5000"},
		{IP: "203.0.113.5", Port: 5001, Address: "203.0.113.5:5001"}}
	if got := classifyMappings(m2, 4); got.Type != "NAT4" || got.Reflexive != "" || got.punchReflexive != m2[0].Address {
		t.Errorf("同 IP 不同端口应 NAT4: %+v", got)
	}
	// 不同 IP → NAT4
	m3 := []StunMapping{{IP: "203.0.113.5", Port: 5000, Address: "203.0.113.5:5000"},
		{IP: "198.51.100.7", Port: 5000, Address: "198.51.100.7:5000"}}
	if got := classifyMappings(m3, 4); got.Type != "NAT4" || got.punchReflexive != "" {
		t.Errorf("不同公网 IP 应 NAT4: %+v", got)
	}
	if got := classifyMappings(nil, 4); got.Type != "Unknown" {
		t.Errorf("无观测应 Unknown: %+v", got)
	}
}
