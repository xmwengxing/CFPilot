//go:build mesh

package mesh

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"
)

type memoryWsConn struct {
	mu     sync.Mutex
	in     chan []byte
	sent   [][]byte
	closed chan struct{}
}

func newMemoryWsConn() *memoryWsConn {
	return &memoryWsConn{in: make(chan []byte, 8), closed: make(chan struct{})}
}

func (c *memoryWsConn) SendFrame(_ context.Context, frame []byte) error {
	c.mu.Lock()
	c.sent = append(c.sent, append([]byte(nil), frame...))
	c.mu.Unlock()
	return nil
}

func (c *memoryWsConn) RecvFrame(ctx context.Context) ([]byte, error) {
	select {
	case frame := <-c.in:
		return frame, nil
	case <-c.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *memoryWsConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}

func TestWssRoomMultiplexesByFrameSource(t *testing.T) {
	self, peerA, peerB := nodeID(1), nodeID(2), nodeID(3)
	conn := newMemoryWsConn()
	room := NewWssRoom(conn, self)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	room.Start(ctx)

	frameA, _ := (&Frame{Version: WireVersionDefault, Type: MsgHandshake, TTL: DefaultTTL, Src: peerA, Dst: self, Payload: []byte("a")}).Encode()
	frameB, _ := (&Frame{Version: WireVersionDefault, Type: MsgHandshake, TTL: DefaultTTL, Src: peerB, Dst: self, Payload: []byte("b")}).Encode()
	conn.in <- frameA
	conn.in <- frameB

	linkA, linkB := room.Link(peerA), room.Link(peerB)
	gotA, err := linkA.Recv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gotB, err := linkB.Recv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	parsedA, _ := Decode(gotA)
	parsedB, _ := Decode(gotB)
	if parsedA.Src != peerA || parsedB.Src != peerB {
		t.Fatalf("frames misrouted: A=%x B=%x", parsedA.Src, parsedB.Src)
	}
	if linkA == linkB || !linkA.IsRelayed() || !linkB.IsRelayed() {
		t.Fatal("logical peer links must be distinct and marked relayed")
	}
	if err := linkA.Send(ctx, frameA); err != nil {
		t.Fatal(err)
	}
	if err := linkB.Send(ctx, frameB); err != nil {
		t.Fatal(err)
	}
	conn.mu.Lock()
	sent := len(conn.sent)
	conn.mu.Unlock()
	if sent != 2 {
		t.Fatalf("both logical links should share the same sender; sent=%d", sent)
	}
	_ = room.Close()
}

func TestWssRoomPeerHandlerNotifiesOnceOutsideRoomLock(t *testing.T) {
	self, peer := nodeID(1), nodeID(2)
	conn := newMemoryWsConn()
	room := NewWssRoom(conn, self)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	notified := make(chan struct{}, 2)
	room.SetPeerHandler(func(id NodeID, link PeerLink) {
		if id != peer || link != room.Link(peer) {
			t.Errorf("handler received wrong peer link")
		}
		notified <- struct{}{}
	})
	room.Start(ctx)
	frame, _ := (&Frame{Version: WireVersionDefault, Type: MsgHandshake, TTL: DefaultTTL, Src: peer, Dst: self}).Encode()
	conn.in <- frame
	conn.in <- frame
	_, _ = room.Link(peer).Recv(ctx)
	_, _ = room.Link(peer).Recv(ctx)
	select {
	case <-notified:
	case <-time.After(time.Second):
		t.Fatal("peer handler did not run")
	}
	select {
	case <-notified:
		t.Fatal("peer handler ran more than once")
	case <-time.After(30 * time.Millisecond):
	}
	_ = room.Close()
}

func TestWssRoomPeerHandlerNotifiesPeersSeenBeforeHandlerRegistration(t *testing.T) {
	self, peer := nodeID(1), nodeID(2)
	conn := newMemoryWsConn()
	room := NewWssRoom(conn, self)
	link := room.Link(peer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	room.Start(ctx)

	frame, _ := (&Frame{Version: WireVersionDefault, Type: MsgHandshake, TTL: DefaultTTL, Src: peer, Dst: self}).Encode()
	conn.in <- frame
	if _, err := link.Recv(ctx); err != nil {
		t.Fatal(err)
	}

	notified := make(chan struct{}, 1)
	room.SetPeerHandler(func(id NodeID, got PeerLink) {
		if id != peer || got != link {
			t.Errorf("handler received wrong peer link")
		}
		notified <- struct{}{}
	})
	select {
	case <-notified:
	case <-time.After(time.Second):
		t.Fatal("handler was not called for an existing peer")
	}
	_ = room.Close()
}

func TestWssRoomHandlerRegistrationDoesNotReannouncePeer(t *testing.T) {
	self, peer := nodeID(1), nodeID(2)
	conn := newMemoryWsConn()
	room := NewWssRoom(conn, self)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	room.Start(ctx)

	first := make(chan struct{}, 1)
	room.SetPeerHandler(func(NodeID, PeerLink) { first <- struct{}{} })
	frame, _ := (&Frame{Version: WireVersionDefault, Type: MsgHandshake, TTL: DefaultTTL, Src: peer, Dst: self}).Encode()
	conn.in <- frame
	link := room.Link(peer)
	if _, err := link.Recv(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first:
	case <-time.After(time.Second):
		t.Fatal("initial peer notification was not received")
	}

	second := make(chan struct{}, 1)
	room.SetPeerHandler(func(NodeID, PeerLink) { second <- struct{}{} })
	select {
	case <-second:
		t.Fatal("handler replacement should not announce the same peer again")
	case <-time.After(30 * time.Millisecond):
	}
	_ = room.Close()
}

func TestWssRoomCloseUnblocksPeerReceive(t *testing.T) {
	conn := newMemoryWsConn()
	room := NewWssRoom(conn, nodeID(1))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	room.Start(ctx)
	link := room.Link(nodeID(2))
	result := make(chan error, 1)
	go func() { _, err := link.Recv(ctx); result <- err }()
	if err := room.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("receive should fail after room closes")
		}
	case <-time.After(time.Second):
		t.Fatal("receive remained blocked after room close")
	}
}
