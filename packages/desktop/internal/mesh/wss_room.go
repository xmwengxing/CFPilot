//go:build mesh

package mesh

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
)

type wsFrameConn interface {
	SendFrame(context.Context, []byte) error
	RecvFrame(context.Context) ([]byte, error)
	Close() error
}

// WssRoom shares one edge-relay WebSocket among logical peer links.
// The relay routes each frame by its header; this side demultiplexes by Src.
type WssRoom struct {
	conn      wsFrameConn
	self      NodeID
	mu        sync.Mutex
	links     map[NodeID]*WssRoomPeer
	announced map[NodeID]struct{}
	onPeer    func(NodeID, PeerLink)
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	started   bool
	start     sync.Once
	close     sync.Once
}

func NewWssRoom(conn wsFrameConn, self NodeID) *WssRoom {
	return &WssRoom{
		conn:      conn,
		self:      self,
		links:     make(map[NodeID]*WssRoomPeer),
		announced: make(map[NodeID]struct{}),
		done:      make(chan struct{}),
	}
}

// SetPeerHandler is called when a valid frame first arrives from a peer.
func (r *WssRoom) SetPeerHandler(handler func(NodeID, PeerLink)) {
	r.mu.Lock()
	r.onPeer = handler
	var existing []struct {
		id   NodeID
		link PeerLink
	}
	if handler != nil {
		for id, link := range r.links {
			if id == r.self {
				continue
			}
			if _, ok := r.announced[id]; ok {
				continue
			}
			r.announced[id] = struct{}{}
			existing = append(existing, struct {
				id   NodeID
				link PeerLink
			}{id, link})
		}
	}
	r.mu.Unlock()
	for _, peer := range existing {
		go handler(peer.id, peer.link)
	}
}

// Start begins the single reader which routes frames into per-peer queues.
func (r *WssRoom) Start(ctx context.Context) {
	r.start.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		r.ctx, r.cancel = context.WithCancel(ctx)
		r.mu.Lock()
		r.started = true
		r.mu.Unlock()
		go r.readLoop()
	})
}

func (r *WssRoom) Link(peer NodeID) *WssRoomPeer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.linkLocked(peer)
}

func (r *WssRoom) PeerLinkFor(peer NodeID) PeerLink { return r.Link(peer) }

func (r *WssRoom) connected() bool {
	select {
	case <-r.done:
		return false
	default:
		return true
	}
}

func (r *WssRoom) linkLocked(peer NodeID) *WssRoomPeer {
	if link := r.links[peer]; link != nil {
		return link
	}
	link := &WssRoomPeer{room: r, peer: peer, incoming: make(chan []byte, 256)}
	r.links[peer] = link
	return link
}

func (r *WssRoom) readLoop() {
	defer close(r.done)
	for {
		frame, err := r.conn.RecvFrame(r.ctx)
		if err != nil {
			return
		}
		parsed, err := Decode(frame)
		if err != nil || parsed.Src == r.self || (parsed.Dst != r.self && !isBroadcastID(parsed.Dst)) {
			continue
		}

		r.mu.Lock()
		link := r.linkLocked(parsed.Src)
		handler := r.onPeer
		_, announced := r.announced[parsed.Src]
		notify := handler != nil && !announced
		if notify {
			r.announced[parsed.Src] = struct{}{}
		}
		r.mu.Unlock()

		select {
		case link.incoming <- append([]byte(nil), frame...):
		case <-r.ctx.Done():
			return
		default:
			// An inactive logical peer (for example after UDP promotion) must not
			// stall the one shared room reader when its bounded queue fills.
		}
		if notify {
			go handler(parsed.Src, link)
		}
	}
}

func isBroadcastID(id NodeID) bool {
	for _, b := range id {
		if b != 0xff {
			return false
		}
	}
	return true
}

func (r *WssRoom) Close() error {
	r.close.Do(func() {
		if r.cancel != nil {
			r.cancel()
		}
		_ = r.conn.Close()
	})
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	if started {
		<-r.done
	}
	return nil
}

// WssRoomPeer is a per-peer view over a shared WSS room connection.
type WssRoomPeer struct {
	baseLink
	room     *WssRoom
	peer     NodeID
	incoming chan []byte
}

func (l *WssRoomPeer) Send(ctx context.Context, frame []byte) error {
	return l.room.conn.SendFrame(ctx, frame)
}

func (l *WssRoomPeer) SendProbe(ctx context.Context, frame []byte) error {
	return l.Send(ctx, frame)
}

func (l *WssRoomPeer) Recv(ctx context.Context) ([]byte, error) {
	select {
	case frame, ok := <-l.incoming:
		if !ok {
			return nil, errors.New("mesh wss room: peer link closed")
		}
		return frame, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-l.room.done:
		return nil, io.EOF
	}
}

func (l *WssRoomPeer) PeerAddr() *net.UDPAddr { return nil }
func (l *WssRoomPeer) IsRelayed() bool        { return true }
func (l *WssRoomPeer) Close() error           { return nil }
