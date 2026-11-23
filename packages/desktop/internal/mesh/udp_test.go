package mesh

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"
)

func TestUdpHubDemux(t *testing.T) {
	var mu sync.Mutex
	var discovered []NodeID
	hub, err := NewUdpHub("127.0.0.1:0", func(id NodeID, addr *net.UDPAddr) {
		mu.Lock()
		discovered = append(discovered, id)
		mu.Unlock()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	// 两个模拟 peer 各发一帧
	peerA, _ := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	connA, _ := net.DialUDP("udp", peerA, hub.LocalAddr())
	defer connA.Close()
	peerB, _ := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	connB, _ := net.DialUDP("udp", peerB, hub.LocalAddr())
	defer connB.Close()

	frameA := &Frame{Type: MsgPing, TTL: DefaultTTL, Src: nodeID(1), Dst: nodeID(9)}
	frameB := &Frame{Type: MsgPing, TTL: DefaultTTL, Src: nodeID(2), Dst: nodeID(9)}
	ba, _ := frameA.Encode()
	bb, _ := frameB.Encode()
	connA.Write(ba)
	connB.Write(bb)

	// 等 demux 处理两个首包（触发 onIncoming 并建链路）
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(discovered)
		mu.Unlock()
		if n >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	if len(discovered) < 2 {
		t.Errorf("应发现 2 个 peer，实际 %d", len(discovered))
	}
	mu.Unlock()
	// 每个 peer 的链路应只收到自己的帧（LinkTo 返回 demux 已建的链路）
	la := hub.LinkTo(connA.LocalAddr().(*net.UDPAddr))
	lb := hub.LinkTo(connB.LocalAddr().(*net.UDPAddr))
	gotA, err := la.Recv(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	gotB, err := lb.Recv(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	da, _ := Decode(gotA)
	db, _ := Decode(gotB)
	if da.Src != nodeID(1) || db.Src != nodeID(2) {
		t.Errorf("分解错误: A.src=%x B.src=%x", da.Src, db.Src)
	}
}

func TestUdpHubSendProbeTo(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	// 起一个接收端
	listener, _ := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	defer listener.Close()
	frame := &Frame{Type: MsgUdpProbe, TTL: DefaultTTL, Src: nodeID(1), Dst: nodeID(2)}
	bf, _ := frame.Encode()
	if err := hub.SendProbeTo(context.Background(), listener.LocalAddr().(*net.UDPAddr), bf); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, MaxFrame)
	listener.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := listener.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := Decode(buf[:n])
	if got.Type != MsgUdpProbe {
		t.Errorf("探测帧类型 = %#x", got.Type)
	}
}

func TestUdpHubPunchConsumedByObserver(t *testing.T) {
	discovered := make(chan NodeID, 2)
	hub, err := NewUdpHub("127.0.0.1:0", func(peer NodeID, _ *net.UDPAddr) {
		discovered <- peer
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	observed := 0
	hub.SetControlHandler(func(_ *net.UDPAddr, _ []byte) { observed++ })
	sender, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	for _, frame := range []Frame{
		{Type: MsgHolePunch, TTL: DefaultTTL, Src: nodeID(1), Dst: nodeID(9)},
		{Type: MsgPing, TTL: DefaultTTL, Src: nodeID(2), Dst: nodeID(9)},
	} {
		wire, err := frame.Encode()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := sender.WriteToUDP(wire, hub.LocalAddr()); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case got := <-discovered:
		if got != nodeID(2) || observed != 1 {
			t.Fatalf("发现节点=%x，探针回调次数=%d", got, observed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("普通 UDP 帧未创建链路")
	}
}

func TestUdpHubForget(t *testing.T) {
	hub, err := NewUdpHub("127.0.0.1:0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	addr, _ := net.ResolveUDPAddr("udp", "127.0.0.1:12345")
	l1 := hub.LinkTo(addr)
	l2 := hub.LinkTo(addr)
	if l1 != l2 {
		t.Error("同地址应返回同一链路")
	}
	hub.Forget(addr)
	l3 := hub.LinkTo(addr)
	if l3 == l1 {
		t.Error("Forget 后应创建新链路")
	}
}
